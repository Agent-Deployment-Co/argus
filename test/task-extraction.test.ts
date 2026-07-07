import { describe, expect, test } from "bun:test";
import {
  buildTaskExtractionPrompt,
  buildTaskOutcomePrompt,
  extractTasksForSession,
  judgeTaskOutcome,
  parseTaskExtractionOutput,
  parseTaskOutcomeOutput,
  summarizeToolUsage,
  taskFactsFromSpecs,
} from "../src/indexing/interpret/task-extraction.ts";
import type { SessionInvocation } from "../src/store/store-contract.ts";
import { claudeProviderArgs, splitCommand } from "../src/llm/providers/local.ts";
import type { ResolvedSessionInterpretation } from "../src/config.ts";
import {
  assignInteractionTaskSeqs,
  type InteractionFact,
  type TaskFact,
} from "../src/store/store-contract.ts";

/** Build a ResolvedSessionInterpretation for a test, defaulting `enabled` on. */
function te(over: Partial<ResolvedSessionInterpretation> & { llm: ResolvedSessionInterpretation["llm"] }): ResolvedSessionInterpretation {
  return { enabled: true, maxSessionsPerHour: 30, titleMaxChars: 100, summaryMaxChars: 500, ...over };
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

  test("includes assistant responses as grounding and states the title/summary limits (#234)", () => {
    const withResponse = [candidate(0, "add a facts command", undefined, "shipped the facts command")];
    const prompt = buildTaskExtractionPrompt("codex:one", withResponse, "Return JSON.", {
      titleMaxChars: 80,
      summaryMaxChars: 400,
    });
    expect(prompt).toContain('"response": "shipped the facts command"');
    expect(prompt).toContain("at most 80 characters");
    expect(prompt).toContain("at most 400 characters");
  });

  test("truncates a huge response head+tail so it can't blow the prompt (#234)", () => {
    const huge = "A".repeat(25_000) + "B".repeat(25_000);
    const prompt = buildTaskExtractionPrompt("codex:one", [candidate(0, "do it", undefined, huge)], "Return JSON.");
    expect(prompt).toContain("chars elided"); // head+tail elision marker
    expect(prompt).not.toContain("A".repeat(2000)); // the full 50KB response is not embedded
    expect(prompt).toContain("B"); // the tail (conclusion) survives, not just the head
    expect(prompt).toContain('"text": "do it"'); // the user prompt is intact
  });

  test("bounds the whole prompt for a many-message session without dropping any message (#234)", () => {
    // 400 messages, each with a large prompt + response — no per-message cap alone would bound this.
    const many = Array.from({ length: 400 }, (_, i) =>
      candidate(i, `task ${i}: ` + "p".repeat(3000), undefined, "r".repeat(3000)),
    );
    const prompt = buildTaskExtractionPrompt("codex:one", many, "Return JSON.");
    // The assembled text stays near the budget (marker overhead aside), not ~2.4MB of raw content.
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(120_000);
    // Every message keeps its index slot with real text — an interior pivot is never dropped.
    expect(prompt).toContain('"index": 0');
    expect(prompt).toContain('"index": 399');
    expect(prompt).toContain("task 399:");
  });

  test("parses title/summary/tasks JSON and markdown-fenced JSON (#234)", () => {
    expect(
      parseTaskExtractionOutput(
        '```json\n{"title":"Add a facts command","summary":"The user asked for X and got it.","tasks":[{"description":"Add task extraction","messageIndexes":[0,"1",-1]}]}\n```',
      ),
    ).toEqual({
      title: "Add a facts command",
      summary: "The user asked for X and got it.",
      tasks: [{ description: "Add task extraction", messageIndexes: [0, 1] }],
    });
    // A bare array is the legacy tasks-only shape: title/summary come back empty.
    expect(parseTaskExtractionOutput('[{"description":"Fix tests","message_indices":[0]}]')).toEqual({
      title: "",
      summary: "",
      tasks: [{ description: "Fix tests", messageIndexes: [0] }],
    });
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
    const result = await extractTasksForSession("codex:one", candidates, te({ llm: { provider: "off" }, log: (message) => logs.push(message) }));
    expect(result).toEqual({ title: "", summary: "", tasks: [], diagnostics: [] });
    expect(logs.join("\n")).toContain("[task extraction] starting interpretation for codex:one");
    expect(logs.join("\n")).toContain("provider=off");
    expect(logs.join("\n")).toContain("session interpretation is off");
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
    // Effort is passed through as --effort only when set (#234).
    expect(claudeProviderArgs("opus", "high")).toEqual([
      "-p",
      "--no-session-persistence",
      "--model",
      "opus",
      "--effort",
      "high",
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

  test("includes the mechanical tool-usage summary when provided (#234)", () => {
    const prompt = buildTaskOutcomePrompt(
      "Add a facts command",
      [candidate(0, "add it", undefined, "done")],
      undefined,
      "18 tool calls: 6× Edit, 5× Bash; 4 files edited.",
    );
    expect(prompt).toContain("Tool usage (mechanical summary, not narration):");
    expect(prompt).toContain("18 tool calls: 6× Edit, 5× Bash; 4 files edited.");
  });

  test("summarizeToolUsage formats a deterministic one-liner (#234)", () => {
    const inv = (tool: string, filePath?: string): SessionInvocation => ({
      interactionSeq: 0,
      tool,
      category: "file-io",
      ...(filePath ? { filePath } : {}),
    });
    const invocations: SessionInvocation[] = [
      inv("Edit", "a.ts"),
      inv("Edit", "a.ts"),
      inv("Edit", "b.ts"),
      inv("Bash"),
      inv("Bash"),
      inv("Read"),
    ];
    // Ranked by count desc; distinct edited files counted; trailing period.
    expect(summarizeToolUsage(invocations)).toBe(
      "6 tool calls: 3× Edit, 2× Bash, 1× Read; 2 files edited.",
    );
    expect(summarizeToolUsage([])).toBe("");
  });

  test("judgeTaskOutcome short-circuits with no provider or no dialogue", async () => {
    // Provider off short-circuits even with text; no-text interactions short-circuit even with a provider.
    expect(await judgeTaskOutcome("t", [candidate(0, "x")], te({ llm: { provider: "off" } }))).toEqual({
      diagnostics: [],
    });
    expect(await judgeTaskOutcome("t", [], te({ llm: { provider: "claude-cli" } }))).toEqual({ diagnostics: [] });
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
