import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCoworkTranscripts,
  parseCoworkTranscriptFile,
  parseCoworkTranscriptPath,
} from "../src/indexing/parse/producers/cowork/parser.ts";
import { coworkProducer } from "../src/indexing/parse/producers/cowork/index.ts";
import { reconcileSessions } from "../src/indexing/reconcile.ts";

const FIX = join(import.meta.dir, "fixtures", "cowork-sessions");

describe("cowork sidechain guard (#118)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("a sidechain (subagent) turn is agent-initiated and not a task candidate", () => {
    // Cowork's audit.jsonl doesn't carry sidechain turns today, but Cowork does run subagents — guard
    // defensively so a sidechain turn never becomes a (human) task candidate.
    const root = mkdtempSync(join(tmpdir(), "argus-cowork-"));
    dirs.push(root);
    const transcript = join(root, "audit.jsonl");
    const records = [
      { type: "system", subtype: "init", session_id: "sc-test", cwd: "/Users/fixture/proj" },
      { type: "user", isReplay: true, timestamp: "2026-06-01T00:00:01.000Z", message: { content: [{ type: "text", text: "build the feature" }] } },
      { type: "user", isReplay: true, isSidechain: true, timestamp: "2026-06-01T00:00:02.000Z", message: { content: [{ type: "text", text: "run the finder over these files" }] } },
      { type: "assistant", timestamp: "2026-06-01T00:00:03.000Z", message: { id: "m1", model: "claude-sonnet-4-6", usage: { input_tokens: 1 }, content: [{ type: "text", text: "done" }] } },
    ];
    writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n"));

    const parsed = parseCoworkTranscriptPath(transcript);
    expect(parsed.status).toBe("current");
    if (parsed.status !== "current") throw new Error("expected current Cowork transcript");
    const facts = parsed.fragment.facts;
    // Only the human prompt is a task candidate; the sidechain worker prompt is excluded.
    expect(facts.taskCandidates.map((task) => task.text)).toEqual(["build the feature"]);
    // The sidechain turn is loop content: it opens no interaction, so only the human prompt marker
    // is emitted (a single session id means we can't route it elsewhere — see #128).
    expect(facts.prompts?.map((prompt) => prompt.initiator)).toEqual(["human"]);

    // And reconcile must NOT split the human interaction in two at the sidechain timestamp.
    const { interactions } = reconcileSessions({
      caps: coworkProducer.capabilities,
      fragments: [parsed.fragment],
      auxiliaryFragments: [],
    });
    expect(interactions.length).toBe(1);
    expect(interactions[0]?.initiator).toBe("human");
  });
});

