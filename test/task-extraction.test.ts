import { describe, expect, test } from "bun:test";
import {
  assignChapters,
  buildTaskExtractionPrompt,
  buildTaskOutcomePrompt,
  claudeProviderArgs,
  extractTasksForSession,
  judgeTaskOutcome,
  parseTaskExtractionOutput,
  parseTaskOutcomeOutput,
  splitCommand,
  taskFactsFromSpecs,
} from "../src/indexing/interpret/task-extraction.ts";
import type { TaskCandidateFact, TaskFact } from "../src/store/store-contract.ts";

const candidates: TaskCandidateFact[] = [
  {
    id: "candidate:0",
    source: "codex",
    sourceSessionId: "codex:one",
    timestampMs: Date.parse("2026-06-11T15:00:00.000Z"),
    text: "add a facts command",
    position: { originKey: "file:codex-one", recordIndex: 2, itemIndex: 0 },
  },
  {
    id: "candidate:1",
    source: "codex",
    sourceSessionId: "codex:one",
    text: "also make it configurable",
    position: { originKey: "file:codex-one", recordIndex: 4, itemIndex: 0 },
  },
];

describe("task extraction", () => {
  test("builds a prompt with indexed filtered user messages", () => {
    const prompt = buildTaskExtractionPrompt("codex:one", candidates, "Return JSON.");
    expect(prompt).toContain("Return JSON.");
    expect(prompt).toContain('"sessionId": "codex:one"');
    expect(prompt).toContain('"index": 0');
    expect(prompt).toContain('"text": "add a facts command"');
  });

  test("parses JSON task output and markdown-fenced JSON", () => {
    expect(
      parseTaskExtractionOutput(
        '```json\n{"tasks":[{"description":"Add task extraction","messageIndexes":[0,"1",-1]}]}\n```',
      ),
    ).toEqual([{ description: "Add task extraction", messageIndexes: [0, 1] }]);
    expect(parseTaskExtractionOutput('[{"description":"Fix tests","message_indices":[0]}]')).toEqual([
      { description: "Fix tests", messageIndexes: [0] },
    ]);
  });

  test("turns extracted specs into derived task facts", () => {
    const facts = taskFactsFromSpecs("codex:one", candidates, [
      { description: "Add configurable task extraction", messageIndexes: [1, 0, 20] },
    ]);
    expect(facts).toEqual([
      expect.objectContaining({
        source: "codex",
        sourceSessionId: "codex:one",
        timestampMs: Date.parse("2026-06-11T15:00:00.000Z"),
        description: "Add configurable task extraction",
        evidence: "message indexes: 0, 1",
        evidenceKind: "llm_inference",
        position: expect.objectContaining({ recordIndex: 2 }),
      }),
    ]);
  });

  test("emits debug logs through the configured sink", async () => {
    const logs: string[] = [];
    const result = await extractTasksForSession("codex:one", candidates, {
      provider: "off",
      debugLog: (message) => logs.push(message),
    });
    expect(result).toEqual({ tasks: [], diagnostics: [] });
    expect(logs.join("\n")).toContain("[task extraction] starting extraction for codex:one");
    expect(logs.join("\n")).toContain("provider=off");
    expect(logs.join("\n")).toContain("task extraction is off");
  });

  test("claude provider runs without session persistence, on haiku by default", () => {
    // --bare is intentionally absent: in -p mode it fails "Not logged in".
    expect(claudeProviderArgs(undefined)).toEqual([
      "-p",
      "--no-session-persistence",
      "--model",
      "haiku",
      "-",
    ]);
    // A configured model overrides the default; the flag stays on.
    expect(claudeProviderArgs({ model: "opus" })).toEqual([
      "-p",
      "--no-session-persistence",
      "--model",
      "opus",
      "-",
    ]);
  });

  test("splits custom provider commands without invoking a shell", () => {
    expect(splitCommand('"/tmp/task runner.js" --model "fast model"')).toEqual([
      "/tmp/task runner.js",
      "--model",
      "fast model",
    ]);
  });
});

describe("task outcome (pass 2)", () => {
  test("parses outcome JSON, defaulting unknown enums and dropping blank fields", () => {
    expect(
      parseTaskOutcomeOutput(
        '```json\n{"outcome":"success","frustration":"high","signals":["no access",""],"reason":"shipped"}\n```',
      ),
    ).toEqual({ outcome: "success", frustration: "high", signals: ["no access"], outcomeReason: "shipped" });
    // Unknown/missing enums fall back to the safe defaults; no signals/reason → omitted.
    expect(parseTaskOutcomeOutput('{"outcome":"weird"}')).toEqual({ outcome: "unclear", frustration: "none" });
  });

  test("builds a prompt carrying the task and role-tagged dialogue", () => {
    const prompt = buildTaskOutcomePrompt("Add a facts command", [
      { role: "user", text: "add it", timestampMs: 1 },
      { role: "assistant", text: "done", timestampMs: 2 },
    ]);
    expect(prompt).toContain("Task: Add a facts command");
    expect(prompt).toContain('"role": "user"');
    expect(prompt).toContain('"text": "done"');
    // Timestamps are an internal alignment detail — not sent to the judge.
    expect(prompt).not.toContain("timestampMs");
  });

  test("judgeTaskOutcome short-circuits with no provider or no dialogue", async () => {
    expect(await judgeTaskOutcome("t", [{ role: "user", text: "x" }], { provider: "off" })).toEqual({
      diagnostics: [],
    });
    expect(await judgeTaskOutcome("t", [], { provider: "claude" })).toEqual({ diagnostics: [] });
  });
});

describe("assignChapters", () => {
  function task(id: string, timestampMs?: number): TaskFact {
    return {
      id,
      source: "codex",
      sourceSessionId: "codex:chapters",
      description: id,
      evidence: "",
      evidenceKind: "llm_inference",
      position: { originKey: "f", recordIndex: 0, itemIndex: 0 },
      ...(timestampMs != null ? { timestampMs } : {}),
    };
  }

  test("bookmarks the timeline: each message joins the latest task started at/before it", () => {
    const tasks = [task("a", 100), task("b", 300)];
    // Message timestamps by reconciled seq (ascending). seq 0 precedes any task.
    assignChapters(tasks, [50, 120, 200, 350, 400]);
    expect(tasks[0]!.chapter).toEqual({ startSeq: 1, endSeq: 2 }); // task a owns [120,200]
    expect(tasks[1]!.chapter).toEqual({ startSeq: 3, endSeq: 4 }); // task b owns [350,400]
  });

  test("tasks without a timestamp get no chapter", () => {
    const tasks = [task("a")];
    assignChapters(tasks, [100, 200]);
    expect(tasks[0]!.chapter).toBeUndefined();
  });
});
