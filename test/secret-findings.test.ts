// Tests for the secret-scan store behavior (#327): findings persist at materialize, are replaced
// wholesale on re-materialize, dismissal is anchored to the finding-set digest, and the rows stay
// local-only by construction (push.ts never reads the table).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store/store.ts";
import type { MaterializeSession, SecretFinding } from "../src/store/store-contract.ts";
import { SECRET_SCAN_VERSION, secretFindingsDigest } from "../src/indexing/secret-scan.ts";
import { parseAllIncrementalDetailed } from "../src/indexing/pipeline.ts";
import type { MessageRecord } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-secret-findings-"));
  tempDirs.push(dir);
  return dir;
}

function message(sessionId: string, ts = 1_717_600_000_000): MessageRecord {
  return {
    source: "claude",
    sessionId,
    project: "p",
    cwd: "/tmp/p",
    gitBranch: "main",
    ts,
    date: "2026-06-01",
    model: "claude-opus-4",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    attributionSkill: null,
    toolUses: [],
  };
}

function finding(over: Partial<SecretFinding> = {}): SecretFinding {
  return {
    category: "aws_access_key",
    interactionSeq: 0,
    chunkType: "prompt",
    hint: "AKIA…MPLE",
    ...over,
  };
}

function sessionWithFindings(
  sessionId: string,
  findings: SecretFinding[],
  messages: MessageRecord[] = [message(sessionId)],
): MaterializeSession {
  return {
    meta: { source: "claude", sessionId, project: "p", cwd: "/tmp/p", filePath: "/tmp/p/s.jsonl" },
    messages,
    // Always attached, even with zero findings — that's what the pipeline does, so materialize stamps
    // the scanner version (#335) and the rescan drain leaves the session alone.
    secretFindings: {
      version: SECRET_SCAN_VERSION,
      digest: secretFindingsDigest(findings),
      findings,
    },
  };
}

