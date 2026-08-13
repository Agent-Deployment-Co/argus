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

describe("scanTextForSecrets", () => {
  test("flags an AWS access key", () => {
    const [f] = scanTextForSecrets("use AKIAIOSFODNN7EXAMPLE for prod", at);
    // AKIAIOSFODNN7EXAMPLE is AWS's own documentation example key — a shape match is correct.
    expect(f!.category).toBe("aws_access_key");
    expect(f!.hint).toBe("AKIA…MPLE");
    expect(f!.hint).not.toContain("IOSFODNN7");
  });

  test("flags GitHub tokens", () => {
    expect(categories(`token ghp_${"a".repeat(36)}`)).toContain("github_token");
    expect(categories(`github_pat_${"A1_" .repeat(11)}x`)).toContain("github_token");
  });

  test("flags Anthropic keys as anthropic, not openai", () => {
    const found = scanTextForSecrets(`key: sk-ant-${"a1-".repeat(10)}`, at);
    expect(found.map((f) => f.category)).toEqual(["anthropic_api_key"]);
  });

  test("flags OpenAI keys, including sk-proj-", () => {
    expect(categories(`sk-${"T0".repeat(14)}`)).toContain("openai_api_key");
    expect(categories(`sk-proj-${"T0".repeat(14)}`)).toContain("openai_api_key");
  });

  test("flags Stripe and Slack tokens", () => {
    expect(categories(`sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`)).toContain("stripe_key");
    expect(categories(`xoxb-${"123456789012-123456789012-AbCdEfGhIjKl"}`)).toContain("slack_token");
  });

  test("flags private key blocks without leaking key material", () => {
    const [f] = scanTextForSecrets(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----",
      at,
    );
    expect(f!.category).toBe("private_key");
    expect(f!.hint).toBe("RSA PRIVATE KEY");
  });

  test("flags JWTs", () => {
    const jwt = `eyJ${"hbGciOiJIUzI1NiIs"}.${"c3ViamVjdCI6MTIzND"}.${"SflKxwRJSMeKKF2Q"}`;
    const [f] = scanTextForSecrets(`Authorization: Bearer ${jwt}`, at);
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
    const text = `first AKIAIOSFODNN7EXAMPLE then again AKIAIOSFODNN7EXAMPLE`;
    expect(scanTextForSecrets(text, at)).toHaveLength(1);
  });

  test("a finding never contains the full secret", () => {
    const secret = `sk-ant-${"Z9y8X7w6V5".repeat(5)}`;
    for (const f of scanTextForSecrets(secret, at)) {
      expect(secret).not.toContain(f.hint.replace("…", ""));
      expect(f.hint.length).toBeLessThan(secret.length / 2);
    }
  });
});

describe("scanSessionForSecrets", () => {
  test("scans prompts and responses, tagged with their interaction", () => {
    const findings = scanSessionForSecrets({
      interactions: [
        { seq: 0, promptText: `here is my key sk-ant-${"a1-".repeat(10)}` },
        { seq: 1, responseText: `-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----` },
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
});

describe("secretFindingsDigest", () => {
  const a = scanTextForSecrets(`AKIAIOSFODNN7EXAMPLE`, at);
  test("is stable regardless of finding order", () => {
    const b = [...a].reverse();
    expect(secretFindingsDigest(a)).toBe(secretFindingsDigest(b));
  });
  test("changes when the finding set changes", () => {
    const other = scanTextForSecrets(`AKIAIOSFODNN7EXAMPLE`, { interactionSeq: 1, chunkType: "prompt" });
    expect(secretFindingsDigest(a)).not.toBe(secretFindingsDigest(other));
  });
});
