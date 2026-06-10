import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_EVIDENCE_MAX_CHARS,
  capabilityEventsFromMessages,
  createCapabilityEvent,
  isSuccessfulCapabilityEvent,
  sanitizeCapabilityEvidenceText,
} from "../src/capability-events.ts";
import { emptyUsage, type CapabilityEventInput, type MessageRecord } from "../src/types.ts";

function eventInput(
  outcome: CapabilityEventInput["outcome"],
  assessmentBasis: CapabilityEventInput["assessmentBasis"],
  confidence: number,
): CapabilityEventInput {
  return {
    id: `event-${outcome}`,
    source: "claude",
    sessionId: "session-1",
    project: "fixture/project",
    timestamp: 1,
    capability: {
      type: "tool",
      name: "Bash",
      displayName: "Bash",
      toolName: "Bash",
    },
    outcome,
    assessmentBasis,
    confidence,
    evidence: [{ kind: "status", basis: "observed", summary: `${outcome} status` }],
  };
}

describe("capability event model", () => {
  test("represents every outcome without treating unknown or partial as success", () => {
    const unknown = createCapabilityEvent(eventInput("unknown", "unassessed", 0));
    const success = createCapabilityEvent(eventInput("success", "observed", 1));
    const failure = createCapabilityEvent({
      ...eventInput("failure", "observed", 1),
      failureType: "timeout",
    });
    const partial = createCapabilityEvent(eventInput("partial", "inferred", 0.6));

    expect([unknown.outcome, success.outcome, failure.outcome, partial.outcome]).toEqual([
      "unknown",
      "success",
      "failure",
      "partial",
    ]);
    expect(isSuccessfulCapabilityEvent(unknown)).toBe(false);
    expect(isSuccessfulCapabilityEvent(partial)).toBe(false);
    expect(isSuccessfulCapabilityEvent(failure)).toBe(false);
    expect(isSuccessfulCapabilityEvent(success)).toBe(true);
    expect(failure.failureType).toBe("timeout");
  });

  test("enforces assessment invariants", () => {
    expect(() => createCapabilityEvent(eventInput("unknown", "observed", 1))).toThrow();
    expect(() => createCapabilityEvent(eventInput("success", "unassessed", 0))).toThrow();
    expect(() => createCapabilityEvent(eventInput("failure", "observed", 1))).toThrow();
    expect(() =>
      createCapabilityEvent({
        ...eventInput("success", "observed", 1),
        failureType: "unknown",
      }),
    ).toThrow();
  });

  test("bounds and redacts evidence text", () => {
    const sanitized = sanitizeCapabilityEvidenceText(
      `Bearer abc.def api_key=top-secret password: hunter2 ${"x".repeat(500)}`,
    );
    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).toContain("api_key=[REDACTED]");
    expect(sanitized).toContain("password: [REDACTED]");
    expect(sanitized).not.toContain("top-secret");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized.length).toBeLessThanOrEqual(CAPABILITY_EVIDENCE_MAX_CHARS);
  });

  test("normalizes tool, skill, and MCP invocations from messages", () => {
    const message: MessageRecord = {
      source: "claude",
      sessionId: "session-1",
      project: "fixture/project",
      cwd: "/fixture/project",
      gitBranch: "",
      ts: 100,
      date: "2026-06-10",
      model: "fixture-model",
      usage: emptyUsage(),
      attributionSkill: null,
      toolUses: [
        { name: "Edit", invocationId: "edit-1", category: "file-io" },
        { name: "Skill", invocationId: "skill-1", category: "skill", skill: "jj:jj" },
        {
          name: "mcp__github__get_issue",
          invocationId: "mcp-1",
          category: "mcp",
          mcpServer: "github",
          mcpTool: "get_issue",
        },
      ],
    };

    const events = capabilityEventsFromMessages([message]);
    expect(events.map((event) => event.capability.type).sort()).toEqual(["mcp", "skill", "tool"]);
    expect(events.find((event) => event.invocationId === "skill-1")?.capability.name).toBe("jj:jj");
    expect(events.find((event) => event.invocationId === "mcp-1")?.capability.displayName).toBe(
      "github · get_issue",
    );
    expect(events.every((event) => event.evidence[0]?.kind === "invocation")).toBe(true);
  });
});
