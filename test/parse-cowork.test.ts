import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  discoverCoworkTranscripts,
  parseCoworkTranscriptFile,
} from "../src/producers/cowork/parser.ts";

const FIX = join(import.meta.dir, "fixtures", "cowork-sessions");

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

    test("bare user message (no isReplay) is skipped", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
      // Only the isReplay=true user messages produce tool result facts.
      // The bare user message carries no tool_result, so toolResults = 1 (from the second turn).
      const { toolResults } = result.fragment.facts;
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.invocationId).toBe("tool_1");
    });

    test("emits task candidates from replayed user messages without duplicating bare events", () => {
      const file = discoverOne("session-111");
      const result = parseCoworkTranscriptFile(file);
      if (result.status !== "current") throw new Error("parse failed");
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