describe("cowork live-prompt indexing (#131)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function parseRecords(records: Record<string, unknown>[]) {
    const root = mkdtempSync(join(tmpdir(), "argus-cowork-131-"));
    dirs.push(root);
    const transcript = join(root, "audit.jsonl");
    writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n"));
    const parsed = parseCoworkTranscriptPath(transcript);
    if (parsed.status !== "current") throw new Error(`expected current, got ${parsed.status}`);
    return parsed.fragment.facts;
  }

  test("a live user turn plus a replayed copy collapses to one (resumed session)", () => {
    const facts = parseRecords([
      { type: "system", subtype: "init", session_id: "s131a", cwd: "/Users/you/proj" },
      // Live prompt (isReplay:false, timestamped) — the real user turn.
      { type: "user", uuid: "u1", timestamp: "2026-06-01T00:00:01.000Z", message: { content: [{ type: "text", text: "Fix the login bug" }] } },
      // Replayed copy of the same turn after a resume — same uuid, must not double-count.
      { type: "user", uuid: "u1", isReplay: true, timestamp: "2026-06-01T00:00:01.000Z", message: { content: [{ type: "text", text: "Fix the login bug" }] } },
      { type: "assistant", timestamp: "2026-06-01T00:00:02.000Z", message: { id: "a1", model: "claude-sonnet-4-6", usage: { input_tokens: 1 }, content: [{ type: "text", text: "On it." }] } },
    ]);
    const session = facts.sessions[0]!;
    expect(session.firstPrompt).toBe("Fix the login bug");
    expect(session.userMessages).toBe(1);
    expect(session.agentMessages).toBe(1);
    expect(session.rawTurns).toBe(1);
    expect(facts.taskCandidates.map((t) => t.text)).toEqual(["Fix the login bug"]);
  });

  test("a never-resumed session (only live prompts) still reports title, counts, tasks", () => {
    const facts = parseRecords([
      { type: "system", subtype: "init", session_id: "s131b", cwd: "/Users/you/proj" },
      { type: "user", uuid: "u1", timestamp: "2026-06-01T00:00:01.000Z", message: { content: [{ type: "text", text: "Add a dark mode toggle" }] } },
      { type: "assistant", timestamp: "2026-06-01T00:00:02.000Z", message: { id: "a1", model: "claude-sonnet-4-6", usage: { input_tokens: 1 }, content: [{ type: "text", text: "Sure." }] } },
      { type: "user", uuid: "u2", timestamp: "2026-06-01T00:00:03.000Z", message: { content: [{ type: "text", text: "Also persist the preference" }] } },
      { type: "assistant", timestamp: "2026-06-01T00:00:04.000Z", message: { id: "a2", model: "claude-sonnet-4-6", usage: { input_tokens: 1 }, content: [{ type: "text", text: "Done." }] } },
    ]);
    const session = facts.sessions[0]!;
    expect(session.firstPrompt).toBe("Add a dark mode toggle");
    expect(session.userMessages).toBe(2);
    expect(session.agentMessages).toBe(2);
    expect(facts.taskCandidates.map((t) => t.text)).toEqual([
      "Add a dark mode toggle",
      "Also persist the preference",
    ]);
  });

  test("an opening prompt logged before system/init is not lost", () => {
    // The desktop app sometimes logs the first prompt as the very first record, ahead of init.
    const facts = parseRecords([
      { type: "user", uuid: "u1", timestamp: "2026-06-01T00:00:00.500Z", message: { content: [{ type: "text", text: "Set up the project" }] } },
      { type: "system", subtype: "init", session_id: "s131d", cwd: "/Users/you/proj" },
      { type: "assistant", timestamp: "2026-06-01T00:00:01.000Z", message: { id: "a1", model: "claude-sonnet-4-6", usage: { input_tokens: 1 }, content: [{ type: "text", text: "Will do." }] } },
    ]);
    const session = facts.sessions[0]!;
    expect(session.firstPrompt).toBe("Set up the project");
    expect(session.userMessages).toBe(1);
    expect(session.agentMessages).toBe(1);
    expect(facts.taskCandidates.map((t) => t.text)).toEqual(["Set up the project"]);
  });

  test("a truly bare queued event (no isReplay, no timestamp) is still skipped", () => {
    const facts = parseRecords([
      { type: "system", subtype: "init", session_id: "s131c", cwd: "/Users/you/proj" },
      // Bare placeholder: no isReplay and no timestamp/_audit_timestamp — not a real turn.
      { type: "user", uuid: "u0", message: { content: [{ type: "text", text: "queued placeholder" }] } },
      { type: "user", uuid: "u1", timestamp: "2026-06-01T00:00:01.000Z", message: { content: [{ type: "text", text: "the real prompt" }] } },
      { type: "assistant", timestamp: "2026-06-01T00:00:02.000Z", message: { id: "a1", model: "claude-sonnet-4-6", usage: { input_tokens: 1 }, content: [{ type: "text", text: "ok" }] } },
    ]);
    const session = facts.sessions[0]!;
    expect(session.firstPrompt).toBe("the real prompt");
    expect(session.userMessages).toBe(1);
    expect(facts.taskCandidates.map((t) => t.text)).toEqual(["the real prompt"]);
  });
});

describe("discoverCoworkTranscripts", () => {
  test("finds only audit.jsonl files across the 3-level hierarchy", () => {
    const result = discoverCoworkTranscripts(FIX);
    expect(result.status).toBe("complete");
    expect(result.source).toBe("cowork");
    expect(result.files).toHaveLength(3);
    // All discovered files should be named audit.jsonl
    for (const f of result.files) {
      expect(f.file.path).toEndWith("audit.jsonl");
      expect(f.file.source).toBe("cowork");
      expect(f.file.role).toBe("transcript");
    }
  });

  test("returns missing status when directory does not exist", () => {
    const result = discoverCoworkTranscripts("/nonexistent/path");
    expect(result.status).toBe("missing");
    expect(result.files).toHaveLength(0);
  });

});

