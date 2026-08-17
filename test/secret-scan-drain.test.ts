// The secret-scan version stamp and its backlog drain (#335): materialize stamps the scanner version,
// sessions the current scanner hasn't seen are eligible, the drain scans them from retained text and
// de-queues them, a version bump re-queues everything, and sessions with no retained text are reported
// rather than left in a backlog that never shrinks.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store/store.ts";
import { SECRET_SCAN_VERSION, secretFindingsDigest } from "../src/indexing/secret-scan.ts";
import { runSecretScanDrain } from "../src/indexing/secret-scan-drain.ts";
import type { MaterializeSession } from "../src/store/store-contract.ts";

// Synthesized, never a real credential: the AWS rule's shape (AKIA + 16 [A-Z2-7] chars, entropy ≥ 3).
const AWS_KEY = "AKIA" + "Q3G5X7BDFHJKLMNP";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-secret-drain-"));
  dirs.push(dir);
  return join(dir, "argus.db");
}

/** A session with one human interaction whose prompt text is retained — what the drain reads back. */
function session(sid: string, promptText: string, ts = 1_717_600_000_000): MaterializeSession {
  return {
    meta: { source: "claude", sessionId: sid, project: "p", cwd: "/tmp/p", filePath: "/tmp/p/r.jsonl" },
    messages: [
      {
        source: "claude",
        sessionId: sid,
        project: "p",
        cwd: "/tmp/p",
        gitBranch: "main",
        ts,
        date: "2026-06-01",
        model: "claude-opus-4",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        attributionSkill: null,
        toolUses: [],
      },
    ],
    interactions: [
      {
        id: `${sid}-i0`,
        source: "claude",
        sourceSessionId: sid,
        seq: 0,
        initiator: "human",
        disposition: "completed",
        compactionCount: 0,
        timestampMs: ts,
        promptPosition: { originKey: "f", recordIndex: 0, itemIndex: 0 },
        position: { originKey: "f", recordIndex: 0, itemIndex: 0 },
        promptText,
        responseText: "rotated it",
      },
    ],
  };
}

/** The same session as the pipeline hands it over: scanned, so materialize stamps the version. */
function scanned(s: MaterializeSession, findings: MaterializeSession["secretFindings"] = undefined) {
  const resolved = findings ?? { version: SECRET_SCAN_VERSION, digest: secretFindingsDigest([]), findings: [] };
  return { ...s, secretFindings: resolved };
}

describe("secret-scan eligibility (#335)", () => {
  test("a session materialized with a scan is stamped and not eligible", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("me", [scanned(session("s:stamped", "nothing secret here"))]);
      expect(await store.readPendingSecretScanSessions(SECRET_SCAN_VERSION, 10)).toEqual([]);
      const progress = await store.secretScanProgress(SECRET_SCAN_VERSION);
      expect(progress).toEqual({ scanned: 1, pending: 0, unscannable: 0 });
    } finally {
      await store.close();
    }
  });

  test("a session materialized without a scan is eligible — the upgraded-store case", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("me", [session("s:unscanned", `key ${AWS_KEY} oops`)]);
      expect(await store.readPendingSecretScanSessions(SECRET_SCAN_VERSION, 10)).toEqual(["s:unscanned"]);
      expect(await store.secretScanProgress(SECRET_SCAN_VERSION)).toEqual({
        scanned: 0,
        pending: 1,
        unscannable: 0,
      });
    } finally {
      await store.close();
    }
  });

  test("a newer scanner version re-queues an already-scanned session", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("me", [scanned(session("s:old-rules", "nothing secret here"))]);
      // Asked as the next scanner version would ask it: the stamp is now behind, so it comes back.
      expect(await store.readPendingSecretScanSessions(SECRET_SCAN_VERSION + 1, 10)).toEqual(["s:old-rules"]);
      expect((await store.secretScanProgress(SECRET_SCAN_VERSION + 1)).pending).toBe(1);
    } finally {
      await store.close();
    }
  });

  test("eligible sessions come back newest-first", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("me", [
        session("s:older", "a", 1_717_600_000_000),
        session("s:newer", "b", 1_717_700_000_000),
      ]);
      expect(await store.readPendingSecretScanSessions(SECRET_SCAN_VERSION, 10)).toEqual([
        "s:newer",
        "s:older",
      ]);
    } finally {
      await store.close();
    }
  });

  test("a session with no retained text is never eligible, and is reported as unscannable", async () => {
    const store = await openStore({ path: storePath() });
    try {
      // retainText off (#120): the text existed only in memory during materialize, so there is
      // nothing in the store for the drain to read back.
      await store.materializeSessions("me", [session("s:no-text", `key ${AWS_KEY} oops`)], {
        retainText: false,
      });
      expect(await store.readPendingSecretScanSessions(SECRET_SCAN_VERSION, 10)).toEqual([]);
      expect(await store.secretScanProgress(SECRET_SCAN_VERSION)).toEqual({
        scanned: 0,
        pending: 0,
        unscannable: 1,
      });
      // And the drain leaves it alone rather than stamping a scan it couldn't do.
      await runSecretScanDrain(store);
      expect((await store.secretScanProgress(SECRET_SCAN_VERSION)).unscannable).toBe(1);
    } finally {
      await store.close();
    }
  });
});

