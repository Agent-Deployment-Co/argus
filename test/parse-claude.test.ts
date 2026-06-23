import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  parseClaudeTranscriptPath,
  parseClaudeTranscriptFile,
} from "../src/indexing/parse/producers/claude/parser.ts";

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
      userMessages: 1,
      agentMessages: 2,
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
    expect(session.agentMessages).toBe(1);
    expect(fragment.facts.messages[0]?.sourceSessionId).toBe(session.sourceSessionId);
    expect(fragment.facts.relationships).toEqual([
      expect.objectContaining({
        childSourceSessionId: session.sourceSessionId,
        parentSourceSessionId: "sess1",
        kind: "subagent",
      }),
    ]);
  });

  test("excludes a subagent's worker prompt from task candidates (#118 / #100)", () => {
    // A subagent transcript lives under <session>/subagents/<agent>.jsonl; discovery gives it the
    // file identity the parser needs to recognize it as an agent-initiated subagent session.
    const root = temporaryDirectory();
    const project = join(root, "-Users-fixture-proj");
    mkdirSync(join(project, "sess9", "subagents"), { recursive: true });
    writeFileSync(
      join(project, "sess9.jsonl"),
      [
        { type: "user", sessionId: "sess9", cwd: "/Users/fixture/proj", uuid: "u-main-1", timestamp: "2026-06-01T00:00:00.000Z", message: { content: [{ type: "text", text: "fetch a PR and run code review" }] } },
        { type: "assistant", sessionId: "sess9", timestamp: "2026-06-01T00:00:01.000Z", message: { id: "m-main-1", model: "claude-sonnet-4-6", usage: { input_tokens: 1 }, content: [{ type: "text", text: "on it" }] } },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    writeFileSync(
      join(project, "sess9", "subagents", "worker.jsonl"),
      [
        { type: "user", sessionId: "sess9", isSidechain: true, uuid: "u-sub-1", timestamp: "2026-06-01T00:00:02.000Z", message: { content: [{ type: "text", text: "Run the finder over these files" }] } },
        { type: "assistant", sessionId: "sess9", isSidechain: true, timestamp: "2026-06-01T00:00:03.000Z", message: { id: "m-sub-1", model: "claude-sonnet-4-6", usage: { input_tokens: 1 }, content: [{ type: "text", text: "found 8 things" }] } },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );

    const discovery = discoverClaudeTranscripts(root);
    expect(discovery.status).toBe("complete");
    const worker = discovery.files.find((file) => file.file.relativePath.endsWith("subagents/worker.jsonl"))!;
    const parsed = parseClaudeTranscriptFile(worker, {
      historyInputId: claudeHistoryFileIdentity(HISTORY).id,
    });
    expect(parsed.status).toBe("current");
    if (parsed.status !== "current") throw new Error("expected current Claude transcript");
    const facts = parsed.fragment.facts;
    expect(facts.sessions[0]?.kind).toBe("subagent");
    // The worker prompt is agent-authored, so it produces NO task candidate — it can't resurface as a
    // phantom task once folded onto the parent (#100).
    expect(facts.taskCandidates).toEqual([]);
    // It is still recorded as an agent-initiated prompt marker (interaction structure, #117).
    expect(facts.prompts?.map((prompt) => prompt.initiator)).toEqual(["agent"]);
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

  test("counts real Claude user messages and unique agent messages", () => {
    const root = temporaryDirectory();
    const transcript = join(root, "session.jsonl");
    const records = [
      {
        type: "user",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:00.000Z",
        message: { content: "<local-command-caveat>ignore command output</local-command-caveat>" },
      },
      {
        type: "user",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:01.000Z",
        message: { content: "<bash-input>jj status</bash-input>" },
      },
      {
        type: "user",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:02.000Z",
        message: { content: "<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>" },
      },
      {
        type: "user",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:03.000Z",
        message: { content: "update the parser" },
      },
      {
        type: "user",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:04.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
      },
      {
        type: "user",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:05.000Z",
        message: { content: [{ type: "text", text: "Base directory for this skill: /tmp/skill\n\n# Skill" }] },
      },
      {
        type: "user",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:06.000Z",
        message: {
          content:
            "You identify the actual tasks a user was trying to accomplish in a coding-agent session.\n\nFiltered user messages:\n{}",
        },
      },
      {
        type: "assistant",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:07.000Z",
        message: {
          id: "message-1",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1 },
          content: [{ type: "text", text: "working" }],
        },
      },
      {
        type: "assistant",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:08.000Z",
        message: {
          id: "message-1",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1 },
          content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
        },
      },
      {
        type: "assistant",
        sessionId: "session",
        timestamp: "2026-06-01T00:00:09.000Z",
        message: {
          id: "message-2",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1 },
          content: [{ type: "text", text: "done" }],
        },
      },
    ];
    writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n"));

    const parsed = parseClaudeTranscriptPath(transcript);
    expect(parsed.status).toBe("current");
    if (parsed.status !== "current") throw new Error("expected current Claude transcript");
    expect(parsed.fragment.facts.sessions[0]).toMatchObject({
      userMessages: 2,
      agentMessages: 2,
    });
  });

  test("excludes Argus task extraction prompts from task candidates", () => {
    const root = temporaryDirectory();
    const transcript = join(root, "task-extraction.jsonl");
    const prompt = `You identify the actual tasks a user was trying to accomplish in a coding-agent session.

Return JSON only.

Filtered user messages:
{
  "sessionId": "codex:one",
  "messages": [
    {
      "index": 0,
      "text": "add a facts command"
    }
  ]
}`;
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "user",
        sessionId: "task-extraction-session",
        timestamp: "2026-06-17T17:43:52.723Z",
        message: { role: "user", content: prompt },
        cwd: "/Users/fixture/proj",
      })}\n`,
    );

    const parsed = parseClaudeTranscriptPath(transcript);
    expect(parsed.status).toBe("current");
    if (parsed.status !== "current") throw new Error("expected current Claude transcript");
    expect(parsed.fragment.facts.sessions[0]?.firstPrompt).toBe("Task extraction for codex:one");
    expect(parsed.fragment.facts.taskCandidates).toEqual([]);
  });

  test("excludes Argus session analysis prompts from task candidates", () => {
    const root = temporaryDirectory();
    const transcript = join(root, "session-analysis.jsonl");
    const prompt = `Analyze this coding-agent session. Return JSON only with these string fields: title, attempted, outcome, outcomeReason.

FACTS:
{
  "sessionId": "codex:019ebd64-dee1-7083-9193-1592d42f77ca",
  "source": "codex",
  "project": "adc/argus"
}

TRANSCRIPT:
USER: add a new session analysis mode`;
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "user",
        sessionId: "session-analysis-session",
        timestamp: "2026-06-16T21:09:17.281Z",
        message: { role: "user", content: prompt },
        cwd: "/Users/fixture/proj",
      })}\n`,
    );

    const parsed = parseClaudeTranscriptPath(transcript);
    expect(parsed.status).toBe("current");
    if (parsed.status !== "current") throw new Error("expected current Claude transcript");
    expect(parsed.fragment.facts.sessions[0]?.firstPrompt).toBe(
      "Session analysis for codex:019ebd64-dee1-7083-9193-1592d42f77ca",
    );
    expect(parsed.fragment.facts.taskCandidates).toEqual([]);
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