describe("parseCoworkTranscriptFile", () => {
  function discoverOne(relPath: string) {
    const result = discoverCoworkTranscripts(FIX);
    const file = result.files.find((f) => f.file.relativePath.includes(relPath));
    if (!file) throw new Error(`Fixture not found: ${relPath}`);
    return file;
  }

  describe("session-111 (with userSelectedFolders, multi-turn)", () => {
    test("parses exactly one session with inner session ID", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      expect(result.status).toBe("current");
      if (result.status !== "current") return;
      const { sessions } = result.fragment.facts;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.sourceSessionId).toBe("cowork:inner-session-id-111");
      expect(sessions[0]!.source).toBe("cowork");
      expect(sessions[0]!.kind).toBe("main");
    });

    test("sets cwd from userSelectedFolders", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const session = result.fragment.facts.sessions[0]!;
      expect(session.cwd).toBe("/Users/test/Projects/myapp");
      expect(session.rawProjectId).toBeUndefined();
    });

    test("emits two assistant messages (deduplicated streaming)", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const { messages } = result.fragment.facts;
      expect(messages).toHaveLength(2);
      expect(messages[0]!.providerMessageId).toBe("msg_aaa1");
      expect(messages[1]!.providerMessageId).toBe("msg_aaa2");
    });

    test("multi-line streaming: stop_reason from continuation line", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const msg2 = result.fragment.facts.messages.find((m) => m.providerMessageId === "msg_aaa2");
      expect(msg2?.stopReason).toBe("tool_use");
    });

    test("usage is normalized from message.usage", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const msg1 = result.fragment.facts.messages.find((m) => m.providerMessageId === "msg_aaa1")!;
      expect(msg1.usage.input).toBe(100);
      expect(msg1.usage.output).toBe(50);
      expect(msg1.usage.cacheRead).toBe(0);
    });

    test("friction: two result records → two turn events, one rejection", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const session = result.fragment.facts.sessions[0]!;
      const events = session.frictionEvents ?? [];
      const turns = events.filter((e) => e.kind === "turn");
      const rejections = events.filter((e) => e.kind === "rejection");
      expect(turns).toHaveLength(2);
      // First turn: 2000ms, second: 3000ms
      expect(turns[0]!.durationMs).toBe(2000);
      expect(turns[1]!.durationMs).toBe(3000);
      // Second result record has permission_denials: 1
      expect(rejections).toHaveLength(1);
    });

    test("tool_result facts come only from the user turn that carries them", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      // Only the tool_result user turn produces a tool result fact; the prompt turns carry none.
      const { toolResults } = result.fragment.facts;
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.invocationId).toBe("tool_1");
    });

    test("live and replayed copies of a turn collapse to one task candidate (#131)", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      // Each prompt appears as a live event and a replayed copy sharing a uuid; dedup keeps one.
      expect(result.fragment.facts.taskCandidates.map((task) => task.text)).toEqual([
        "Hello",
        "Do something",
      ]);
      expect(result.fragment.facts.taskCandidates.map((task) => task.timestampMs)).toEqual([
        Date.parse("2026-05-23T10:00:01.000Z"),
        Date.parse("2026-05-23T10:00:11.000Z"),
      ]);
      expect(result.fragment.facts.tasks).toEqual([]);
    });

    test("sets firstPrompt and user/agent/turn counts from real prompts (#131)", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const session = result.fragment.facts.sessions[0]!;
      expect(session.firstPrompt).toBe("Hello");
      // Two human turns (Hello, Do something) — live + replayed copies collapse by uuid.
      expect(session.userMessages).toBe(2);
      // Two assistant messages (msg_aaa1, msg_aaa2), deduped across streaming records.
      expect(session.agentMessages).toBe(2);
      expect(session.rawTurns).toBe(2);
    });

    test("a single live (non-replayed) prompt marker is emitted per turn (#131)", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const prompts = result.fragment.facts.prompts ?? [];
      expect(prompts).toHaveLength(2);
      expect(prompts.every((p) => p.initiator === "human")).toBe(true);
    });

    test("thinking_tokens records are skipped", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      // thinking_tokens should not create any facts; 2 messages, 1 session, 1 invocation, 1 tool result
      expect(result.fragment.facts.sessions).toHaveLength(1);
      expect(result.fragment.facts.messages).toHaveLength(2);
    });

    test("subsequent system/init records do not create extra sessions", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      // There are 2 system/init records in the fixture; only first should create a session.
      expect(result.fragment.facts.sessions).toHaveLength(1);
    });

    test("invocations are emitted for tool_use content blocks", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const { invocations } = result.fragment.facts;
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.name).toBe("Bash");
      expect(invocations[0]!.source).toBe("cowork");
    });

    test("no relationships emitted (no subagents in Cowork)", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      expect(result.fragment.facts.relationships).toHaveLength(0);
    });
  });

  describe("session-222 (sandboxed, empty userSelectedFolders)", () => {
    test("rawProjectId set from title when no userSelectedFolders", () => {
      const file = discoverOne("session-222");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const session = result.fragment.facts.sessions[0]!;
      expect(session.cwd).toBeUndefined();
      expect(session.rawProjectId).toBe("Sandbox exploration");
    });

    test("permission_denials: 2 → two rejection friction events", () => {
      const file = discoverOne("session-222");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const rejections = (result.fragment.facts.sessions[0]!.frictionEvents ?? []).filter(
        (e) => e.kind === "rejection",
      );
      expect(rejections).toHaveLength(2);
    });
  });

  describe("session-333 (different org/team, cache tokens)", () => {
    test("session has correct sourceSessionId", () => {
      const file = discoverOne("session-333");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      expect(result.fragment.facts.sessions[0]!.sourceSessionId).toBe(
        "cowork:inner-session-id-333",
      );
    });

    test("cache tokens are normalized correctly", () => {
      const file = discoverOne("session-333");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      const msg = result.fragment.facts.messages[0]!;
      expect(msg.usage.input).toBe(300);
      expect(msg.usage.output).toBe(120);
      expect(msg.usage.cacheRead).toBe(100);
      expect(msg.usage.cacheWrite5m).toBe(50);
      expect(msg.usage.cacheWrite1h).toBe(0);
    });
  });

  describe("parser descriptor", () => {
    test("fragment carries cowork parser descriptor", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      expect(result.fragment.parser.source).toBe("cowork");
      expect(result.fragment.parser.name).toBe("cowork-jsonl");
    });
  });
});