describe("secret findings store", () => {
  test("materialize persists findings; reads return them undismissed", async () => {
    const store = await openStore({ path: join(tempRoot(), "argus.db") });
    try {
      const findings = [finding(), finding({ category: "private_key", hint: "RSA PRIVATE KEY", chunkType: "response" })];
      await store.materializeSessions("claude", [sessionWithFindings("s1", findings)]);
      const read = await store.readSessionSecretFindings("s1");
      expect(read.dismissed).toBe(false);
      expect(read.findings).toEqual(findings);
    } finally {
      await store.close();
    }
  });

  test("a session with no findings reads empty, and re-materializing without findings clears rows", async () => {
    const store = await openStore({ path: join(tempRoot(), "argus.db") });
    try {
      await store.materializeSessions("claude", [sessionWithFindings("s1", [finding()])]);
      expect((await store.readSessionSecretFindings("s1")).findings).toHaveLength(1);
      // Re-materialize the same session with no findings — the wholesale replace clears the rows.
      await store.materializeSessions("claude", [sessionWithFindings("s1", [])]);
      expect((await store.readSessionSecretFindings("s1")).findings).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("dismissal hides the finding set it was made against, and lapses when findings change", async () => {
    const store = await openStore({ path: join(tempRoot(), "argus.db") });
    try {
      await store.materializeSessions("claude", [sessionWithFindings("s1", [finding()])]);

      // Dismissal requires findings to dismiss.
      expect(await store.dismissSessionSecretFindings("s1")).toBe(true);
      expect((await store.readSessionSecretFindings("s1")).dismissed).toBe(true);
      expect([...(await store.readSecretFindingCounts(["s1"])).values()]).toEqual([]);
      expect(await store.readSecretFindingsRollup()).toBe(0);

      // Re-materialize with the SAME findings (an unchanged re-index): the dismissal survives.
      await store.materializeSessions("claude", [sessionWithFindings("s1", [finding()])]);
      expect((await store.readSessionSecretFindings("s1")).dismissed).toBe(true);

      // Re-materialize with DIFFERENT findings (new content matched): the warning returns.
      const changed = [finding(), finding({ category: "github_token", hint: "ghp_…wxyz" })];
      await store.materializeSessions("claude", [sessionWithFindings("s1", changed)]);
      const read = await store.readSessionSecretFindings("s1");
      expect(read.dismissed).toBe(false);
      expect((await store.readSecretFindingCounts(["s1"])).get("s1")).toBe(2);
      expect(await store.readSecretFindingsRollup()).toBe(1);

      // Undismiss is a no-op state change here; dismiss again then clear it explicitly.
      await store.dismissSessionSecretFindings("s1");
      expect((await store.readSessionSecretFindings("s1")).dismissed).toBe(true);
      await store.clearSessionSecretFindingsDismissal("s1");
      expect((await store.readSessionSecretFindings("s1")).dismissed).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("dismissing a session with no findings returns false", async () => {
    const store = await openStore({ path: join(tempRoot(), "argus.db") });
    try {
      await store.materializeSessions("claude", [sessionWithFindings("s1", [])]);
      expect(await store.dismissSessionSecretFindings("s1")).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("the kept-fuller guard preserves findings when a re-parse comes back short", async () => {
    const store = await openStore({ path: join(tempRoot(), "argus.db") });
    try {
      await store.materializeSessions("claude", [
        sessionWithFindings("s1", [finding()], [message("s1"), message("s1", 1_717_600_001_000)]),
      ]);
      // A short re-parse (a file aged out mid-run) keeps the fuller stored copy — findings included.
      const kept = await store.materializeSessions("claude", [
        sessionWithFindings("s1", [], [message("s1")]),
      ]);
      expect(kept).toEqual(["s1"]);
      expect((await store.readSessionSecretFindings("s1")).findings).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  test("retracting a session removes its findings", async () => {
    const store = await openStore({ path: join(tempRoot(), "argus.db") });
    try {
      await store.materializeSessions("claude", [sessionWithFindings("s1", [finding()])]);
      await store.retractSessions(["s1"]);
      expect((await store.readSessionSecretFindings("s1")).findings).toEqual([]);
      expect(await store.readSecretFindingsRollup()).toBe(0);
    } finally {
      await store.close();
    }
  });

  test("the flagged-session set includes hidden sessions, and drops dismissed ones", async () => {
    const store = await openStore({ path: join(tempRoot(), "argus.db") });
    try {
      await store.materializeSessions("claude", [
        sessionWithFindings("s1", [finding()]),
        sessionWithFindings("s2", [finding()]),
        sessionWithFindings("s3", []),
      ]);
      // The rollup counts a hidden session, so the list it links to has to be able to show it.
      await store.setSessionsHidden(["s2"], true);
      expect(await store.readSecretFindingsRollup()).toBe(2);
      expect([...(await store.readSessionIdsWithSecretFindings())].sort()).toEqual(["s1", "s2"]);

      await store.dismissSessionSecretFindings("s2");
      expect([...(await store.readSessionIdsWithSecretFindings())]).toEqual(["s1"]);
    } finally {
      await store.close();
    }
  });

  test("the rollup honors the source filter", async () => {
    const store = await openStore({ path: join(tempRoot(), "argus.db") });
    try {
      await store.materializeSessions("claude", [sessionWithFindings("s1", [finding()])]);
      expect(await store.readSecretFindingsRollup({ sources: ["claude"] })).toBe(1);
      expect(await store.readSecretFindingsRollup({ sources: ["codex"] })).toBe(0);
    } finally {
      await store.close();
    }
  });
});

describe("secret scanning in the indexing pipeline", () => {
  test("indexing a transcript with a pasted key records a redacted finding", async () => {
    const root = tempRoot();
    // A minimal Claude transcript whose opening prompt pastes a (synthetic) GitHub token — shaped
    // to satisfy the gitleaks rule (ghp_ + 36 base62 chars).
    const token = "ghp_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tV9wX2yZ4bC6";
    const projectsDir = join(root, "projects", "-Users-you-proj");
    mkdirSync(projectsDir, { recursive: true });
    const lines = [
      {
        type: "user",
        sessionId: "sess-secret",
        cwd: "/Users/you/proj",
        timestamp: "2026-06-01T17:00:00.000Z",
        message: {
          content: [
            { type: "text", text: `why does ${token} get a 401?` },
          ],
        },
      },
      {
        type: "assistant",
        sessionId: "sess-secret",
        cwd: "/Users/you/proj",
        timestamp: "2026-06-01T17:00:01.000Z",
        attributionSkill: null,
        message: {
          id: "m1",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: "text", text: "That token is expired." }],
        },
      },
    ];
    writeFileSync(
      join(projectsDir, "sess-secret.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    const storePath = join(root, "cache", "argus.db");
    const result = await parseAllIncrementalDetailed({
      projectsDir: join(root, "projects"),
      historyFile: join(root, "history.jsonl"),
      sources: ["claude"],
      storePath,
    });
    expect(result.parsed.sessions.size).toBe(1);

    const store = await openStore({ path: storePath });
    try {
      const read = await store.readSessionSecretFindings("sess-secret");
      expect(read.dismissed).toBe(false);
      expect(read.findings).toHaveLength(1);
      expect(read.findings[0]).toMatchObject({
        category: "github_token",
        chunkType: "prompt",
        interactionSeq: 0,
      });
      // The store holds a redacted locator only — the token material itself is never persisted.
      expect(read.findings[0]!.hint).toBe("ghp_…4bC6");
      expect(read.findings[0]!.hint).not.toContain(token.slice(4, -4));
      expect((await store.readSecretFindingCounts(["sess-secret"])).get("sess-secret")).toBe(1);
      expect(await store.readSecretFindingsRollup()).toBe(1);
    } finally {
      await store.close();
    }
  });
});
