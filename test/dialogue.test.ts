import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sliceDialogueByTime, type DialogueTurn } from "../src/indexing/interpret/dialogue.ts";
import { claudeProducer } from "../src/indexing/parse/producers/claude/index.ts";
import { codexProducer } from "../src/indexing/parse/producers/codex/index.ts";
import { coworkProducer } from "../src/indexing/parse/producers/cowork/index.ts";
import { geminiProducer } from "../src/indexing/parse/producers/gemini/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-dialogue-"));
  dirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return path;
}

describe("producer.reconstructDialogue", () => {
  test("claude: text turns only, tool noise stripped, assistant deduped by id", () => {
    const path = transcript([
      { type: "user", timestamp: "2026-06-01T00:00:00Z", message: { content: "add a facts command" } },
      {
        type: "assistant",
        timestamp: "2026-06-01T00:00:05Z",
        message: { id: "a1", content: [{ type: "text", text: "Done, added it." }, { type: "tool_use", name: "Edit" }] },
      },
      // Resumed-session replay of the same assistant message — must be deduped.
      { type: "assistant", timestamp: "2026-06-01T00:00:05Z", message: { id: "a1", content: [{ type: "text", text: "Done, added it." }] } },
      // Tool-result user turn is noise, not dialogue.
      { type: "user", timestamp: "2026-06-01T00:00:10Z", message: { content: [{ type: "tool_result", content: "ok" }] } },
    ]);
    expect(claudeProducer.reconstructDialogue(path)).toEqual([
      { role: "user", text: "add a facts command", timestampMs: Date.parse("2026-06-01T00:00:00Z") },
      { role: "assistant", text: "Done, added it.", timestampMs: Date.parse("2026-06-01T00:00:05Z") },
    ]);
  });

  test("claude/cowork: assistant message split across tool-use then text records keeps the answer", () => {
    // A single assistant message (one id) often spans records: a tool_use record with no dialogue
    // text, then the record with the answer. The text record must not be dropped as a "duplicate"
    // of the (empty) tool-use record — that made pass-2 think the assistant never replied.
    const lines = [
      { type: "user", timestamp: "2026-06-01T00:00:00Z", message: { content: "briefly research how llms do math" } },
      { type: "assistant", timestamp: "2026-06-01T00:00:05Z", message: { id: "a1", content: [{ type: "tool_use", name: "WebSearch" }] } },
      { type: "assistant", timestamp: "2026-06-01T00:00:09Z", message: { id: "a1", content: [{ type: "text", text: "Here's the short version." }] } },
      { type: "user", timestamp: "2026-06-01T00:00:20Z", message: { content: "ok thanks" } },
    ];
    const expected: DialogueTurn[] = [
      { role: "user", text: "briefly research how llms do math", timestampMs: Date.parse("2026-06-01T00:00:00Z") },
      { role: "assistant", text: "Here's the short version.", timestampMs: Date.parse("2026-06-01T00:00:09Z") },
      { role: "user", text: "ok thanks", timestampMs: Date.parse("2026-06-01T00:00:20Z") },
    ];
    expect(claudeProducer.reconstructDialogue(transcript(lines))).toEqual(expected);
    expect(coworkProducer.reconstructDialogue(transcript(lines))).toEqual(expected);
  });

  test("codex: payload-wrapped messages; environment context skipped", () => {
    const path = transcript([
      { timestamp: "2026-06-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "<environment_context>\ncwd: /x" }] } },
      { timestamp: "2026-06-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "add a facts command" }] } },
      { timestamp: "2026-06-01T00:00:05Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Added the command." }] } },
    ]);
    expect(codexProducer.reconstructDialogue(path)).toEqual([
      { role: "user", text: "add a facts command", timestampMs: Date.parse("2026-06-01T00:00:01Z") },
      { role: "assistant", text: "Added the command.", timestampMs: Date.parse("2026-06-01T00:00:05Z") },
    ]);
  });

  test("gemini: replays user + gemini(assistant) records into turns", () => {
    const path = transcript([
      { sessionId: "g1", projectHash: "ph" },
      { id: "m1", type: "user", timestamp: "2026-06-01T00:00:00Z", content: "fix the bug" },
      { id: "m2", type: "gemini", timestamp: "2026-06-01T00:00:05Z", content: [{ type: "text", text: "Fixed it." }] },
    ]);
    expect(geminiProducer.reconstructDialogue(path)).toEqual([
      { role: "user", text: "fix the bug", timestampMs: Date.parse("2026-06-01T00:00:00Z") },
      { role: "assistant", text: "Fixed it.", timestampMs: Date.parse("2026-06-01T00:00:05Z") },
    ]);
  });

  test("cowork: claude-like, falls back to _audit_timestamp, skips replays", () => {
    const path = transcript([
      { type: "user", _audit_timestamp: "2026-06-01T00:00:00Z", message: { content: "deploy it" } },
      { type: "user", isReplay: true, _audit_timestamp: "2026-06-01T00:00:00Z", message: { content: "deploy it" } },
      { type: "assistant", timestamp: "2026-06-01T00:00:02Z", message: { id: "c1", content: [{ type: "text", text: "Deployed." }] } },
    ]);
    expect(coworkProducer.reconstructDialogue(path)).toEqual([
      { role: "user", text: "deploy it", timestampMs: Date.parse("2026-06-01T00:00:00Z") },
      { role: "assistant", text: "Deployed.", timestampMs: Date.parse("2026-06-01T00:00:02Z") },
    ]);
  });

  test("missing file → empty", () => {
    expect(claudeProducer.reconstructDialogue(join(tmpdir(), "nope.jsonl"))).toEqual([]);
  });
});

describe("sliceDialogueByTime", () => {
  const turns: DialogueTurn[] = [
    { role: "user", text: "a", timestampMs: 100 },
    { role: "assistant", text: "b", timestampMs: 150 },
    { role: "user", text: "c", timestampMs: 200 },
    { role: "user", text: "no ts" },
  ];

  test("half-open [start, end); undated turns omitted", () => {
    expect(sliceDialogueByTime(turns, 100, 200).map((t) => t.text)).toEqual(["a", "b"]);
    expect(sliceDialogueByTime(turns, 200).map((t) => t.text)).toEqual(["c"]);
  });
});
