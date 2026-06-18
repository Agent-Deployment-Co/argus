import { describe, expect, test } from "bun:test";
import {
  buildTaskExtractionPrompt,
  extractTasksForSession,
  parseTaskExtractionOutput,
  splitCommand,
  taskFactsFromSpecs,
} from "../src/task-extraction.ts";
import type { TaskCandidateFact } from "../src/store-contract.ts";

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

  test("splits custom provider commands without invoking a shell", () => {
    expect(splitCommand('"/tmp/task runner.js" --model "fast model"')).toEqual([
      "/tmp/task runner.js",
      "--model",
      "fast model",
    ]);
  });
});
