import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claudeHistoryFileIdentity,
  createClaudeHistoryParserAdapter,
  createClaudeTranscriptDiscoveryAdapter,
  createClaudeTranscriptParserAdapter,
  discoverClaudeHistory,
  discoverClaudeTranscripts,
  parseClaudeHistoryFile,
  parseClaudeTranscriptFile,
} from "../src/producers/claude/parser.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const PROJECTS = join(FIXTURES, "projects");
const HISTORY = join(FIXTURES, "history.jsonl");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "argus-claude-"));
  temporaryDirectories.push(directory);
  return directory;
}

function currentTranscript(relativePath: string) {
  const discovery = discoverClaudeTranscripts(PROJECTS);
  expect(discovery.status).toBe("complete");
  const file = discovery.files.find((candidate) => candidate.file.relativePath === relativePath)!;
  const result = parseClaudeTranscriptFile(file, {
    historyInputId: claudeHistoryFileIdentity(HISTORY).id,
  });
  expect(result.status).toBe("current");
  if (result.status !== "current") throw new Error("expected current Claude transcript");
  return result.fragment;
}

describe("Claude fragment discovery", () => {
  test("recursively discovers deterministic transcript identities", () => {
    const result = discoverClaudeTranscripts(PROJECTS);
    expect(result.status).toBe("complete");
    expect(result.files.map((file) => file.file.relativePath)).toEqual([
      "-Users-fixture-proj/sess1.jsonl",
      "-Users-fixture-proj/sess1/subagents/agent-a1.jsonl",
    ]);
    expect(result.files.every((file) => file.file.source === "claude")).toBe(true);
    expect(result.files.every((file) => file.file.role === "transcript")).toBe(true);
    expect(result.files.every((file) => /^\d+$/.test(file.fingerprint.mtimeNs))).toBe(true);
  });

  test("exports contract-compatible discovery and parser adapters", () => {
    expect(createClaudeTranscriptDiscoveryAdapter(PROJECTS).source).toBe("claude");
    expect(createClaudeTranscriptDiscoveryAdapter(PROJECTS).discover().status).toBe("complete");
    expect(createClaudeTranscriptParserAdapter().parser.name).toBe("claude-jsonl");
    expect(createClaudeHistoryParserAdapter().parser.name).toBe("claude-history");
  });
});

