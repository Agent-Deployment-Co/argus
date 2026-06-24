import { describe, expect, test } from "bun:test";
import {
  argusGeneratedPromptTitle,
  isCountableClaudeUserMessage,
  sessionAnalysisPromptTitle,
  shouldSkipTaskCandidateText,
  taskExtractionPromptTitle,
  taskOutcomePromptTitle,
} from "../src/indexing/interpret/task-candidates.ts";
import { buildTaskOutcomePrompt } from "../src/indexing/interpret/task-extraction.ts";
import type { InteractionFact } from "../src/store/store-contract.ts";

/** A minimal human interaction carrying prompt + response text, for the outcome-prompt builder. */
function interaction(promptText: string, responseText: string): InteractionFact {
  return {
    id: "i0",
    source: "codex",
    sourceSessionId: "codex:1",
    seq: 0,
    initiator: "human",
    disposition: "completed",
    compactionCount: 0,
    promptPosition: { originKey: "f", recordIndex: 0, itemIndex: 0 },
    position: { originKey: "f", recordIndex: 0, itemIndex: 0 },
    promptText,
    responseText,
  };
}

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
    expect(taskExtractionPromptTitle(text)).toBe(
      "Task extraction for codex:019ed69b-6e39-7631-ba51-3131851b31ea",
    );
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
    expect(taskExtractionPromptTitle(text)).toBe("Task extraction for claude:one");
  });

  test("keeps ordinary task text", () => {
    expect(shouldSkipTaskCandidateText("add task extraction to the session screen")).toBe(false);
    expect(taskExtractionPromptTitle("add task extraction to the session screen")).toBeUndefined();
  });

  test("skips the Codex environment_context block so it is not used as the opening prompt", () => {
    const text = `<environment_context>
  <cwd>/Users/me/Documents/Account Research</cwd>
  <shell>zsh</shell>
  <current_date>2026-06-18</current_date>
</environment_context>`;

    expect(shouldSkipTaskCandidateText(text)).toBe(true);
  });

  test("skips Argus session analysis prompts and labels their target session", () => {
    const text = `Analyze this coding-agent session. Return JSON only with these string fields: title, attempted, outcome, outcomeReason.

FACTS:
{
  "sessionId": "codex:019ebd64-dee1-7083-9193-1592d42f77ca",
  "source": "codex",
  "project": "adc/argus"
}

TRANSCRIPT:
USER: add a new session analysis mode`;

    expect(shouldSkipTaskCandidateText(text)).toBe(true);
    expect(sessionAnalysisPromptTitle(text)).toBe(
      "Session analysis for codex:019ebd64-dee1-7083-9193-1592d42f77ca",
    );
    expect(argusGeneratedPromptTitle(text)).toBe(
      "Session analysis for codex:019ebd64-dee1-7083-9193-1592d42f77ca",
    );
  });

  test("recognizes the pass-2 task outcome prompt that claude -p leaves behind (#91)", () => {
    // The real generated prompt, so the detector can't drift from what task extraction emits.
    const text = buildTaskOutcomePrompt("Add a facts command", [
      interaction("add a facts command", "Done."),
    ]);
    expect(taskOutcomePromptTitle(text)).toBe("Task outcome run");
    expect(argusGeneratedPromptTitle(text)).toBe("Task outcome run");
    expect(shouldSkipTaskCandidateText(text)).toBe(true);
    // A user message carrying it is not counted as a real opening prompt.
    expect(isCountableClaudeUserMessage({ type: "user", message: { content: text } })).toBe(false);
  });

  test("identifies countable Claude user messages without accepting generated context", () => {
    expect(
      isCountableClaudeUserMessage({
        type: "user",
        message: { content: "fix the task extraction bug" },
      }),
    ).toBe(true);
    expect(
      isCountableClaudeUserMessage({
        type: "user",
        message: { content: [{ type: "tool_result", content: "done" }] },
      }),
    ).toBe(false);
    expect(
      isCountableClaudeUserMessage({
        type: "user",
        message: { content: "<local-command-caveat>shell output follows</local-command-caveat>" },
      }),
    ).toBe(false);
  });
});
