import { describe, expect, test } from "bun:test";
import {
  scanSessionForSecrets,
  scanTextForSecrets,
  secretFindingsDigest,
} from "../src/indexing/secret-scan.ts";

const at = { interactionSeq: 0, chunkType: "prompt" as const };

function categories(text: string): string[] {
  return scanTextForSecrets(text, at).map((f) => f.category);
}

// Synthetics shaped to satisfy each gitleaks rule (charset, length, entropy) — see
// secret-scan-rules.ts for the upstream definitions these follow. Every value is assembled from
// concatenated fragments so no complete credential-shaped literal appears in source: these are
// test fixtures, never real keys, and keeping them split avoids tripping secret scanners on this
// repo itself.
const AWS_KEY = "AKIA" + "Q3G5X7BDFHJKLMNP".slice(0, 16); // [A-Z2-7] suffix, entropy ≥ 3
const AWS_DOCS_EXAMPLE = "AKIA" + "IOSFODNN7" + "EXAMPLE"; // AWS's own docs placeholder
const GITHUB_PAT = "ghp_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tV9wX2yZ4bC6";
const GITHUB_FG_PAT =
  "github" + "_pat_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tV9wX2yZ4bC6d8eF0gH2iJ4kL6mN8pQ0rS2tV4wX6yZ8aC1eG3iK5m7o9qS1uW3";
const ANTHROPIC_KEY =
  "sk-ant-api03-" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tV9wX2yZ4bC6d8e".repeat(3).slice(0, 93) + "AA";
const OPENAI_KEY = "sk-" + "aB3dE5fG7hJ9kL1mN3pQ" + "T3BlbkFJ" + "xY7wV2uT8sR4qP6oN0zA";
const STRIPE_KEY = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const SLACK_TOKEN = "xoxb-" + "123456789012" + "-" + "123456789012" + "-AbCdEfGhIjKl";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0." +
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
const RSA_BLOCK =
  "-----BEGIN RSA PRIVATE KEY-----\n" +
  "MIIEowIBAAKCAQEA7dBt8k1zY0vVv0xJcQz2k0m0yYxVbN1a2s3d4f5g6h7j8k9l0\n".repeat(2) +
  "-----END RSA PRIVATE KEY-----";