describe("secret-scan backlog drain (#335)", () => {
  test("scans an unstamped session from retained text, then de-queues it", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("me", [session("s:drain", `aws key ${AWS_KEY} pasted`)]);
      await runSecretScanDrain(store);

      const read = await store.readSessionSecretFindings("s:drain");
      expect(read.findings.map((f) => [f.category, f.hint, f.chunkType, f.interactionSeq])).toEqual([
        ["aws_access_key", "AKIA…LMNP", "prompt", 0],
      ]);
      expect(read.dismissed).toBe(false);
      // Stamped, so nothing is waiting and a second pass has nothing to do.
      expect(await store.secretScanProgress(SECRET_SCAN_VERSION)).toEqual({
        scanned: 1,
        pending: 0,
        unscannable: 0,
      });
      await runSecretScanDrain(store);
      expect((await store.readSessionSecretFindings("s:drain")).findings).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  test("a clean session is stamped too, so it doesn't come back every pass", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("me", [session("s:clean", "just an ordinary question")]);
      await runSecretScanDrain(store);
      expect(await store.readPendingSecretScanSessions(SECRET_SCAN_VERSION, 10)).toEqual([]);
      expect((await store.readSessionSecretFindings("s:clean")).findings).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("a rescan finding the same thing keeps the dismissal; a different finding set re-warns", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("me", [session("s:dismissed", `aws key ${AWS_KEY} pasted`)]);
      await runSecretScanDrain(store);
      expect(await store.dismissSessionSecretFindings("s:dismissed")).toBe(true);
      expect((await store.readSessionSecretFindings("s:dismissed")).dismissed).toBe(true);

      // Same text, so the rescan reproduces the same digest: still dismissed.
      await store.writeSessionSecretFindings("s:dismissed", {
        version: SECRET_SCAN_VERSION,
        digest: secretFindingsDigest((await store.readSessionSecretFindings("s:dismissed")).findings),
        findings: (await store.readSessionSecretFindings("s:dismissed")).findings,
      });
      expect((await store.readSessionSecretFindings("s:dismissed")).dismissed).toBe(true);

      // A rescan that finds something else (a rules refresh would) clears the dismissal by design.
      const changed = [
        { category: "github_token" as const, interactionSeq: 0, chunkType: "prompt" as const, hint: "ghp_…4bC6" },
      ];
      await store.writeSessionSecretFindings("s:dismissed", {
        version: SECRET_SCAN_VERSION,
        digest: secretFindingsDigest(changed),
        findings: changed,
      });
      const after = await store.readSessionSecretFindings("s:dismissed");
      expect(after.dismissed).toBe(false);
      expect(after.findings.map((f) => f.category)).toEqual(["github_token"]);
    } finally {
      await store.close();
    }
  });

  test("the drain's write replaces findings wholesale and leaves the rest of the session alone", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("me", [session("s:replace", `aws key ${AWS_KEY} pasted`)]);
      await runSecretScanDrain(store);
      expect((await store.readSessionSecretFindings("s:replace")).findings).toHaveLength(1);

      // Nothing found this time: the old row goes, the stamp stays.
      await store.writeSessionSecretFindings("s:replace", {
        version: SECRET_SCAN_VERSION,
        digest: secretFindingsDigest([]),
        findings: [],
      });
      expect((await store.readSessionSecretFindings("s:replace")).findings).toEqual([]);
      expect(await store.readPendingSecretScanSessions(SECRET_SCAN_VERSION, 10)).toEqual([]);
      // The session itself is untouched — the drain never re-materializes.
      expect((await store.readResolved()).sessions.has("s:replace")).toBe(true);
      expect(await store.readSessionInteractionCount("s:replace")).toBe(1);
    } finally {
      await store.close();
    }
  });

  test("re-materializing without a scan hands the session back to the drain", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("me", [scanned(session("s:remat", `aws key ${AWS_KEY} pasted`))]);
      // A materialize that didn't scan: the wholesale replace cascades the findings away, so the stamp
      // must go with them rather than claiming a scan with nothing to show.
      await store.materializeSessions("me", [session("s:remat", `aws key ${AWS_KEY} pasted`)]);
      expect(await store.readPendingSecretScanSessions(SECRET_SCAN_VERSION, 10)).toEqual(["s:remat"]);
      await runSecretScanDrain(store);
      expect((await store.readSessionSecretFindings("s:remat")).findings).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});
