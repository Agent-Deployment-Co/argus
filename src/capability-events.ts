import { toolDisplayName } from "./tool-categories.ts";
import type {
  CapabilityAssessmentBasis,
  CapabilityEvent,
  CapabilityEventInput,
  CapabilityEvidence,
  CapabilityEvidenceInput,
  CapabilityRef,
  MessageRecord,
  ToolUse,
} from "./types.ts";

export const CAPABILITY_EVIDENCE_MAX_CHARS = 280;

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b(\s*[:=]\s*)(["']?)[^\s,"'}]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function sanitizeCapabilityEvidenceText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`)
    .trim()
    .slice(0, CAPABILITY_EVIDENCE_MAX_CHARS);
}

export function createCapabilityEvidence(input: CapabilityEvidenceInput): CapabilityEvidence {
  const summary = sanitizeCapabilityEvidenceText(input.summary);
  if (!summary) throw new Error("Capability evidence summary cannot be empty");
  if (input.timestamp != null && !Number.isFinite(input.timestamp)) {
    throw new Error("Capability evidence timestamp must be finite");
  }
  return {
    kind: input.kind,
    basis: input.basis,
    summary,
    ...(input.timestamp == null ? {} : { timestamp: input.timestamp }),
  };
}

function validateAssessment(
  outcome: CapabilityEvent["outcome"],
  basis: CapabilityAssessmentBasis,
  confidence: number,
  failureType: CapabilityEvent["failureType"],
): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Capability event confidence must be between 0 and 1");
  }
  if (outcome === "unknown") {
    if (basis !== "unassessed" || confidence !== 0) {
      throw new Error("Unknown capability outcomes must be unassessed with zero confidence");
    }
    if (failureType) throw new Error("Unknown capability outcomes cannot have a failure type");
    return;
  }
  if (basis === "unassessed") {
    throw new Error("Known capability outcomes require observed or inferred assessment");
  }
  if (confidence === 0) {
    throw new Error("Known capability outcomes require non-zero confidence");
  }
  if (outcome === "failure" && !failureType) {
    throw new Error("Failed capability outcomes require a failure type");
  }
  if (outcome !== "failure" && failureType) {
    throw new Error("Only failed capability outcomes can have a failure type");
  }
}

export function createCapabilityEvent(input: CapabilityEventInput): CapabilityEvent {
  if (!input.id || !input.sessionId || !input.capability.name || !input.capability.toolName) {
    throw new Error("Capability events require IDs, a session, and capability identity");
  }
  if (!Number.isFinite(input.timestamp)) {
    throw new Error("Capability event timestamp must be finite");
  }
  validateAssessment(input.outcome, input.assessmentBasis, input.confidence, input.failureType);
  if (input.durationMs != null && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) {
    throw new Error("Capability event duration must be a non-negative number");
  }
  if (input.retryOf && input.retryOf === input.id) {
    throw new Error("Capability event cannot retry itself");
  }
  return {
    ...input,
    evidence: input.evidence.map(createCapabilityEvidence),
  };
}

export function isSuccessfulCapabilityEvent(event: CapabilityEvent): boolean {
  return event.outcome === "success";
}

export function capabilityRef(toolUse: ToolUse): CapabilityRef {
  if ((toolUse.name === "Skill" || toolUse.name === "activate_skill") && toolUse.skill) {
    return {
      type: "skill",
      name: toolUse.skill,
      displayName: toolUse.skill,
      toolName: toolUse.name,
      skill: toolUse.skill,
    };
  }
  if (toolUse.mcpServer && toolUse.mcpTool) {
    return {
      type: "mcp",
      name: toolUse.name,
      displayName: toolDisplayName(toolUse.name),
      toolName: toolUse.name,
      mcpServer: toolUse.mcpServer,
      mcpTool: toolUse.mcpTool,
    };
  }
  return {
    type: "tool",
    name: toolUse.name,
    displayName: toolDisplayName(toolUse.name),
    toolName: toolUse.name,
  };
}

function eventId(message: MessageRecord, toolUse: ToolUse, messageIndex: number, toolIndex: number): string {
  const invocation = toolUse.invocationId || `${toolUse.timestamp ?? message.ts}:${messageIndex}:${toolIndex}`;
  return [message.source, message.sessionId, invocation].map(encodeURIComponent).join(":");
}

export function capabilityEventsFromMessages(messages: MessageRecord[]): CapabilityEvent[] {
  const events: CapabilityEvent[] = [];
  messages.forEach((message, messageIndex) => {
    message.toolUses.forEach((toolUse, toolIndex) => {
      const timestamp = toolUse.timestamp ?? message.ts;
      events.push(
        createCapabilityEvent({
          id: eventId(message, toolUse, messageIndex, toolIndex),
          source: message.source,
          sessionId: message.sessionId,
          project: message.project,
          timestamp,
          invocationId: toolUse.invocationId,
          capability: capabilityRef(toolUse),
          action: toolUse.mcpTool ?? toolUse.skill ?? toolUse.name,
          outcome: "unknown",
          assessmentBasis: "unassessed",
          confidence: 0,
          evidence: [
            {
              kind: "invocation",
              basis: "observed",
              summary: `Invocation recorded by ${message.source}`,
              timestamp,
            },
          ],
        }),
      );
    });
  });
  return events.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}
