import { describe, expect, it } from "bun:test";
import {
  groupSecretFindingsByInteraction,
  interactionNumber,
  orderSecretFindings,
  secretFindingKey,
  secretFindingLabel,
  secretFindingLine,
  secretFindingWhere,
} from "./secret-findings";
import type { SecretFinding } from "../types";

function finding(over: Partial<SecretFinding> = {}): SecretFinding {
  return {
    category: "aws_access_key",
    interactionSeq: 0,
    chunkType: "prompt",
    hint: "AKIA…WXYZ",
    ...over,
  };
}

describe("secretFindingLabel", () => {
  it("names the category in plain words and keeps the redacted hint", () => {
    expect(secretFindingLabel(finding())).toBe("AWS access key (AKIA…WXYZ)");
  });

  it("drops the parentheses when a shape carries no hint", () => {
    expect(secretFindingLabel(finding({ category: "private_key", hint: "" }))).toBe("Private key");
  });
});

describe("secretFindingWhere", () => {
  it("distinguishes the user's prompt from the agent's reply", () => {
    expect(secretFindingWhere(finding({ chunkType: "prompt" }))).toBe("in your prompt");
    expect(secretFindingWhere(finding({ chunkType: "response" }))).toBe("in the agent's reply");
  });
});

describe("interactionNumber", () => {
  it("counts from 1, since the store's seq is 0-based", () => {
    expect(interactionNumber(0)).toBe(1);
    expect(interactionNumber(3)).toBe(4);
  });
});

describe("secretFindingLine", () => {
  it("says where in the session, what, and in which half", () => {
    expect(secretFindingLine(finding({ interactionSeq: 3 }))).toBe(
      "Interaction 4: AWS access key (AKIA…WXYZ) in your prompt",
    );
  });
});

describe("orderSecretFindings", () => {
  it("orders by interaction, then prompt before response, then category and hint", () => {
    const findings = [
      finding({ interactionSeq: 2, chunkType: "response", category: "jwt", hint: "ey…9k" }),
      finding({ interactionSeq: 0, chunkType: "response", category: "github_token", hint: "ghp_…ab12" }),
      finding({ interactionSeq: 0, chunkType: "prompt", category: "stripe_key", hint: "sk_l…7788" }),
      finding({ interactionSeq: 0, chunkType: "prompt", category: "aws_access_key", hint: "AKIA…WXYZ" }),
    ];
    expect(orderSecretFindings(findings).map(secretFindingKey)).toEqual([
      "aws_access_key-0-prompt-AKIA…WXYZ",
      "stripe_key-0-prompt-sk_l…7788",
      "github_token-0-response-ghp_…ab12",
      "jwt-2-response-ey…9k",
    ]);
  });

  it("leaves the caller's array alone", () => {
    const findings = [finding({ interactionSeq: 5 }), finding({ interactionSeq: 1 })];
    orderSecretFindings(findings);
    expect(findings.map((f) => f.interactionSeq)).toEqual([5, 1]);
  });
});

describe("groupSecretFindingsByInteraction", () => {
  it("splits each interaction's findings into the half they were found in", () => {
    const grouped = groupSecretFindingsByInteraction([
      finding({ interactionSeq: 4, chunkType: "response", category: "github_token", hint: "ghp_…ab12" }),
      finding({ interactionSeq: 4, chunkType: "prompt" }),
      finding({ interactionSeq: 1, chunkType: "prompt", category: "jwt", hint: "ey…9k" }),
    ]);

    expect([...grouped.keys()].sort((a, b) => a - b)).toEqual([1, 4]);
    expect(grouped.get(1)!.prompt.map((f) => f.category)).toEqual(["jwt"]);
    expect(grouped.get(1)!.response).toEqual([]);
    expect(grouped.get(4)!.prompt.map((f) => f.category)).toEqual(["aws_access_key"]);
    expect(grouped.get(4)!.response.map((f) => f.category)).toEqual(["github_token"]);
  });

  it("orders the findings within a half", () => {
    const grouped = groupSecretFindingsByInteraction([
      finding({ chunkType: "prompt", category: "stripe_key", hint: "sk_l…7788" }),
      finding({ chunkType: "prompt", category: "aws_access_key", hint: "AKIA…WXYZ" }),
    ]);
    expect(grouped.get(0)!.prompt.map((f) => f.category)).toEqual(["aws_access_key", "stripe_key"]);
  });

  it("has no entry for an interaction with nothing found", () => {
    const grouped = groupSecretFindingsByInteraction([finding({ interactionSeq: 2 })]);
    expect(grouped.get(0)).toBeUndefined();
    expect(grouped.size).toBe(1);
  });

  it("is empty when the session has no findings", () => {
    expect(groupSecretFindingsByInteraction([]).size).toBe(0);
  });
});
