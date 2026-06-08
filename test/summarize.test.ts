import { describe, expect, test } from "bun:test";
import { heuristicSummary } from "../src/summarize.ts";

describe("heuristicSummary", () => {
  test("includes prompt, skills, top tools, and file count", () => {
    const s = heuristicSummary({
      firstPrompt: "do the thing",
      topSkills: ["jj:jj", "review"],
      toolCounts: { Bash: 3, Read: 2, Skill: 9 },
      filesTouched: ["a.ts", "b.ts"],
    });
    expect(s).toContain("do the thing");
    expect(s).toContain("jj:jj");
    expect(s).toContain("3×Bash"); // Skill is excluded from the "top tools" list
    expect(s).not.toContain("Skill");
    expect(s).toContain("2 file(s) edited");
  });

  test("handles an empty session", () => {
    expect(heuristicSummary({ firstPrompt: "", topSkills: [], toolCounts: {}, filesTouched: [] })).toBe(
      "(no activity recorded)",
    );
  });
});
