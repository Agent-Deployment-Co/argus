import { describe, expect, test } from "bun:test";
import { shouldSkipTaskCandidateText } from "../src/task-candidates.ts";

describe("task candidate filtering", () => {
  test("skips Argus task extraction prompts so embedded source sessions are not re-extracted", () => {
    const text = `You identify the actual tasks a user was trying to accomplish in a coding-agent session.

Return JSON only.

Filtered user messages:
{
  "sessionId": "codex:019ed69b-6e39-7631-ba51-3131851b31ea",
  "messages": [
    {
      "index": 0,
      "text": "add a facts command"
    }
  ]
}`;

    expect(shouldSkipTaskCandidateText(text)).toBe(true);
  });

  test("skips custom task extraction prompts with the generated filtered-message payload", () => {
    const text = `Pick tasks from this data.

Filtered user messages:
{
  "sessionId": "claude:one",
  "messages": [
    { "index": 0, "text": "fix the bug" }
  ]
}`;

    expect(shouldSkipTaskCandidateText(text)).toBe(true);
  });

  test("keeps ordinary task text", () => {
    expect(shouldSkipTaskCandidateText("add task extraction to the session screen")).toBe(false);
  });
});
