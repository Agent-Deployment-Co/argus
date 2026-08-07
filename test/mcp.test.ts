// Tests for the local MCP endpoint (#299): raw JSON-RPC POSTs against `createApp` with the real
// `createMcpHandler` over fake readers (the serve.test.ts pattern), plus the access gates.
import { afterEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createMcpHandler, type McpDeps } from "../src/api/mcp.ts";
import { createApp, type SessionListQuery, type SnapshotFilters } from "../src/api/serve.ts";
import type { SessionInteractionsResponse } from "../src/api/session-interactions.ts";
import type { SessionListItem } from "../src/api/session-list.ts";
import type { TaskMetrics } from "../src/api/task-metrics.ts";
import type { SessionRow } from "../src/types.ts";

const MCP_ENV = [
  "ARGUS_AGENT_ACCESS_ENABLED",
  "ARGUS_AGENT_ACCESS_INCLUDE_TRANSCRIPTS",
  "ARGUS_RETAIN_TEXT",
];

afterEach(() => {
  for (const key of MCP_ENV) delete process.env[key];
});

/** POST one JSON-RPC message to /mcp and return the status + parsed body. The handler runs with
 *  `enableJsonResponse`, so every request/response comes back as plain JSON. `app.request` doesn't
 *  derive a Host header from the URL, so set it explicitly (the route's DNS-rebinding guard reads it). */
async function rpc(
  app: Hono,
  method: string,
  params?: unknown,
  init?: { host?: string },
): Promise<{ status: number; body: any }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Host: init?.host ?? "localhost:4242",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function callTool(
  app: Hono,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return rpc(app, "tools/call", { name, arguments: args });
}

function listItem(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    sessionId: "s1",
    source: "claude",
    project: "web",
    firstPrompt: "hi",
    title: null,
    summary: null,
    start: 1,
    end: 2,
    userMessages: 1,
    agentMessages: 1,
    total: 10,
    cost: 0.01,
    interactions: 1,
    tasks: 0,
    ...overrides,
  };
}

function fixtureSession(sessionId: string): SessionRow {
  return {
    source: "codex",
    sessionId,
    project: "web",
    start: 1,
    end: 2,
    durationMs: 1,
    messages: 1,
    userMessages: null,
    agentMessages: null,
    rawTurns: null,
    models: ["gpt-5"],
    topSkills: [],
    toolCounts: {},
    filesTouched: [],
    total: 10,
    cost: 0,
    firstPrompt: "hi",
    summary: "",
    health: {
      interruptions: null,
      rejections: null,
      compactions: null,
      turns: null,
      medianTurnMs: null,
      maxTurnMs: null,
      stopReasons: null,
      tokenGrowth: null,
    },
    tasks: [],
    isHidden: false,
  };
}

function fixtureTimeline(interactions: number): SessionInteractionsResponse {
  return {
    interactions: Array.from({ length: interactions }, (_, i) => ({
      seq: i,
      taskSeq: null,
      initiator: "human" as const,
      disposition: "completed" as const,
      promptText: `prompt ${i}`,
      responseText: `response ${i}`,
      totalTokens: 10,
      toolCalls: 0,
      tools: [],
      models: ["gpt-5"],
    })),
    tasks: [{ seq: 0, description: "do the thing" }],
    retainedText: true,
  };
}

const fixtureMetrics: Record<string, TaskMetrics> = {
  t1: {
    messages: 2,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    totalTokens: 3,
    cost: 0.001,
    interactions: 1,
    toolCalls: 1,
    toolCounts: { Read: 1 },
    models: ["gpt-5"],
  },
};

/** Fake readers in the serve.test.ts style: every view returns a marker payload naming itself and
 *  echoes the filters it was called with, so tests assert routing + filter pass-through. */
function fakeDeps(overrides: Partial<McpDeps> = {}): McpDeps {
  const view = (name: string) => async (filters: SnapshotFilters) => ({ [name]: true, filters });
  return {
    views: {
      usageDaily: view("usageDaily"),
      usageByModel: view("usageByModel"),
      usageBySource: view("usageBySource"),
      usageByProject: view("usageByProject"),
      skills: view("skills"),
      toolsByTool: view("toolsByTool"),
      toolsByCategory: view("toolsByCategory"),
      toolsByMcpServer: view("toolsByMcpServer"),
      toolsHeaviestResults: view("toolsHeaviestResults"),
      plugins: view("plugins"),
      health: view("health"),
      recommendations: view("recommendations"),
    } as unknown as McpDeps["views"],
    sessionList: async () => ({ rows: [listItem()], total: 1, offset: 0, limit: 20 }),
    sessionDetail: async (id) => fixtureSession(id),
    sessionInteractions: async () => fixtureTimeline(3),
    sessionTaskMetrics: async () => fixtureMetrics,
    ...overrides,
  };
}

function mcpApp(deps: McpDeps, opts: { readOnly?: boolean } = {}): Hono {
  return createApp(null, { mcp: createMcpHandler(deps), readOnly: opts.readOnly });
}

