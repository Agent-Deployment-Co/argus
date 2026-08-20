// The MCP endpoint (POST /mcp, #299): lets AI agents on this machine, or an authorized container,
// query the Argus store for session search/detail/transcripts, usage, tools and health over
// streamable HTTP, so an agent can answer "what did I work on last week?" from the user's own work
// history. Every tool is read-only and reuses the exact readers `startServer` assembles for the web
// API, so MCP answers can never drift from what the dashboard shows.
//
// Transport shape: stateless streamable HTTP — a fresh `McpServer` + `StreamableHTTPTransport` per
// request, no session ids, no server-initiated messages (tools only), `enableJsonResponse` so POSTs
// come back as plain JSON (valid per the spec, and far easier to smoke-test than SSE). GET /mcp is
// rejected with 405 (spec-blessed for servers without a standalone notification stream). Local
// requests use the DNS-rebinding guard in serve.ts. Non-local requests need a bearer token, while no
// browser CSRF header is required because every tool is read-only.
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context } from "hono";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { resolveAgentAccess, resolveRetainText } from "../config.ts";
import { ALL_SOURCES } from "../reporting/dashboard-builder.ts";
import type { TranscriptSource } from "../types.ts";
import type {
  SessionDetailReader,
  SessionInteractionsReader,
  SessionListReader,
  SessionListQuery,
  SessionTaskMetricsReader,
  SnapshotFilters,
  ViewReaders,
} from "./serve.ts";

/** The readers the MCP tools run on — exactly the ones `startServer` wires into the web API. */
export interface McpDeps {
  views: ViewReaders;
  sessionList: SessionListReader;
  sessionDetail: SessionDetailReader;
  sessionInteractions: SessionInteractionsReader;
  sessionTaskMetrics: SessionTaskMetricsReader;
}

/** Per-request gates, resolved in `createMcpHandler`. */
export interface McpGate {
  includeTranscripts: boolean;
}

const MAX_SEARCH_LIMIT = 50;
const MAX_TRANSCRIPT_LIMIT = 50;

// searchSessions wraps matched spans in char(1)/char(2) sentinels for the web layer to highlight
// (see SessionSearchMatch); an agent wants clean text, so strip them like search-ops.ts does.
const SENTINEL_RE = /\x01|\x02/g;

const SOURCE_VALUES = ALL_SOURCES as [TranscriptSource, ...TranscriptSource[]];

/** The shared date/source/project filters, in every list-flavored tool's input. */
const FILTER_SHAPE = {
  since: z
    .string()
    .optional()
    .describe("Only include data on/after this local date, YYYY-MM-DD (inclusive)."),
  until: z
    .string()
    .optional()
    .describe("Only include data on/before this local date, YYYY-MM-DD (inclusive)."),
  source: z
    .enum(SOURCE_VALUES)
    .optional()
    .describe(
      'Only include sessions from this agent: "claude" (Claude Code), "cowork" (Claude Cowork), "claude-chat" (Claude Chat), "codex" (Codex), "gemini" (Gemini CLI). Omit for all.',
    ),
  project: z.string().optional().describe("Only include sessions whose project contains this text (case-insensitive)."),
};

/** Package a JSON payload the way agents read best: pretty text in `content` (every client shows
 *  it) plus the same object as `structuredContent` for clients that consume it natively. */
function jsonResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** A tool-level refusal: not a protocol error — the agent reads the message and can tell the user
 *  exactly what to turn on. */
