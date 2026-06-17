import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createCodexTranscriptDiscoveryAdapter,
  createCodexTranscriptParserAdapter,
  discoverCodexTranscripts,
  parseCodexTranscript,
  parseCodexTranscriptFile,
} from "../src/producers/codex/parser.ts";
import { createFileIdentity } from "../src/store-contract.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const FRAGMENT_ROOT = join(FIXTURES, "codex-fragments");
const LEGACY_ROOT = join(FIXTURES, "codex-sessions");

function currentFragment(root: string) {
  const discovery = discoverCodexTranscripts(root);
  expect(discovery.status).toBe("complete");
  expect(discovery.files).toHaveLength(1);
  const result = parseCodexTranscriptFile(discovery.files[0]!);
  expect(result.status).toBe("current");
  if (result.status !== "current") throw new Error("expected current Codex transcript");
  return result.fragment;
}

describe("Codex fragment discovery", () => {
  test("recursively discovers deterministic transcript identities", () => {
    const result = discoverCodexTranscripts(FRAGMENT_ROOT);
    expect(result.status).toBe("complete");
    expect(result.files.map((file) => file.file.relativePath)).toEqual([
      "2026/06/11/rollout-2026-06-11T10-00-00-fragment-sess.jsonl",
    ]);
    expect(result.files[0]?.file).toMatchObject({
      source: "codex",
      rootId: "codex-sessions",
      role: "transcript",
    });
    expect(result.files[0]?.fingerprint).toMatchObject({
      sizeBytes: expect.stringMatching(/^\d+$/),
      mtimeNs: expect.stringMatching(/^\d+$/),
      ctimeNs: expect.stringMatching(/^\d+$/),
    });
  });

  test("reports a missing root without producing an authoritative file set", () => {
    const result = discoverCodexTranscripts(join(FRAGMENT_ROOT, "missing"));
    expect(result.status).toBe("missing");
    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "missing_root", phase: "discovery" }),
    ]);
  });

  test("exports contract-compatible discovery and parser adapters", () => {
    const discovery = createCodexTranscriptDiscoveryAdapter(FRAGMENT_ROOT);
    expect(discovery.source).toBe("codex");
    expect(discovery.discover().status).toBe("complete");
    expect(createCodexTranscriptParserAdapter().parser).toEqual({
      name: "codex-jsonl",
      source: "codex",
      version: "8",
    });
  });
});

