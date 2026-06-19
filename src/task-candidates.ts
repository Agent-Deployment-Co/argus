export const TASK_TEXT_LIMIT = 4_000;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function textFromUserContent(content: unknown, limit = TASK_TEXT_LIMIT): string {
  if (typeof content === "string") return content.slice(0, limit);
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const values = objectValue(part);
      return typeof values.text === "string" ? values.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, limit);
}

export function textFromClaudeUserContent(content: unknown, limit = TASK_TEXT_LIMIT): string {
  return textFromUserContent(content, limit);
}

export function hasClaudeToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => objectValue(part).type === "tool_result");
}

export function isClaudeGeneratedContextText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<local-command-caveat>") ||
    trimmed.startsWith("<bash-stdout>") ||
    trimmed.startsWith("<bash-stderr>") ||
    trimmed.startsWith("Base directory for this skill:") ||
    argusGeneratedPromptTitle(trimmed) != null
  );
}

export function isCountableClaudeUserMessage(record: unknown): boolean {
  const values = objectValue(record);
  if (values.type !== "user" || values.isCompactSummary === true) return false;
  const content = objectValue(values.message).content;
  if (hasClaudeToolResultContent(content)) return false;
  const text = textFromClaudeUserContent(content);
  return Boolean(text.trim() && !isClaudeGeneratedContextText(text));
}

export function isAgentsInstructionsText(text: string): boolean {
  return /^#?\s*AGENTS\.md instructions for\b/i.test(text.trimStart());
}

// Codex injects an `<environment_context>` block (cwd, shell, date, sandbox
// permissions) as the first user-role message, ahead of the real prompt. It's
// system-generated context, not something the user typed, so it must not be
// mistaken for the opening prompt or a task.
export function isCodexEnvironmentContextText(text: string): boolean {
  return /^<environment_context[\s>]/i.test(text.trimStart());
}

export function isTurnAbortedText(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^<turn_aborted\b[^>]*\/?>$/i.test(trimmed) ||
    /^<turn_aborted\b[^>]*>\s*<\/turn_aborted>$/i.test(trimmed)
  );
}

function jsonObjectAfterMarker(text: string, marker: string): Record<string, unknown> | undefined {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const payload = text.slice(markerIndex + marker.length);
  const start = payload.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < payload.length; index++) {
    const char = payload[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(payload.slice(start, index + 1)) as unknown;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function taskExtractionPromptTargetSessionId(text: string): string | undefined {
  const trimmed = text.trimStart();
  const marker = "Filtered user messages:";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const values = jsonObjectAfterMarker(trimmed, marker);
  if (typeof values?.sessionId === "string" && Array.isArray(values.messages)) {
    return values.sessionId;
  }
  const payload = trimmed.slice(markerIndex + marker.length);
  const sessionId = payload.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1];
  return sessionId && /"messages"\s*:\s*\[/.test(payload) ? sessionId : undefined;
}

export function taskExtractionPromptTitle(text: string): string | undefined {
  const targetSessionId = taskExtractionPromptTargetSessionId(text);
  if (targetSessionId) return `Task extraction for ${targetSessionId}`;
  const trimmed = text.trimStart();
  if (
    trimmed.startsWith(
      "You identify the actual tasks a user was trying to accomplish in a coding-agent session.",
    ) &&
    trimmed.includes("Filtered user messages:")
  ) {
    return "Task extraction run";
  }
  return undefined;
}

export function isTaskExtractionPromptText(text: string): boolean {
  return taskExtractionPromptTitle(text) != null;
}

export function sessionAnalysisPromptTargetSessionId(text: string): string | undefined {
  const trimmed = text.trimStart();
  const values = jsonObjectAfterMarker(trimmed, "FACTS:");
  return typeof values?.sessionId === "string" ? values.sessionId : undefined;
}

export function sessionAnalysisPromptTitle(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("Analyze this coding-agent session.")) return undefined;
  const targetSessionId = sessionAnalysisPromptTargetSessionId(text);
  return targetSessionId ? `Session analysis for ${targetSessionId}` : "Session analysis run";
}

// Pass 2 of task extraction (#91) sends an outcome-judging prompt to `claude -p`; like the pass-1
// and session-analysis prompts, that call leaves its own transcript, which must be recognized as
// Argus-generated rather than mistaken for a real user message/task.
export function taskOutcomePromptTitle(text: string): string | undefined {
  const trimmed = text.trimStart();
  return trimmed.startsWith("You judge how a single task in a coding-agent session turned out") &&
    trimmed.includes("Dialogue:")
    ? "Task outcome run"
    : undefined;
}

export function argusGeneratedPromptTitle(text: string): string | undefined {
  return (
    taskExtractionPromptTitle(text) ??
    taskOutcomePromptTitle(text) ??
    sessionAnalysisPromptTitle(text)
  );
}

export function shouldSkipTaskCandidateText(text: string, nextText?: string): boolean {
  return (
    isAgentsInstructionsText(text) ||
    isCodexEnvironmentContextText(text) ||
    isTurnAbortedText(text) ||
    argusGeneratedPromptTitle(text) != null ||
    (nextText ? isTurnAbortedText(nextText) : false)
  );
}