function refusal(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

/** Keep the session search useful without allowing the transcript gate to be bypassed through
 *  the fields that the dashboard's shared readers use for display and highlighting. */
function redactSessionSearchRow(row: Awaited<ReturnType<SessionListReader>>["rows"][number], includeTranscripts: boolean) {
  if (includeTranscripts) {
    return row.match
      ? { ...row, match: { ...row.match, snippet: row.match.snippet.replace(SENTINEL_RE, "") } }
      : row;
  }
  const { firstPrompt: _firstPrompt, secretFindings: _secretFindings, match, ...withoutPrompt } = row;
  const safeMatch = match && match.sources[0] !== "conversation"
    ? { ...match, snippet: match.snippet.replace(SENTINEL_RE, "") }
    : undefined;
  return safeMatch ? { ...withoutPrompt, match: safeMatch } : withoutPrompt;
}

/** `SessionRow.firstPrompt` is the raw opening prompt, even though it is not part of the retained
 *  interaction-text table. Remove it from MCP detail responses while transcript access is off. */
function redactSessionDetail(session: Awaited<ReturnType<SessionDetailReader>>, includeTranscripts: boolean) {
  if (includeTranscripts || !session) return session;
  // firstPrompt is transcript text. Secret findings (#327) are redacted locators, but they are
  // derived from the transcript text the user chose not to share with agents, so they go too.
  const { firstPrompt: _firstPrompt, secretFindings: _secretFindings, ...withoutPrompt } = session;
  return withoutPrompt;
}

const SERVER_INSTRUCTIONS = `Argus indexes the user's local agent sessions (Claude Code, Claude Cowork, Claude Chat, Codex, Gemini CLI) into a local store. These tools answer questions about the user's own work history: what sessions happened, what they cost, which tools were used, and how sessions went. Everything is read-only.

Dates: since/until are local calendar dates as YYYY-MM-DD, inclusive on both ends. Compute relative ranges yourself from today's local date (e.g. "last week" = the last 7 local dates) and pass them explicitly.

Sources: filter with source = "claude" (Claude Code), "cowork" (Claude Cowork), "claude-chat" (Claude Chat), "codex" (Codex), or "gemini" (Gemini CLI); omit it to cover every agent.

Typical flow: search_sessions to find relevant sessions, then get_session for one session's detail, or get_session_transcript for its conversation (if the user has enabled transcript access). usage_summary / tool_usage / health_summary answer aggregate questions directly.`;

/** Build the Argus MCP server for one request: the six read-only tools over `deps`, with the
 *  transcript tool gated on `gate.includeTranscripts`. */
export function createArgusMcpServer(deps: McpDeps, gate: McpGate): McpServer {
  const server = new McpServer(
    { name: "argus", version: pkg.version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "search_sessions",
    {
      description:
        "Search the user's agent sessions. Full-text over titles, conversation text, and task text; filter by date range, agent, project, or a touched-file path. Returns matching sessions (newest first by default) with token/cost totals. Use a sessionId from the results with get_session for detail.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free-text search over session titles, conversation text, and task text."),
        file: z.string().optional().describe("Only sessions that touched a file path containing this text."),
        ...FILTER_SHAPE,
        sort: z
          .enum(["recent", "tokens", "cost"])
          .optional()
          .describe('Order by: "recent" (default), "tokens", or "cost".'),
        limit: z
          .number()
          .int()
          .optional()
          .describe(`Max sessions to return (default 20, capped at ${MAX_SEARCH_LIMIT}).`),
      },
    },
    async (args) => {
      const query: SessionListQuery = {
        since: args.since,
        until: args.until,
        source: args.source,
        project: args.project,
        q: args.query,
        file: args.file,
        includeGenerated: false,
        sort: args.sort ?? "recent",
        limit: Math.min(MAX_SEARCH_LIMIT, Math.max(1, args.limit ?? 20)),
        offset: 0,
      };
      const list = await deps.sessionList(query);
      const rows = list.rows.map((row) => redactSessionSearchRow(row, gate.includeTranscripts));
      return jsonResult({ sessions: rows, total: list.total });
    },
  );

  server.registerTool(
    "get_session",
    {
      description:
        "Full detail for one session: the model-generated title and summary, tasks with outcomes, token/cost totals, models, tools, files touched, and friction signals. Pass a sessionId from search_sessions.",
      inputSchema: {
        session_id: z.string().describe("The session id, from search_sessions."),
        include_task_metrics: z
          .boolean()
          .optional()
          .describe("Also include per-task metrics (tokens, cost, tool calls, interactions per task)."),
      },
    },
    async (args) => {
      const session = await deps.sessionDetail(args.session_id);
      if (!session) return refusal(`No session "${args.session_id}". Find session ids with search_sessions.`);
      const safeSession = redactSessionDetail(session, gate.includeTranscripts);
      if (!args.include_task_metrics) return jsonResult({ session: safeSession });
      const metrics = await deps.sessionTaskMetrics(args.session_id);
      return jsonResult({ session: safeSession, taskMetrics: metrics });
    },
  );

  const transcriptDescription = gate.includeTranscripts
    ? "The conversation of one session: each interaction's prompt and response text, with token and tool-call counts. Paginate with offset/limit. Pass a sessionId from search_sessions."
    : "The conversation of one session (prompt and response text). Currently OFF: the user hasn't allowed agents to read transcript text. Ask them to turn on “Let agents read session transcripts” under Settings → Agent access, then call this again.";
  server.registerTool(
    "get_session_transcript",
    {
      description: transcriptDescription,
      inputSchema: {
        session_id: z.string().describe("The session id, from search_sessions."),
        offset: z.number().int().optional().describe("Skip this many interactions (default 0)."),
        limit: z
          .number()
          .int()
          .optional()
          .describe(`Max interactions to return (default 25, capped at ${MAX_TRANSCRIPT_LIMIT}).`),
      },
    },
    async (args) => {
      if (!gate.includeTranscripts) {
        return refusal(
          "Transcript access is off. Ask the user to turn on “Let agents read session transcripts” under Settings → Agent access. (If it's already on, Argus also needs to be keeping session text, which is the retainText setting, on by default.)",
        );
      }
      const timeline = await deps.sessionInteractions(args.session_id);
      if (!timeline) return refusal(`No session "${args.session_id}". Find session ids with search_sessions.`);
      const offset = Math.max(0, args.offset ?? 0);
      const limit = Math.min(MAX_TRANSCRIPT_LIMIT, Math.max(1, args.limit ?? 25));
      return jsonResult({
        sessionId: args.session_id,
        interactions: timeline.interactions.slice(offset, offset + limit),
        total: timeline.interactions.length,
        offset,
        limit,
        tasks: timeline.tasks,
        retainedText: timeline.retainedText,
      });
    },
  );

  server.registerTool(
    "usage_summary",
    {
      description:
        "Token and cost totals for the user's agent usage, grouped by day, model, agent (source), or project. Answers “how much did I spend / use last week?” questions.",
      inputSchema: {
        group_by: z
          .enum(["day", "model", "source", "project"])
          .describe('Group totals by "day", "model", "source" (agent), or "project".'),
        ...FILTER_SHAPE,
      },
    },
    async (args) => {
      const filters: SnapshotFilters = {
        since: args.since,
        until: args.until,
        source: args.source,
        project: args.project,
      };
      switch (args.group_by) {
        case "day":
          return jsonResult({ groupBy: "day", ...(await deps.views.usageDaily(filters)) });
        case "model":
          return jsonResult({ groupBy: "model", ...(await deps.views.usageByModel(filters)) });
        case "source":
          return jsonResult({ groupBy: "source", ...(await deps.views.usageBySource(filters)) });
        case "project":
          return jsonResult({ groupBy: "project", ...(await deps.views.usageByProject(filters)) });
      }
    },
  );

  server.registerTool(
    "tool_usage",
    {
      description:
        "How the user's agents used tools: per-tool call counts, tool categories, MCP servers, or skills, with the context weight of tool results. Answers “which tools/MCP servers/skills do I lean on?” questions.",
      inputSchema: {
        group_by: z
          .enum(["tool", "category", "mcp_server", "skill"])
          .describe('Group by "tool", "category", "mcp_server", or "skill".'),
        ...FILTER_SHAPE,
      },
    },
    async (args) => {
      const filters: SnapshotFilters = {
        since: args.since,
        until: args.until,
        source: args.source,
        project: args.project,
      };
      switch (args.group_by) {
        case "tool":
          return jsonResult({ groupBy: "tool", ...(await deps.views.toolsByTool(filters)) });
        case "category":
          return jsonResult({ groupBy: "category", ...(await deps.views.toolsByCategory(filters)) });
        case "mcp_server":
          return jsonResult({ groupBy: "mcp_server", ...(await deps.views.toolsByMcpServer(filters)) });
        case "skill":
          return jsonResult({ groupBy: "skill", ...(await deps.views.skills(filters)) });
      }
    },
  );

  server.registerTool(
    "health_summary",
    {
      description:
        "Session-health signals (interruptions, permission rejections, compactions, slow turns) plus Argus's recommendations for working better with agents. Answers “where am I losing time / what should I change?” questions.",
      inputSchema: { ...FILTER_SHAPE },
    },
    async (args) => {
      const filters: SnapshotFilters = {
        since: args.since,
        until: args.until,
        source: args.source,
        project: args.project,
      };
      const [health, recommendations] = await Promise.all([
        deps.views.health(filters),
        deps.views.recommendations(filters),
      ]);
      return jsonResult({ ...health, ...recommendations });
    },
  );

  return server;
}