describe("Claude transcript fragments", () => {
  test("preserves usage, IDs, attribution, contiguous chunks, and tool facts", () => {
    const fragment = currentTranscript("-Users-fixture-proj/sess1.jsonl");
    expect(fragment.facts.messages).toHaveLength(2);

    const first = fragment.facts.messages.find((message) => message.providerMessageId === "m1")!;
    expect(first.requestId).toBe("r1");
    expect(first.model).toBe("claude-sonnet-4-6");
    expect(first.attributionSkill).toBe("jj:jj");
    expect(first.timestampMs).toBe(Date.parse("2026-06-01T17:00:01.000Z"));
    expect(first.cwd).toBe("/Users/fixture/proj");
    expect(first.gitBranch).toBe("main");
    expect(first.position.recordIndex).toBe(1);
    expect(first.usage).toEqual({
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite5m: 20,
      cacheWrite1h: 30,
    });
    expect(
      fragment.facts.messages.find((message) => message.providerMessageId === "m2")?.usage,
    ).toEqual({
      input: 2,
      output: 8,
      cacheRead: 0,
      cacheWrite5m: 40,
      cacheWrite1h: 0,
    });
    expect(fragment.facts.sessions[0]).toMatchObject({
      kind: "main",
      sourceSessionId: "sess1",
      cwd: "/Users/fixture/proj",
      gitBranch: "main",
    });
    expect(fragment.facts.taskCandidates).toEqual([
      expect.objectContaining({
        source: "claude",
        sourceSessionId: "sess1",
        text: "hello there",
        timestampMs: Date.parse("2026-06-01T17:00:00.000Z"),
        position: expect.objectContaining({ recordIndex: 0 }),
      }),
    ]);
    expect(fragment.facts.tasks).toEqual([]);

    const invocations = fragment.facts.invocations.filter(
      (invocation) => invocation.messageId === first.id,
    );
    expect(invocations.map((invocation) => invocation.name).sort()).toEqual([
      "Edit",
      "Skill",
      "mcp__fathom__search_meetings",
    ]);
    expect(invocations.find((invocation) => invocation.name === "Edit")?.filePath).toBe(
      "/Users/fixture/proj/a.ts",
    );
    expect(invocations.find((invocation) => invocation.name === "Skill")).toMatchObject({
      invocationId: "t3",
      skill: "jj:jj",
      args: "commit the change",
    });
    expect(
      invocations.find((invocation) => invocation.name.startsWith("mcp__")),
    ).toMatchObject({
      invocationId: "t2",
      mcpServer: "fathom",
      mcpTool: "search_meetings",
      timestampMs: Date.parse("2026-06-01T17:00:01.500Z"),
    });
    expect(
      invocations.find((invocation) => invocation.name.startsWith("mcp__"))?.position.recordIndex,
    ).toBe(2);

    const result = fragment.facts.toolResults[0]!;
    expect(result).toMatchObject({
      sourceSessionId: "sess1",
      invocationId: "t1",
      observedToolName: "Edit",
    });
    expect(result.resolvedInvocationFactId).toBe(
      invocations.find((invocation) => invocation.invocationId === "t1")?.id,
    );
    expect(result.approxTokens).toBeGreaterThan(0);
    expect(result.position.recordIndex).toBe(3);
    expect(fragment.dependencies).toEqual([
      {
        inputId: claudeHistoryFileIdentity(HISTORY).id,
        selector: "sess1",
        affects: ["session_first_prompt"],
      },
    ]);
    expect(JSON.parse(JSON.stringify(fragment))).toEqual(fragment);
  });

  test("represents subagents without folding them into the parent session", () => {
    const fragment = currentTranscript(
      "-Users-fixture-proj/sess1/subagents/agent-a1.jsonl",
    );
    const session = fragment.facts.sessions[0]!;
    expect(session.kind).toBe("subagent");
    expect(session.sourceSessionId).toBe("sess1:subagent:agent-a1");
    expect(fragment.facts.messages[0]?.sourceSessionId).toBe(session.sourceSessionId);
    expect(fragment.facts.relationships).toEqual([
      expect.objectContaining({
        childSourceSessionId: session.sourceSessionId,
        parentSourceSessionId: "sess1",
        kind: "subagent",
      }),
    ]);
  });

  test("keeps resumed provider-message replays separate and diagnoses malformed lines", () => {
    const root = temporaryDirectory();
    const transcript = join(root, "session.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: "assistant",
          sessionId: "session",
          timestamp: "2026-06-01T00:00:00.000Z",
          requestId: "request-1",
          message: {
            id: "message-1",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1 },
            content: [{ type: "text", text: "first chunk" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "session",
          timestamp: "2026-06-01T00:00:00.100Z",
          requestId: "request-1",
          message: {
            id: "message-1",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1 },
            content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
          },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "session",
          timestamp: "2026-06-01T00:00:01.000Z",
          message: { content: "boundary" },
        }),
        "{malformed",
        JSON.stringify({
          type: "assistant",
          sessionId: "session",
          timestamp: "2026-06-01T00:00:02.000Z",
          requestId: "request-2",
          message: {
            id: "message-1",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1 },
            content: [{ type: "text", text: "replayed" }],
          },
        }),
      ].join("\n"),
    );

    const discovery = discoverClaudeTranscripts(root);
    expect(discovery.status).toBe("complete");
    const parsed = parseClaudeTranscriptFile(discovery.files[0]!);
    expect(parsed.status).toBe("current");
    if (parsed.status !== "current") throw new Error("expected current Claude transcript");
    expect(parsed.fragment.facts.messages).toHaveLength(2);
    expect(parsed.fragment.facts.messages.map((message) => message.providerMessageId)).toEqual([
      "message-1",
      "message-1",
    ]);
    expect(parsed.fragment.facts.messages.map((message) => message.requestId)).toEqual([
      "request-1",
      "request-2",
    ]);
    expect(parsed.fragment.facts.invocations).toHaveLength(1);
    expect(parsed.fragment.diagnostics).toEqual([
      expect.objectContaining({
        code: "malformed_record",
        position: expect.objectContaining({ recordIndex: 3 }),
      }),
    ]);
  });
});

describe("Claude history auxiliary fragments", () => {
  test("emits the earliest prompt per session independently of transcripts", () => {
    const discovery = discoverClaudeHistory(HISTORY);
    expect(discovery.status).toBe("complete");
    const result = parseClaudeHistoryFile(discovery.files[0]!);
    expect(result.status).toBe("current");
    if (result.status !== "current") throw new Error("expected current Claude history");
    expect(result.fragment.facts).toEqual([
      expect.objectContaining({
        kind: "session_first_prompt",
        sourceSessionId: "sess1",
        firstPrompt: "hello there",
        timestampMs: 1780333200000,
      }),
    ]);
  });

  test("history changes replace only auxiliary first-prompt facts", () => {
    const root = temporaryDirectory();
    const history = join(root, "history.jsonl");
    writeFileSync(
      history,
      JSON.stringify({ sessionId: "session", display: "first", timestamp: 2 }),
    );
    const firstDiscovery = discoverClaudeHistory(history);
    expect(firstDiscovery.status).toBe("complete");
    const first = parseClaudeHistoryFile(firstDiscovery.files[0]!);
    expect(first.status).toBe("current");
    if (first.status !== "current") throw new Error("expected current Claude history");

    writeFileSync(
      history,
      [
        JSON.stringify({ sessionId: "session", display: "first", timestamp: 2 }),
        JSON.stringify({ sessionId: "session", display: "earlier", timestamp: 1 }),
      ].join("\n"),
    );
    const secondDiscovery = discoverClaudeHistory(history);
    expect(secondDiscovery.status).toBe("complete");
    const second = parseClaudeHistoryFile(secondDiscovery.files[0]!);
    expect(second.status).toBe("current");
    if (second.status !== "current") throw new Error("expected current Claude history");

    expect(first.fragment.id).toBe(second.fragment.id);
    expect(first.fragment.snapshot.fingerprint).not.toEqual(second.fragment.snapshot.fingerprint);
    expect(first.fragment.facts[0]).toMatchObject({ firstPrompt: "first" });
    expect(second.fragment.facts[0]).toMatchObject({ firstPrompt: "earlier" });
  });
});
