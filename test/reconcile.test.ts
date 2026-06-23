import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  claudeHistoryFileIdentity,
  discoverClaudeTranscripts,
  parseClaudeTranscriptFile,
} from "../src/indexing/parse/producers/claude/parser.ts";
import { claudeProducer } from "../src/indexing/parse/producers/claude/index.ts";
import { reconcileSessions } from "../src/indexing/reconcile.ts";
import type { ParsedFileFragment } from "../src/store/store-contract.ts";

const PROJECTS = join(import.meta.dir, "fixtures", "projects");
const HISTORY = join(import.meta.dir, "fixtures", "history.jsonl");

function claudeFragments(): ParsedFileFragment[] {
  const discovery = discoverClaudeTranscripts(PROJECTS);
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
