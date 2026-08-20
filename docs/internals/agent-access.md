# Agent access (the `/mcp` endpoint)

Issue #299. `serve` exposes an [MCP](https://modelcontextprotocol.io) endpoint at
`POST /mcp` so AI agents on the same machine, or an explicitly authorized Docker container, can query
the Argus store: session search and detail, transcripts, usage, tool usage and health. It lets an agent answer
"what did I work on last week?" from the user's own work history.

```
  Claude Code / Codex / Gemini CLI
        │  POST /mcp  (streamable HTTP, JSON-RPC)
        ▼
  src/api/mcp.ts  ── createMcpHandler ── per request: resolve gates → 404 if disabled
        │                                    fresh McpServer + StreamableHTTPTransport (stateless)
        ▼
  the same readers startServer wires into /api/* (no new store queries)
```

## Why streamable HTTP on the serve app

The alternatives were a stdio subcommand (`argus mcp`) and "just document the HTTP API". Stdio loses
for the desktop app, which is how most users run Argus: the sidecar binary lives at an unstable
bundle path inside the `.app`, so there is no stable command for a client config to point at, and
"works while Argus isn't running" isn't a real use case when the daemon is the product. Documenting
the raw HTTP API works but makes every client hand-roll calls; MCP tools describe themselves, so the
agent discovers arguments and shapes on its own. Streamable HTTP on the existing serve app is
reachable at `http://127.0.0.1:4242/mcp` for local clients: desktop users ride the front-door proxy (a
dumb TCP relay, so `/mcp` passes through with no proxy changes and survives sidecar restarts), CLI
users hit `serve`/`run` directly. Claude Code, Codex and Gemini CLI all speak streamable HTTP.

The endpoint rides the serve leg, so `run.ts` and `cli.ts` needed no changes.

## Transport shape

Stateless, per `src/api/mcp.ts`:

- **A fresh `McpServer` + `StreamableHTTPTransport` (`@hono/mcp`) per request**, with
  `sessionIdGenerator: undefined` (no session ids, no cross-request state) and
  `enableJsonResponse: true` (POSTs answer with plain JSON rather than an SSE stream, which keeps
  smoke tests and curl simple; real clients accept either).
- **`GET /mcp` → 405.** That's the spec's optional standalone notification stream; this server never
  initiates messages (tools only), so it declines instead of holding an SSE stream open.
- Only `@modelcontextprotocol/sdk`'s `server/mcp.js` and types subpaths are imported, never its
  node/express transports, so `bun build --compile` bundles cleanly (smoke-tested: compile, then a
  JSON-RPC `initialize` POST against `dist/argus serve`).

## Tools → readers

Six read-only tools, each reusing the exact reader the web API uses, so MCP answers can't drift from
the dashboard. No new store queries exist for MCP.

| Tool | Reader(s) it calls |
|---|---|
| `search_sessions` | `sessionList` (→ `store.searchSessions` + `readSessionAggregates` + `buildSessionList`; FTS snippet sentinels stripped like `search-ops.ts`, limit clamped to 50) |
| `get_session` | `sessionDetail`, plus `sessionTaskMetrics` when `include_task_metrics` |
| `get_session_transcript` | `sessionInteractions` (`buildSessionInteractions`), paginated by offset/limit |
| `usage_summary` | `views.usageDaily` / `usageByModel` / `usageBySource` / `usageByProject` by `group_by` |
| `tool_usage` | `views.toolsByTool` / `toolsByCategory` / `toolsByMcpServer` / `skills` by `group_by` |
| `health_summary` | `views.health` + `views.recommendations` |

Each tool returns the payload twice: pretty JSON text in `content` (every client shows it) and the
same object as `structuredContent`. No `outputSchema` — the payloads are the readers' own response
types, and validating them would duplicate those types as zod for no behavior gain. The server
`instructions` teach the two things agents get wrong unprompted: date semantics (`since`/`until` are
local YYYY-MM-DD, inclusive; the agent computes "last week" itself) and the valid `source` values.

## Gates and threat model

Two settings (`src/config.ts` `AGENT_ACCESS_SETTINGS`), both resolved **per request** so the Settings
toggles apply live with no restart:

- `agentAccess.enabled` (default **on**). MCP adds discoverability, not new exposure: the read API
  is already open to any local process that can reach the loopback port. Matches the interpret
  default-on precedent. Off → `/mcp` answers 404.
- `agentAccess.includeTranscripts` (default **off**). The genuinely new risk is transcript text
  flowing into a remote model's context when an agent reads it. The transcript tool also requires
  `retainText` (#120): with retention off there is no text in the store to read. The tool stays
  listed while gated, with a description that tells the agent how to ask the user to enable it, and
  refuses with a tool-level error (`isError`, not a protocol error) if called anyway.

Security posture, consistent with the rest of `serve`:

- The endpoint mounts among the **read routes** in `createApp`, so it survives `readOnly` mode
  (#281) and exists even where every write route is dropped.
- Local requests are guarded by the existing **`rejectUnsafeHost`**, which checks both the actual
  TCP peer and the `Host`/`Origin` values for the MCP spec's DNS-rebinding requirement. A remote client
  cannot pass that guard by sending `Host: localhost`.
- A non-loopback peer must send `Authorization: Bearer <token>`. The token comes from
  `ARGUS_MCP_TOKEN` or the stored `ARGUS_MCP_TOKEN` secret. The comparison is constant-time, and the
  token is never logged or returned.
- **No `x-argus-app` CSRF requirement**: MCP is not a browser write surface, and every tool is
  read-only. Remote clients use `Authorization` for access instead.
- **`--host` (#344) widens the listener, not the dashboard's privileged routes**: the dashboard's
  settings, secrets and connection-test routes still require an actual loopback peer. `/mcp` accepts
  a Docker or other remote peer only when it presents the bearer token.

Non-goals for v1 (see the issue for the full list): no stdio subcommand, no write tools, no MCP
resources/prompts, no one-click client-config install, no Hub-side org endpoint.

## Tests and verification

`test/mcp.test.ts` drives `createApp(null, { mcp: createMcpHandler(fakeDeps) })` with raw JSON-RPC
POSTs (the serve.test.ts fake-reader pattern): `initialize`, `tools/list`, `tools/call` per tool,
filter pass-through, sentinel stripping, limit clamping, and the gates (`enabled=false` → 404,
transcripts off → refusal, non-loopback `Host` → 403, GET → 405, still mounted in read-only mode).
Config resolution is covered in `test/config.test.ts` (`resolveAgentAccess`, mirroring the
`resolveRetainText` tests).
