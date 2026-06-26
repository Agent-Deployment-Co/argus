import { describe, expect, test } from "bun:test";
import {
  buildTaskExtractionPrompt,
  buildTaskOutcomePrompt,
  extractTasksForSession,
  judgeTaskOutcome,
  parseTaskExtractionOutput,
  parseTaskOutcomeOutput,
  taskFactsFromSpecs,
} from "../src/indexing/interpret/task-extraction.ts";
import { claudeProviderArgs, splitCommand } from "../src/llm/providers/local.ts";
import type { ResolvedTaskExtraction } from "../src/config.ts";
import {
  assignInteractionTaskSeqs,
  type InteractionFact,
  type TaskFact,
} from "../src/store/store-contract.ts";

/** Build a ResolvedTaskExtraction for a test, defaulting `enabled` on. */
function te(over: Partial<ResolvedTaskExtraction> & { llm: ResolvedTaskExtraction["llm"] }): ResolvedTaskExtraction {
  return { enabled: true, ...over };
}

// Pass-1 input is the session's human interaction openings (#122) — each carrying its prompt text.
function candidate(seq: number, promptText: string, timestampMs?: number, responseText?: string): InteractionFact {
  return {
    id: `i${seq}`,
    source: "codex",
    sourceSessionId: "codex:one",
    seq,
    initiator: "human",
    disposition: "completed",
    compactionCount: 0,
    promptPosition: { originKey: "file:codex-one", recordIndex: 2 + seq * 2, itemIndex: 0 },
    position: { originKey: "file:codex-one", recordIndex: 2 + seq * 2, itemIndex: 0 },
    promptText,
    ...(timestampMs != null ? { timestampMs } : {}),
    ...(responseText != null ? { responseText } : {}),
  };
}
const candidates: InteractionFact[] = [
  candidate(0, "add a facts command", Date.parse("2026-06-11T15:00:00.000Z")),
  candidate(1, "also make it configurable"),
];

describe("task extraction", () => {
  test("builds a prompt with indexed task prompts", () => {
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

  test("turns extracted specs into derived task facts anchored to interactions", () => {
    const facts = taskFactsFromSpecs("codex:one", candidates, [
      { description: "Add configurable task extraction", messageIndexes: [1, 0, 20] },
    ]);
    expect(facts).toEqual([
      expect.objectContaining({
        source: "codex",
        sourceSessionId: "codex:one",
        timestampMs: Date.parse("2026-06-11T15:00:00.000Z"),
        description: "Add configurable task extraction",
        evidence: "interactions: 0, 1",
        evidenceKind: "llm_inference",
        position: expect.objectContaining({ recordIndex: 2 }),
      }),
    ]);
  });

  test("drops a spec the model couldn't anchor to any valid prompt index (#122)", () => {
    expect(
      taskFactsFromSpecs("codex:one", candidates, [
        { description: "unanchored", messageIndexes: [] },
        { description: "bogus indexes", messageIndexes: [9, -1] },
      ]),
    ).toEqual([]);
  });

  test("emits debug logs through the configured sink", async () => {
    const logs: string[] = [];
    const result = await extractTasksForSession("codex:one", candidates, te({ llm: { provider: "off" }, debugLog: (message) => logs.push(message) }));
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
    expect(claudeProviderArgs("opus")).toEqual([
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

  test("builds a prompt carrying the task and the interactions' prompt/response dialogue", () => {
    const prompt = buildTaskOutcomePrompt("Add a facts command", [candidate(0, "add it", undefined, "done")]);
    expect(prompt).toContain("Task: Add a facts command");
    expect(prompt).toContain('"role": "user"');
    expect(prompt).toContain('"text": "done"');
  });

  test("judgeTaskOutcome short-circuits with no provider or no dialogue", async () => {
    // Provider off short-circuits even with text; no-text interactions short-circuit even with a provider.
    expect(await judgeTaskOutcome("t", [candidate(0, "x")], te({ llm: { provider: "off" } }))).toEqual({
      diagnostics: [],
    });
    expect(await judgeTaskOutcome("t", [], te({ llm: { provider: "claude" } }))).toEqual({ diagnostics: [] });
  });
});

describe("assignInteractionTaskSeqs", () => {
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
  function interaction(seq: number, timestampMs?: number): InteractionFact {
    return {
      id: `i${seq}`,
      source: "codex",
      sourceSessionId: "codex:chapters",
      seq,
      initiator: "human",
      disposition: "completed",
      compactionCount: 0,
      promptPosition: { originKey: "f", recordIndex: seq, itemIndex: 0 },
      position: { originKey: "f", recordIndex: seq, itemIndex: 0 },
      ...(timestampMs != null ? { timestampMs } : {}),
    };
  }

  test("bookmarks the timeline: each interaction joins the latest task started at/before it", () => {
    const tasks = [task("a", 100), task("b", 300)];
    // Interactions in seq order; interaction 0 (ts 50) precedes any task → unassigned.
    const map = assignInteractionTaskSeqs(tasks, [
      interaction(0, 50),
      interaction(1, 120),
      interaction(2, 200),
      interaction(3, 350),
    ]);
    expect(map.get(0)).toBeUndefined(); // before task a
    expect(map.get(1)).toBe(0); // task a (index 0)
    expect(map.get(2)).toBe(0); // still task a
    expect(map.get(3)).toBe(1); // task b (index 1)
  });

  test("interactions/tasks without a timestamp are unattributed", () => {
    expect(assignInteractionTaskSeqs([task("a")], [interaction(0, 100)]).size).toBe(0);
    expect(assignInteractionTaskSeqs([task("a", 100)], [interaction(0)]).size).toBe(0);
  });
});