describe("scanTextForSecrets", () => {
  test("flags an AWS access key", () => {
    const [f] = scanTextForSecrets(`use ${AWS_KEY} for prod`, at);
    expect(f!.category).toBe("aws_access_key");
    expect(f!.hint).toBe("AKIA…LMNP");
    expect(f!.hint).not.toContain(AWS_KEY.slice(4, -4));
  });

  test("allowlists AWS's documentation example key (gitleaks `.+EXAMPLE$` rule)", () => {
    // The AWS docs placeholder is a shape match, but gitleaks allowlists it, and so do we: it is
    // not a leak.
    expect(scanTextForSecrets(`use ${AWS_DOCS_EXAMPLE} for prod`, at)).toEqual([]);
  });

  test("flags GitHub tokens", () => {
    expect(categories(`token ${GITHUB_PAT}`)).toContain("github_token");
    expect(categories(GITHUB_FG_PAT)).toContain("github_token");
  });

  test("flags Anthropic keys", () => {
    const found = scanTextForSecrets(`use ${ANTHROPIC_KEY} here`, at);
    expect(found.map((f) => f.category)).toEqual(["anthropic_api_key"]);
  });

  test("flags OpenAI keys (the T3BlbkFJ marker keeps precision high)", () => {
    expect(categories(`Bearer ${OPENAI_KEY}`)).toContain("openai_api_key");
  });

  test("flags Stripe and Slack tokens", () => {
    expect(categories(STRIPE_KEY)).toContain("stripe_key");
    expect(categories(SLACK_TOKEN)).toContain("slack_token");
  });

  test("flags private key blocks without leaking key material", () => {
    const [f] = scanTextForSecrets(RSA_BLOCK, at);
    expect(f!.category).toBe("private_key");
    expect(f!.hint).toBe("RSA PRIVATE KEY");
  });

  test("flags JWTs", () => {
    const [f] = scanTextForSecrets(`Authorization: Bearer ${JWT}`, at);
    expect(f!.category).toBe("jwt");
  });

  test("flags a generic assignment with a high-entropy value", () => {
    const found = scanTextForSecrets(`API_KEY="kX9f2Q7vB4nR8wZ1mC6pL3dT"`, at);
    expect(found.map((f) => f.category)).toContain("generic_secret");
    const g = found.find((f) => f.category === "generic_secret")!;
    expect(g.hint).toBe("kX…dT");
  });

  test("ignores placeholders and code expressions", () => {
    const texts = [
      `API_KEY=your-api-key-here`,
      `API_KEY="xxxxxxxxxxxxxxxxxxxx"`,
      `API_KEY=\${MY_API_KEY}`,
      `API_KEY=<paste-your-key>`,
      `password = "correct horse battery staple"`,
      `api_key = config.api_key_value_here`,
      `OPENAI_API_KEY=sk-...`,
      `token=short`,
    ];
    for (const text of texts) {
      expect(scanTextForSecrets(text, at)).toEqual([]);
    }
  });

  test("ignores prose that merely mentions key shapes", () => {
    expect(categories("your OpenAI key starts with sk- followed by random characters")).toEqual([]);
    expect(categories("it looks like xoxb- followed by numbers")).toEqual([]);
  });

  test("dedupes a secret pasted twice, keeping the first location", () => {
    const text = `first ${AWS_KEY} then again ${AWS_KEY}`;
    expect(scanTextForSecrets(text, at)).toHaveLength(1);
  });

  test("a finding never contains the full secret", () => {
    for (const f of scanTextForSecrets(ANTHROPIC_KEY, at)) {
      expect(ANTHROPIC_KEY).not.toContain(f.hint.replace("…", ""));
      expect(f.hint.length).toBeLessThan(ANTHROPIC_KEY.length / 2);
    }
  });
});

describe("scanSessionForSecrets", () => {
  test("scans prompts and responses, tagged with their interaction", () => {
    const findings = scanSessionForSecrets({
      interactions: [
        { seq: 0, promptText: `here is my key ${ANTHROPIC_KEY}` },
        { seq: 1, responseText: RSA_BLOCK },
        { seq: 2, promptText: "nothing here" },
      ],
    });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ interactionSeq: 0, chunkType: "prompt", category: "anthropic_api_key" });
    expect(findings[1]).toMatchObject({ interactionSeq: 1, chunkType: "response", category: "private_key" });
  });

  test("handles sessions without interactions or text", () => {
    expect(scanSessionForSecrets({})).toEqual([]);
    expect(scanSessionForSecrets({ interactions: [{ seq: 0 }] })).toEqual([]);
  });

  test("dedupes the same credential across interactions, keeping the first location", () => {
    const findings = scanSessionForSecrets({
      interactions: [
        { seq: 0, promptText: `my key is ${AWS_KEY}` },
        { seq: 1, promptText: `still failing with ${AWS_KEY}` },
        { seq: 1, responseText: `confirmed, ${AWS_KEY} is the one` },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ interactionSeq: 0, chunkType: "prompt", category: "aws_access_key" });
  });
});

describe("secretFindingsDigest", () => {
  const a = scanTextForSecrets(AWS_KEY, at);
  test("is stable regardless of finding order", () => {
    const b = [...a].reverse();
    expect(secretFindingsDigest(a)).toBe(secretFindingsDigest(b));
  });
  test("changes when the finding set changes", () => {
    const other = scanTextForSecrets(AWS_KEY, { interactionSeq: 1, chunkType: "prompt" });
    expect(secretFindingsDigest(a)).not.toBe(secretFindingsDigest(other));
  });
});