describe("Codex transcript fragments", () => {
  test("matches the existing token_count parser fixture", () => {
    const fragment = currentFragment(LEGACY_ROOT);
    expect(fragment.facts.messages).toHaveLength(2);
    expect(fragment.facts.messages.map((message) => message.model)).toEqual([
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
    expect(fragment.facts.messages.map((message) => message.usage)).toEqual([
      {
        input: 750,
        output: 40,
        cacheRead: 250,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
      {
        input: 99,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    ]);
    expect(fragment.facts.invocations.map((invocation) => invocation.name)).toEqual([
      "exec_command",
      "web_search_call",
    ]);
    expect(fragment.facts.toolResults[0]).toMatchObject({
      invocationId: "call-1",
      observedToolName: "exec_command",
    });
    expect(fragment.facts.toolResults[0]?.resolvedInvocationFactId).toBe(
      fragment.facts.invocations[0]?.id,
    );
    expect(fragment.facts.sessions[0]).toMatchObject({
      sourceSessionId: "codex:codex-sess1",
      cwd: "/Users/fixture/codex-proj",
      firstPrompt: "codex hello",
    });
    expect(fragment.facts.taskCandidates).toEqual([
      expect.objectContaining({
        source: "codex",
        sourceSessionId: "codex:codex-sess1",
        timestampMs: Date.parse("2026-06-03T13:00:02.000Z"),
        text: "codex hello",
        position: expect.objectContaining({ recordIndex: 2 }),
      }),
    ]);
    expect(fragment.facts.tasks).toEqual([]);
  });

  test("preserves context, positive token events, total-only usage, and pending-call flushes", () => {
    const fragment = currentFragment(FRAGMENT_ROOT);
    expect(fragment.facts.messages).toHaveLength(4);
    expect(fragment.facts.messages.map((message) => message.model)).toEqual([
      "gpt-5.5",
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.4-mini",
    ]);
    expect(fragment.facts.messages.map((message) => message.cwd)).toEqual([
      "/Users/fixture/one",
      "/Users/fixture/one",
      "/Users/fixture/two",
      "/Users/fixture/two",
    ]);
    expect(fragment.facts.messages.map((message) => message.usage)).toEqual([
      {
        input: 75,
        output: 10,
        cacheRead: 25,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
      {
        input: 20,
        output: 1,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
      {
        input: 99,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
      {
        input: 7,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    ]);
    expect(fragment.facts.messages.map((message) => message.position.recordIndex)).toEqual([
      6, 7, 14, 17,
    ]);

    const invocationsByMessage = fragment.facts.messages.map((message) =>
      fragment.facts.invocations
        .filter((invocation) => invocation.messageId === message.id)
        .map((invocation) => invocation.name),
    );
    expect(invocationsByMessage).toEqual([
      ["Skill"],
      [],
      ["mcp__github__get_issue", "apply_patch", "web_search_call"],
      [],
    ]);
    expect(fragment.facts.invocations.some((invocation) => invocation.name === "exec_command")).toBe(
      false,
    );
  });

  test("does not carry pending calls past an invalid positive token boundary", () => {
    const file = createFileIdentity({
      source: "codex",
      rootId: "test",
      role: "transcript",
      relativePath: "invalid-timestamp.jsonl",
      path: "/tmp/invalid-timestamp.jsonl",
    });
    const raw = [
      JSON.stringify({
        timestamp: "2026-06-11T15:00:00.000Z",
        type: "session_meta",
        payload: { id: "invalid-timestamp", cwd: "/tmp" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:01.000Z",
        type: "turn_context",
        payload: { cwd: "/tmp", model: "gpt-5.5" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "stale-call",
          arguments: "{\"cmd\":\"bun test\"}",
        },
      }),
      JSON.stringify({
        timestamp: "not-a-timestamp",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 5, output_tokens: 1 } },
        },
      }),
    ].join("\n");

    const fragment = parseCodexTranscript(raw, {
      file,
      fingerprint: {
        sizeBytes: String(Buffer.byteLength(raw)),
        mtimeNs: "1",
        ctimeNs: "1",
      },
      attempts: 1,
    });

    expect(fragment.facts.messages).toHaveLength(1);
    expect(fragment.facts.invocations).toEqual([]);
    expect(fragment.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid_token_timestamp", phase: "parse" }),
    ]);
  });

  test("excludes AGENTS.md and immediately aborted user messages from task candidates", () => {
    const file = createFileIdentity({
      source: "codex",
      rootId: "test",
      role: "transcript",
      relativePath: "filtered-tasks.jsonl",
      path: "/tmp/filtered-tasks.jsonl",
    });
    const raw = [
      JSON.stringify({
        timestamp: "2026-06-11T15:00:00.000Z",
        type: "session_meta",
        payload: { id: "filtered-tasks", cwd: "/tmp" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for /tmp\n<INSTRUCTIONS>..." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "real task" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "instruction that gets aborted" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<turn_aborted>" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: '<turn_aborted reason="user_cancelled"></turn_aborted>' }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:06.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "after abort task" }],
        },
      }),
    ].join("\n");

    const fragment = parseCodexTranscript(raw, {
      file,
      fingerprint: {
        sizeBytes: String(Buffer.byteLength(raw)),
        mtimeNs: "1",
        ctimeNs: "1",
      },
      attempts: 1,
    });

    expect(fragment.facts.sessions[0]?.firstPrompt).toBe("real task");
    expect(fragment.facts.taskCandidates.map((task) => task.text)).toEqual([
      "real task",
      "after abort task",
    ]);
    expect(fragment.facts.tasks).toEqual([]);
  });

  test("counts raw Codex turns and user message events without double-counting response items", () => {
    const file = createFileIdentity({
      source: "codex",
      rootId: "test",
      role: "transcript",
      relativePath: "raw-turns.jsonl",
      path: "/tmp/raw-turns.jsonl",
    });
    const raw = [
      JSON.stringify({
        timestamp: "2026-06-11T15:00:00.000Z",
        type: "session_meta",
        payload: { id: "raw-turns", cwd: "/tmp" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "first" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:01.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-2" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:03.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "[Request interrupted by user]" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:03.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "[Request interrupted by user]" }] },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-2" },
      }),
      JSON.stringify({
        timestamp: "2026-06-11T15:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        },
      }),
    ].join("\n");

    const fragment = parseCodexTranscript(raw, {
      file,
      fingerprint: {
        sizeBytes: String(Buffer.byteLength(raw)),
        mtimeNs: "1",
        ctimeNs: "1",
      },
      attempts: 1,
    });

    expect(fragment.facts.sessions[0]).toMatchObject({
      userMessages: 2,
      rawTurns: 2,
    });
    expect(fragment.facts.messages).toHaveLength(1);
  });

  test("emits IDs, timestamps, arguments, paths, MCP details, and custom calls", () => {
    const fragment = currentFragment(FRAGMENT_ROOT);
    const skill = fragment.facts.invocations.find((invocation) => invocation.name === "Skill")!;
    expect(skill).toMatchObject({
      invocationId: "call-skill",
      timestampMs: Date.parse("2026-06-11T15:00:04.000Z"),
      skill: "jj:jj",
      args: "status",
      position: expect.objectContaining({ recordIndex: 5 }),
    });

    const mcp = fragment.facts.invocations.find((invocation) =>
      invocation.name.startsWith("mcp__"),
    )!;
    expect(mcp).toMatchObject({
      name: "mcp__github__get_issue",
      invocationId: "call-shared",
      mcpServer: "github",
      mcpTool: "get_issue",
      filePath: "/Users/fixture/two/src/a.ts",
      position: expect.objectContaining({ recordIndex: 9 }),
    });
    expect(mcp.args).toContain("\"issue\":19");

    const custom = fragment.facts.invocations.find(
      (invocation) => invocation.name === "apply_patch",
    )!;
    expect(custom).toMatchObject({
      invocationId: "call-patch",
      args: "*** Begin Patch\n*** End Patch",
      position: expect.objectContaining({ recordIndex: 11 }),
    });

    const specialized = fragment.facts.invocations.find(
      (invocation) => invocation.name === "web_search_call",
    )!;
    expect(specialized.invocationId).toBe("ws-1");
    expect(specialized.args).toContain("cache contract");
  });

  test("correlates outputs within the session and diagnoses malformed records", () => {
    const fragment = currentFragment(FRAGMENT_ROOT);
    const mcp = fragment.facts.invocations.find(
      (invocation) => invocation.invocationId === "call-shared",
    )!;
    const custom = fragment.facts.invocations.find(
      (invocation) => invocation.invocationId === "call-patch",
    )!;
    const mcpResult = fragment.facts.toolResults.find(
      (result) => result.invocationId === "call-shared",
    )!;
    const customResult = fragment.facts.toolResults.find(
      (result) => result.invocationId === "call-patch",
    )!;
    const crossSessionResult = fragment.facts.toolResults.find(
      (result) => result.invocationId === "call-1",
    )!;

    expect(mcpResult).toMatchObject({
      observedToolName: "mcp__github__get_issue",
      resolvedInvocationFactId: mcp.id,
      position: expect.objectContaining({ recordIndex: 10 }),
    });
    expect(customResult).toMatchObject({
      observedToolName: "apply_patch",
      resolvedInvocationFactId: custom.id,
      position: expect.objectContaining({ recordIndex: 12 }),
    });
    expect(mcpResult.approxTokens).toBeGreaterThan(0);
    expect(customResult.approxTokens).toBeGreaterThan(0);
    expect(crossSessionResult.observedToolName).toBeUndefined();
    expect(crossSessionResult.resolvedInvocationFactId).toBeUndefined();

    expect(fragment.diagnostics).toEqual([
      expect.objectContaining({
        code: "malformed_record",
        phase: "parse",
        position: expect.objectContaining({ recordIndex: 0, itemIndex: 0, byteOffset: 0 }),
      }),
    ]);
  });

  test("emits stable session facts and serialization-safe fragments", () => {
    const first = currentFragment(FRAGMENT_ROOT);
    const second = currentFragment(FRAGMENT_ROOT);
    expect(first.id).toBe(second.id);
    expect(first.facts.sessions).toEqual([
      expect.objectContaining({
        source: "codex",
        sourceSessionId: "codex:fragment-sess",
        kind: "main",
        cwd: "/Users/fixture/original",
        firstPrompt: "first fragment prompt",
        position: expect.objectContaining({ recordIndex: 1 }),
      }),
    ]);
    expect(first.snapshot.attempts).toBe(1);
    expect(first.facts.messages.map((message) => message.id)).toEqual(
      second.facts.messages.map((message) => message.id),
    );
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