describe("MCP endpoint (#299)", () => {
  test("initialize answers with the server identity and instructions", async () => {
    const app = mcpApp(fakeDeps());
    const { status, body } = await rpc(app, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(status).toBe(200);
    expect(body.result.serverInfo.name).toBe("argus");
    expect(body.result.instructions).toContain("YYYY-MM-DD");
    expect(body.result.instructions).toContain("claude-chat");
  });

  test("tools/list registers exactly the six read-only tools", async () => {
    const app = mcpApp(fakeDeps());
    const { body } = await rpc(app, "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect([...names].sort()).toEqual([
      "get_session",
      "get_session_transcript",
      "health_summary",
      "search_sessions",
      "tool_usage",
      "usage_summary",
    ]);
    for (const tool of body.result.tools) {
      expect(tool.annotations?.readOnlyHint ?? true).toBe(true);
    }
  });

  test("search_sessions passes filters through to the session list reader", async () => {
    let captured: SessionListQuery | undefined;
    const deps = fakeDeps({
      sessionList: async (query) => {
        captured = query;
        return { rows: [], total: 0, offset: 0, limit: query.limit };
      },
    });
    const { status, body } = await callTool(mcpApp(deps), "search_sessions", {
      query: "invoice",
      file: "src/api",
      since: "2026-08-01",
      until: "2026-08-07",
      source: "claude",
      project: "billing",
      sort: "cost",
      limit: 10,
    });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(captured).toEqual({
      since: "2026-08-01",
      until: "2026-08-07",
      source: "claude",
      project: "billing",
      q: "invoice",
      file: "src/api",
      includeGenerated: false,
      sort: "cost",
      limit: 10,
      offset: 0,
    });
  });

  test("search_sessions defaults sort/limit and clamps the limit to 50", async () => {
    const seen: SessionListQuery[] = [];
    const deps = fakeDeps({
      sessionList: async (query) => {
        seen.push(query);
        return { rows: [], total: 0, offset: 0, limit: query.limit };
      },
    });
    const app = mcpApp(deps);
    await callTool(app, "search_sessions");
    expect(seen[0]).toMatchObject({ sort: "recent", limit: 20, offset: 0, includeGenerated: false });
    await callTool(app, "search_sessions", { limit: 500 });
    expect(seen[1]!.limit).toBe(50);
  });

  test("search_sessions strips the FTS snippet sentinels before returning matches", async () => {
    process.env.ARGUS_AGENT_ACCESS_INCLUDE_TRANSCRIPTS = "true";
    const deps = fakeDeps({
      sessionList: async () => ({
        rows: [
          listItem({
            match: { count: 2, snippet: "the \x01invoice\x02 total", sources: ["conversation"] },
          }),
        ],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    });
    const { body } = await callTool(mcpApp(deps), "search_sessions", { query: "invoice" });
    const row = body.result.structuredContent.sessions[0];
    expect(row.match.snippet).toBe("the invoice total");
    expect(row.match.snippet).not.toContain("\x01");
  });

  test("search_sessions hides the opening prompt and conversation snippets while transcripts are off", async () => {
    const deps = fakeDeps({
      sessionList: async () => ({
        rows: [
          listItem({
            firstPrompt: "a private prompt",
            match: { count: 1, snippet: "a private response", sources: ["conversation"] },
          }),
        ],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    });
    const { body } = await callTool(mcpApp(deps), "search_sessions", { query: "private" });
    const row = body.result.structuredContent.sessions[0];
    expect(row.firstPrompt).toBeUndefined();
    expect(row.match).toBeUndefined();
  });

  test("search_sessions and get_session include retained prompt text when transcripts are on", async () => {
    process.env.ARGUS_AGENT_ACCESS_INCLUDE_TRANSCRIPTS = "true";
    const deps = fakeDeps({
      sessionList: async () => ({
        rows: [
          listItem({
            firstPrompt: "a private prompt",
            match: { count: 1, snippet: "a private response", sources: ["conversation"] },
          }),
        ],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    });
    const app = mcpApp(deps);
    const search = await callTool(app, "search_sessions", { query: "private" });
    expect(search.body.result.structuredContent.sessions[0].firstPrompt).toBe("a private prompt");
    expect(search.body.result.structuredContent.sessions[0].match.snippet).toBe("a private response");

    const detail = await callTool(app, "get_session", { session_id: "s1" });
    expect(detail.body.result.structuredContent.session.firstPrompt).toBe("hi");
  });

  test("get_session hides the opening prompt while transcripts are off", async () => {
    const { body } = await callTool(mcpApp(fakeDeps()), "get_session", { session_id: "s1" });
    expect(body.result.structuredContent.session.firstPrompt).toBeUndefined();
  });

  test("get_session returns the session, and attaches task metrics when asked", async () => {
    const app = mcpApp(fakeDeps());
    const plain = await callTool(app, "get_session", { session_id: "s1" });
    expect(plain.body.result.structuredContent.session.sessionId).toBe("s1");
    expect(plain.body.result.structuredContent.taskMetrics).toBeUndefined();

    const withMetrics = await callTool(app, "get_session", {
      session_id: "s1",
      include_task_metrics: true,
    });
    expect(withMetrics.body.result.structuredContent.taskMetrics).toEqual(fixtureMetrics);
  });

  test("get_session refuses an unknown session id", async () => {
    const deps = fakeDeps({ sessionDetail: async () => null });
    const { body } = await callTool(mcpApp(deps), "get_session", { session_id: "nope" });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("nope");
  });

  test("get_session_transcript paginates interactions", async () => {
    process.env.ARGUS_AGENT_ACCESS_INCLUDE_TRANSCRIPTS = "true";
    const app = mcpApp(fakeDeps({ sessionInteractions: async () => fixtureTimeline(10) }));
    const { body } = await callTool(app, "get_session_transcript", {
      session_id: "s1",
      offset: 2,
      limit: 3,
    });
    const payload = body.result.structuredContent;
    expect(payload.total).toBe(10);
    expect(payload.offset).toBe(2);
    expect(payload.limit).toBe(3);
    expect(payload.interactions.map((i: { seq: number }) => i.seq)).toEqual([2, 3, 4]);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.retainedText).toBe(true);
  });

  test("get_session_transcript refuses while transcript access is off, and says how to enable it", async () => {
    const app = mcpApp(fakeDeps());
    // Off by default.
    const off = await callTool(app, "get_session_transcript", { session_id: "s1" });
    expect(off.body.result.isError).toBe(true);
    expect(off.body.result.content[0].text).toContain("Settings");
    // The tool stays listed, with a description that points at the toggle.
    const listed = await rpc(app, "tools/list");
    const tool = listed.body.result.tools.find(
      (t: { name: string }) => t.name === "get_session_transcript",
    );
    expect(tool.description).toContain("Agent access");
    // The transcript toggle alone isn't enough when no text is retained.
    process.env.ARGUS_AGENT_ACCESS_INCLUDE_TRANSCRIPTS = "true";
    process.env.ARGUS_RETAIN_TEXT = "false";
    const noText = await callTool(app, "get_session_transcript", { session_id: "s1" });
    expect(noText.body.result.isError).toBe(true);
  });

  test("usage_summary routes each group_by to its view reader, with filters", async () => {
    const app = mcpApp(fakeDeps());
    for (const [groupBy, view] of [
      ["day", "usageDaily"],
      ["model", "usageByModel"],
      ["source", "usageBySource"],
      ["project", "usageByProject"],
    ] as const) {
      const { body } = await callTool(app, "usage_summary", {
        group_by: groupBy,
        since: "2026-08-01",
      });
      const payload = body.result.structuredContent;
      expect(payload.groupBy).toBe(groupBy);
      expect(payload[view]).toBe(true);
      expect(payload.filters).toEqual({ since: "2026-08-01" });
    }
  });

  test("tool_usage routes each group_by to its view reader", async () => {
    const app = mcpApp(fakeDeps());
    for (const [groupBy, view] of [
      ["tool", "toolsByTool"],
      ["category", "toolsByCategory"],
      ["mcp_server", "toolsByMcpServer"],
      ["skill", "skills"],
    ] as const) {
      const { body } = await callTool(app, "tool_usage", { group_by: groupBy });
      expect(body.result.structuredContent.groupBy).toBe(groupBy);
      expect(body.result.structuredContent[view]).toBe(true);
    }
  });

  test("health_summary combines the health and recommendations views", async () => {
    const { body } = await callTool(mcpApp(fakeDeps()), "health_summary", {});
    const payload = body.result.structuredContent;
    expect(payload.health).toBe(true);
    expect(payload.recommendations).toBe(true);
  });

  test("POST /mcp 404s when agent access is disabled", async () => {
    process.env.ARGUS_AGENT_ACCESS_ENABLED = "false";
    const { status, body } = await rpc(mcpApp(fakeDeps()), "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(status).toBe(404);
    expect(body.error).toContain("Agent access is off");
  });

  test("a non-loopback Host is rejected (DNS rebinding defense)", async () => {
    const { status } = await rpc(mcpApp(fakeDeps()), "initialize", {}, { host: "evil.example.com" });
    expect(status).toBe(403);
  });

  test("GET /mcp is a 405 — no standalone notification stream", async () => {
    const app = mcpApp(fakeDeps());
    const res = await app.request("/mcp", { method: "GET", headers: { Host: "localhost:4242" } });
    expect(res.status).toBe(405);
  });

  test("the endpoint stays mounted in read-only mode (#281)", async () => {
    const app = mcpApp(fakeDeps(), { readOnly: true });
    const { status, body } = await callTool(app, "search_sessions", {});
    expect(status).toBe(200);
    expect(body.result.structuredContent.total).toBe(1);
  });

  test("unknown tool names come back as tool errors", async () => {
    const { body } = await callTool(mcpApp(fakeDeps()), "nope", {});
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("nope");
  });
});
