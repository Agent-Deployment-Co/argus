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

export function isTaskExtractionPromptText(text: string): boolean {
  const trimmed = text.trimStart();
  if (
    trimmed.startsWith(
      "You identify the actual tasks a user was trying to accomplish in a coding-agent session.",
    ) &&
    trimmed.includes("Filtered user messages:")
  ) {
    return true;
  }

  const marker = "Filtered user messages:";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex < 0) return false;
  const payload = trimmed.slice(markerIndex + marker.length);
  return /"sessionId"\s*:\s*"/.test(payload) && /"messages"\s*:\s*\[/.test(payload);
}

export function shouldSkipTaskCandidateText(text: string, nextText?: string): boolean {
  return (
    isAgentsInstructionsText(text) ||
    isTurnAbortedText(text) ||
    isTaskExtractionPromptText(text) ||
    (nextText ? isTurnAbortedText(nextText) : false)
  );
}
