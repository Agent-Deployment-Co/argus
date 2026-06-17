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

export function isAgentsInstructionsText(text: string): boolean {
  return /^#?\s*AGENTS\.md instructions for\b/i.test(text.trimStart());
}

export function isTurnAbortedText(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^<turn_aborted\b[^>]*\/?>$/i.test(trimmed) ||
    /^<turn_aborted\b[^>]*>\s*<\/turn_aborted>$/i.test(trimmed)
  );
}

export function taskExtractionPromptTargetSessionId(text: string): string | undefined {
  const trimmed = text.trimStart();
  const marker = "Filtered user messages:";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const payload = trimmed.slice(markerIndex + marker.length);
  const objectStart = payload.indexOf("{");
  if (objectStart < 0) return undefined;
  try {
    const parsed = JSON.parse(payload.slice(objectStart)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const values = parsed as Record<string, unknown>;
    return typeof values.sessionId === "string" && Array.isArray(values.messages)
      ? values.sessionId
      : undefined;
  } catch {
    const sessionId = payload.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1];
    return sessionId && /"messages"\s*:\s*\[/.test(payload) ? sessionId : undefined;
  }
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

export function shouldSkipTaskCandidateText(text: string, nextText?: string): boolean {
  return (
    isAgentsInstructionsText(text) ||
    isTurnAbortedText(text) ||
    isTaskExtractionPromptText(text) ||
    (nextText ? isTurnAbortedText(nextText) : false)
  );
}
