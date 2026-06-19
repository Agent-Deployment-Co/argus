import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconstructDialogue, sliceDialogueByTime, type DialogueTurn } from "../src/dialogue.ts";

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

describe("reconstructDialogue", () => {
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
    expect(reconstructDialogue("claude", path)).toEqual([
      { role: "user", text: "add a facts command", timestampMs: Date.parse("2026-06-01T00:00:00Z") },
      { role: "assistant", text: "Done, added it.", timestampMs: Date.parse("2026-06-01T00:00:05Z") },
    ]);
  });

  test("codex: payload-wrapped messages; environment context skipped", () => {
    const path = transcript([
      { timestamp: "2026-06-01T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "text", text: "<environment_context>\ncwd: /x" }] } },
      { timestamp: "2026-06-01T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "text", text: "add a facts command" }] } },
      { timestamp: "2026-06-01T00:00:05Z", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Added the command." }] } },
    ]);
    expect(reconstructDialogue("codex", path)).toEqual([
      { role: "user", text: "add a facts command", timestampMs: Date.parse("2026-06-01T00:00:01Z") },
      { role: "assistant", text: "Added the command.", timestampMs: Date.parse("2026-06-01T00:00:05Z") },
    ]);
  });

  test("gemini: top-level content; type gemini is the assistant", () => {
    const path = transcript([
      { type: "user", timestamp: "2026-06-01T00:00:00Z", content: "fix the bug" },
      { type: "gemini", timestamp: "2026-06-01T00:00:05Z", content: [{ type: "text", text: "Fixed it." }] },
    ]);
    expect(reconstructDialogue("gemini", path)).toEqual([
      { role: "user", text: "fix the bug", timestampMs: Date.parse("2026-06-01T00:00:00Z") },
      { role: "assistant", text: "Fixed it.", timestampMs: Date.parse("2026-06-01T00:00:05Z") },
    ]);
  });

  test("cowork: claude-like, falls back to _audit_timestamp", () => {
    const path = transcript([
      { type: "user", _audit_timestamp: "2026-06-01T00:00:00Z", message: { content: "deploy it" } },
      { type: "assistant", timestamp: "2026-06-01T00:00:02Z", message: { id: "c1", content: [{ type: "text", text: "Deployed." }] } },
    ]);
    expect(reconstructDialogue("cowork", path)).toEqual([
      { role: "user", text: "deploy it", timestampMs: Date.parse("2026-06-01T00:00:00Z") },
      { role: "assistant", text: "Deployed.", timestampMs: Date.parse("2026-06-01T00:00:02Z") },
    ]);
  });

  test("missing file → empty", () => {
    expect(reconstructDialogue("claude", join(tmpdir(), "nope.jsonl"))).toEqual([]);
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
