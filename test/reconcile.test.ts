import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  claudeHistoryFileIdentity,
  discoverClaudeTranscripts,
  parseClaudeTranscriptFile,
} from "../src/indexing/parse/producers/claude/parser.ts";
import { claudeProducer } from "../src/indexing/parse/producers/claude/index.ts";
import { codexProducer } from "../src/indexing/parse/producers/codex/index.ts";
import { geminiProducer } from "../src/indexing/parse/producers/gemini/index.ts";
import { coworkProducer } from "../src/indexing/parse/producers/cowork/index.ts";
import {
  discoverCodexFiles,
  parseCodexTranscriptPath,
} from "../src/indexing/parse/producers/codex/parser.ts";
import {
  discoverGeminiTranscripts,
  parseGeminiTranscriptPath,
} from "../src/indexing/parse/producers/gemini/parser.ts";
import {
  discoverCoworkTranscripts,
  parseCoworkTranscriptPath,
} from "../src/indexing/parse/producers/cowork/parser.ts";
import {
  compareTimeline,
  reconcileSessions,
  seedMissingTimestamps,
  type ProducerCapabilities,
  type TimelineEntry,
} from "../src/indexing/reconcile.ts";
import type { DiscoveryResult, FileParseResult, ParsedFileFragment } from "../src/store/store-contract.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

function fragmentsFromDiscovery(
  discovery: DiscoveryResult,
  parsePath: (path: string) => FileParseResult,
): ParsedFileFragment[] {
  expect(discovery.status).toBe("complete");
  const fragments: ParsedFileFragment[] = [];
  for (const file of discovery.files) {
    const result = parsePath(file.file.path);
    if (result.status === "current") fragments.push(result.fragment);
  }
  return fragments;
}

function assertValidInteractions(caps: ProducerCapabilities, fragments: ParsedFileFragment[]) {
  const { interactions } = reconcileSessions({ caps, fragments, auxiliaryFragments: [] });
  expect(interactions.length).toBeGreaterThan(0);
  for (const interaction of interactions) {
    expect(["human", "agent", "harness"]).toContain(interaction.initiator);
    expect(["completed", "interrupted", "incomplete", "error"]).toContain(interaction.disposition);
    expect(interaction.promptPosition).toBeDefined();
    expect(interaction.seq).toBeGreaterThanOrEqual(0);
  }
  return interactions;
}

const PROJECTS = join(import.meta.dir, "fixtures", "projects");
const FRICTION_PROJECTS = join(import.meta.dir, "fixtures", "friction-projects");
const RESPONSE_TEXT_PROJECTS = join(import.meta.dir, "fixtures", "response-text-projects");
const HISTORY = join(import.meta.dir, "fixtures", "history.jsonl");

function claudeFragments(projectsDir = PROJECTS): ParsedFileFragment[] {
  const discovery = discoverClaudeTranscripts(projectsDir);
  expect(discovery.status).toBe("complete");
  const fragments: ParsedFileFragment[] = [];
  for (const file of discovery.files) {
    const result = parseClaudeTranscriptFile(file, {
      historyInputId: claudeHistoryFileIdentity(HISTORY).id,
    });
    if (result.status === "current") fragments.push(result.fragment);
  }
  return fragments;
}

describe("reconcile derives interactions (#117)", () => {
  const fragments = claudeFragments();
  const prompts = fragments.flatMap((f) => f.facts.prompts ?? []);
  const result = reconcileSessions({
    caps: claudeProducer.capabilities,
    fragments,
    auxiliaryFragments: [],
  });

  test("emits one interaction per human prompt, all human-initiated", () => {
    const humanPrompts = prompts.filter((p) => p.initiator === "human");
    expect(humanPrompts.length).toBeGreaterThan(0);
    expect(result.interactions.length).toBe(humanPrompts.length);
    for (const interaction of result.interactions) {
      expect(interaction.initiator).toBe("human");
      expect(["completed", "interrupted", "incomplete", "error"]).toContain(interaction.disposition);
      expect(interaction.promptPosition).toBeDefined();
      expect(interaction.compactionCount).toBeGreaterThanOrEqual(0);
    }
    // One session here (the subagent folds onto its parent), so seqs are a dense 0..n-1.
    expect(result.interactions.map((i) => i.seq).sort((a, b) => a - b)).toEqual(
      humanPrompts.map((_, i) => i),
    );
  });

  test("a completed interaction carries a response slot", () => {
    const completed = result.interactions.filter((i) => i.disposition === "completed");
    expect(completed.length).toBeGreaterThan(0);
    for (const interaction of completed) expect(interaction.responsePosition).toBeDefined();
  });
});