/** Build the `/mcp` route handler. Resolves the agent-access gates per request (so Settings toggles
 *  apply live, no restart), 404s the whole endpoint when access is off, and runs each request through
 *  a fresh stateless server + transport. */
export function createMcpHandler(deps: McpDeps): (c: Context) => Promise<Response> {
  return async (c) => {
    const access = resolveAgentAccess();
    if (!access.enabled) {
      return c.json({ error: "Agent access is off. Turn it on under Settings → Agent access." }, 404);
    }
    // The transcript tool needs both its own toggle and retained text to read from (#120): with
    // retention off there's no transcript text in the store at all.
    const includeTranscripts = access.includeTranscripts && resolveRetainText();
    // GET is the spec's optional standalone notification stream. This server never initiates
    // messages (tools only, stateless), so decline it outright instead of holding an SSE stream open.
    if (c.req.method === "GET") {
      return c.json({ error: "This server does not open notification streams. POST JSON-RPC requests instead." }, 405);
    }
    const server = createArgusMcpServer(deps, { includeTranscripts });
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined, // stateless: no session ids, no cross-request state
      enableJsonResponse: true, // answer POSTs with plain JSON rather than an SSE stream
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(c);
      return response ?? c.json({ error: "Unsupported request." }, 400);
    } finally {
      // With enableJsonResponse the response is fully built by the time handleRequest resolves, so
      // it's safe to tear down the per-request server/transport here.
      await server.close().catch(() => {});
    }
  };
}
