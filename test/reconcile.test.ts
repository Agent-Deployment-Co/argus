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
import { reconcileSessions, type ProducerCapabilities } from "../src/indexing/reconcile.ts";
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