describe("interaction responseText captures the assistant's prose (#122)", () => {
  // resp1: one prompt; the answer streams as a same-id split — a `thinking` chunk carries the usage
  // (and wins dedup) while the `text` chunk carries "here is the answer" — and the interaction then
  // ends on a separate tool-only turn. Both the dedup drop and the trailing tool turn previously left
  // responseText empty, so outcome judging saw "no assistant response".
  const { interactions } = reconcileSessions({
    caps: claudeProducer.capabilities,
    fragments: claudeFragments(RESPONSE_TEXT_PROJECTS),
    auxiliaryFragments: [],
  });

  test("folds the deduped continuation text and isn't clobbered by a trailing tool turn", () => {
    expect(interactions.length).toBe(1);
    expect(interactions[0]!.disposition).toBe("completed");
    expect(interactions[0]!.responseText).toBe("here is the answer");
  });
});

describe("timeline ordering is a total order (#117)", () => {
  const entry = (originKey: string, recordIndex: number, ts: number): TimelineEntry => ({
    sid: "s",
    kind: ts === 0 ? "prompt" : "turn",
    ts,
    position: { originKey, recordIndex, itemIndex: 0 },
  });

  test("seeds a timestamp-less prompt from its preceding in-file entry, giving a stable order", () => {
    // The intransitive-comparator scenario from review: T (file F1, real ts), P (file F1, ts→0, later
    // record), C (file F2, ts between T and P's neighbours). Pre-seeding makes ts monotonic in F1.
    const T = entry("F1", 0, 500);
    const P = entry("F1", 1, 0); // timestamp-less prompt, later in the same file than T
    const C = entry("F2", 0, 250); // folded cross-file turn with a ts between
    const entries = [P, C, T];
    seedMissingTimestamps(entries);
    expect(P.ts).toBe(500); // inherited from the preceding in-file entry (T)
    entries.sort(compareTimeline);
    // Within F1, record order is preserved (T before P); C sorts by ts (250 < 500) ahead of both.
    expect(entries.map((e) => `${e.position.originKey}:${e.position.recordIndex}`)).toEqual([
      "F2:0",
      "F1:0",
      "F1:1",
    ]);
  });

  test("comparator is transitive across the seeded set (no cycle)", () => {
    const items = [entry("F1", 0, 500), entry("F1", 1, 0), entry("F2", 0, 250)];
    seedMissingTimestamps(items);
    // Verify a < b < c ⇒ a < c for every triple (would fail for the old intransitive comparator).
    const sorted = [...items].sort(compareTimeline);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        expect(compareTimeline(sorted[i]!, sorted[j]!)).toBeLessThanOrEqual(0);
        expect(compareTimeline(sorted[j]!, sorted[i]!)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("interaction disposition + compaction (#117)", () => {
  // The friction fixture's frict1 session has exactly one compaction (a compact_boundary + a
  // compact_summary marker) and human interruptions.
  const { interactions } = reconcileSessions({
    caps: claudeProducer.capabilities,
    fragments: claudeFragments(FRICTION_PROJECTS),
    auxiliaryFragments: [],
  });

  test("a single compaction counts once, not boundary+summary twice", () => {
    // Before the fix, the span holding both markers reported compactionCount: 2.
    expect(interactions.every((i) => i.compactionCount <= 1)).toBe(true);
    expect(interactions.reduce((n, i) => n + i.compactionCount, 0)).toBeGreaterThanOrEqual(1);
  });

  test("an interrupted loop is recorded as interrupted", () => {
    expect(interactions.some((i) => i.disposition === "interrupted")).toBe(true);
  });
});

describe("reconcile derives interactions across sources (#117)", () => {
  test("codex", () => {
    const fragments = fragmentsFromDiscovery(
      discoverCodexFiles(join(FIXTURES, "codex-sessions")),
      parseCodexTranscriptPath,
    );
    const interactions = assertValidInteractions(codexProducer.capabilities, fragments);
    expect(interactions.every((i) => i.initiator === "human")).toBe(true);
  });

  test("cowork", () => {
    const fragments = fragmentsFromDiscovery(
      discoverCoworkTranscripts(join(FIXTURES, "cowork-sessions")),
      parseCoworkTranscriptPath,
    );
    assertValidInteractions(coworkProducer.capabilities, fragments);
  });

  test("gemini", () => {
    const fragments = fragmentsFromDiscovery(
      discoverGeminiTranscripts(join(FIXTURES, "gemini")),
      parseGeminiTranscriptPath,
    );
    assertValidInteractions(geminiProducer.capabilities, fragments);
  });
});
