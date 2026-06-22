import { describe, expect, test } from "bun:test";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  compareReconciliationOrder,
  createFactId,
  createFileIdentity,
  isAuthoritativeDiscovery,
  sameFileFingerprint,
  type DiscoveryResult,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
} from "../src/store-contract.ts";

const transcriptFile = {
  id: "claude:projects:transcript:session.jsonl",
  source: "claude" as const,
  rootId: "claude-projects",
  role: "transcript" as const,
  relativePath: "session.jsonl",
  path: "/tmp/projects/session.jsonl",
};

const fingerprint = {
  sizeBytes: "123",
  mtimeNs: "1717605000000000000",
  ctimeNs: "1717605000000000001",
  physicalId: { scheme: "posix_dev_inode" as const, value: "16777234:9007199254740993" },
};

const position = (recordIndex: number, itemIndex = 0) => ({
  originKey: transcriptFile.id,
  recordIndex,
  itemIndex,
});

const fragment: ParsedFileFragment = {
  kind: "transcript",
  id: `fragment:${transcriptFile.id}`,
  contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
  parser: { name: "claude-jsonl", source: "claude", version: "1" },
  snapshot: { file: transcriptFile, fingerprint, attempts: 1 },
  facts: {
    sessions: [
      {
        id: "session:session-1",
        source: "claude",
        sourceSessionId: "session-1",
        kind: "main",
        transcriptPath: transcriptFile.path,
        cwd: "/tmp/project",
        gitBranch: "main",
        position: position(0),
      },
    ],
    messages: [
      {
        id: "message:m1",
        source: "claude",
        sourceSessionId: "session-1",
        providerMessageId: "m1",
        timestampMs: 1_717_605_000_000,
        model: "claude-sonnet-4-6",
        usage: { input: 10, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 },
        cwd: "/tmp/project",
        gitBranch: "main",
        attributionSkill: "jj:jj",
        position: position(2),
      },
    ],
    invocations: [
      {
        id: "invocation:tool-1",
        source: "claude",
        sourceSessionId: "session-1",
        messageId: "message:m1",
        invocationId: "tool-1",
        timestampMs: 1_717_605_000_100,
        name: "Read",
        filePath: "/tmp/project/a.ts",
        position: position(2, 1),
      },
    ],
    toolResults: [
      {
        id: "result:tool-1",
        source: "claude",
        sourceSessionId: "session-1",
        invocationId: "tool-1",
        resolvedInvocationFactId: "invocation:tool-1",
        observedToolName: "Read",
        approxTokens: 12,
        position: position(3),
      },
    ],
    taskCandidates: [],
    tasks: [],
    relationships: [
      {
        id: "relationship:subagent",
        source: "claude",
        childSourceSessionId: "session-1:subagent",
        parentSourceSessionId: "session-1",
        kind: "subagent",
        position: position(4),
      },
    ],
  },
  dependencies: [
    {
      inputId: "claude:history",
      selector: "session-1",
      affects: ["session_first_prompt"],
    },
  ],
  diagnostics: [
    {
      code: "malformed_record",
      severity: "warning",
      phase: "parse",
      message: "Skipped malformed JSON record",
      position: position(5),
    },
  ],
};

const codexFragment: ParsedFileFragment = {
  kind: "transcript",
  id: "fragment:codex-session",
  contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
  parser: { name: "codex-jsonl", source: "codex", version: "1" },
  snapshot: {
    file: {
      id: "codex:sessions:rollout.jsonl",
      source: "codex",
      rootId: "codex-sessions",
      role: "transcript",
      relativePath: "2026/06/rollout.jsonl",
      path: "/tmp/codex/2026/06/rollout.jsonl",
    },
    fingerprint: { sizeBytes: "456", mtimeNs: "1717605000000000002" },
    attempts: 1,
  },
  facts: {
    sessions: [
      {
        id: "session:codex-1",
        source: "codex",
        sourceSessionId: "codex:1",
        kind: "main",
        transcriptPath: "/tmp/codex/2026/06/rollout.jsonl",
        cwd: "/tmp/project",
        firstPrompt: "Fix the tests.",
        position: { originKey: "codex:sessions:rollout.jsonl", recordIndex: 0, itemIndex: 0 },
      },
    ],
    messages: [
      {
        id: "message:token-event-1",
        source: "codex",
        sourceSessionId: "codex:1",
        timestampMs: 1_717_605_100_000,
        model: "gpt-5.4",
        usage: { input: 100, output: 20, cacheRead: 50, cacheWrite5m: 0, cacheWrite1h: 0 },
        cwd: "/tmp/project",
        attributionSkill: null,
        position: { originKey: "codex:sessions:rollout.jsonl", recordIndex: 4, itemIndex: 0 },
      },
    ],
    invocations: [
      {
        id: "invocation:codex-call-1",
        source: "codex",
        sourceSessionId: "codex:1",
        messageId: "message:token-event-1",
        invocationId: "call-1",
        name: "exec_command",
        position: { originKey: "codex:sessions:rollout.jsonl", recordIndex: 3, itemIndex: 0 },
      },
    ],
    toolResults: [],
    taskCandidates: [
      {
        id: "task-candidate:codex-1",
        source: "codex",
        sourceSessionId: "codex:1",
        timestampMs: 1_717_605_099_000,
        text: "Fix the tests.",
        position: { originKey: "codex:sessions:rollout.jsonl", recordIndex: 3, itemIndex: 0 },
      },
    ],
    tasks: [
      {
        id: "task:codex-1",
        source: "codex",
        sourceSessionId: "codex:1",
        timestampMs: 1_717_605_099_000,
        description: "Fix the tests.",
        evidence: "message indexes: 0",
        evidenceKind: "llm_inference",
        position: { originKey: "codex:sessions:rollout.jsonl", recordIndex: 3, itemIndex: 0 },
      },
    ],
    relationships: [],
  },
  dependencies: [],
  diagnostics: [],
};

const geminiFragment: ParsedFileFragment = {
  kind: "transcript",
  id: "fragment:gemini-session",
  contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
  parser: { name: "gemini-chat", source: "gemini", version: "1" },
  snapshot: {
    file: {
      id: "gemini:chats:session.jsonl",
      source: "gemini",
      rootId: "gemini-chats",
      role: "transcript",
      relativePath: "project/chats/session.jsonl",
      path: "/tmp/gemini/project/chats/session.jsonl",
    },
    fingerprint: { sizeBytes: "789", mtimeNs: "1717605000000000003" },
    attempts: 1,
  },
  alternateRepresentation: {
    logicalId: "gemini:1",
    representation: "jsonl",
    preference: 1,
    updatedAtMs: 1_717_605_300_000,
  },
  facts: {
    sessions: [
      {
        id: "session:gemini-1",
        source: "gemini",
        sourceSessionId: "gemini:1",
        kind: "main",
        transcriptPath: "/tmp/gemini/project/chats/session.jsonl",
        rawProjectId: "project-hash",
        firstPrompt: "Read the file.",
        position: { originKey: "gemini:chats:session.jsonl", recordIndex: 0, itemIndex: 0 },
      },
    ],
    messages: [
      {
        id: "message:gemini-1",
        source: "gemini",
        sourceSessionId: "gemini:1",
        providerMessageId: "gemini-message-1",
        timestampMs: 1_717_605_200_000,
        model: "gemini-2.5-flash",
        usage: { input: 75, output: 15, cacheRead: 25, cacheWrite5m: 0, cacheWrite1h: 0 },
        attributionSkill: null,
        position: { originKey: "gemini:chats:session.jsonl", recordIndex: 2, itemIndex: 0 },
      },
    ],
    invocations: [
      {
        id: "invocation:gemini-call-1",
        source: "gemini",
        sourceSessionId: "gemini:1",
        messageId: "message:gemini-1",
        invocationId: "gemini-call-1",
        name: "read_file",
        filePath: "/tmp/project/a.ts",
        position: { originKey: "gemini:chats:session.jsonl", recordIndex: 2, itemIndex: 1 },
      },
    ],
    toolResults: [
      {
        id: "result:gemini-call-1",
        source: "gemini",
        sourceSessionId: "gemini:1",
        invocationId: "gemini-call-1",
        resolvedInvocationFactId: "invocation:gemini-call-1",
        observedToolName: "read_file",
        approxTokens: 8,
        position: { originKey: "gemini:chats:session.jsonl", recordIndex: 2, itemIndex: 2 },
      },
    ],
    taskCandidates: [],
    tasks: [],
    relationships: [],
  },
  dependencies: [
    {
      inputId: "gemini:project-registry",
      selector: "project-hash",
      affects: ["session_cwd", "session_project"],
    },
  ],
  diagnostics: [],
};

const auxiliary: ParsedAuxiliaryFragment = {
  kind: "auxiliary",
  id: "auxiliary:claude-history",
  contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
  parser: { name: "claude-history", source: "claude", version: "1" },
  snapshot: {
    file: {
      id: "claude:history",
      source: "claude",
      rootId: "claude-config",
      role: "history",
      relativePath: "history.jsonl",
      path: "/tmp/history.jsonl",
    },
    fingerprint: { sizeBytes: "20", mtimeNs: "1717604000000000000" },
    attempts: 1,
  },
  facts: [
    {
      id: "prompt:session-1",
      kind: "session_first_prompt",
      source: "claude",
      sourceSessionId: "session-1",
      firstPrompt: "Inspect the cache.",
      timestampMs: 1_717_604_000_000,
      position: { originKey: "claude:history", recordIndex: 0, itemIndex: 0 },
    },
  ],
  diagnostics: [],
};

describe("cache fragment contract", () => {
  test("round-trips all native sources and auxiliary facts through JSON", () => {
    for (const value of [fragment, codexFragment, geminiFragment, auxiliary]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
    expect(fragment.facts.invocations[0]?.invocationId).toBe("tool-1");
    expect(codexFragment.facts.messages[0]?.id).toBe("message:token-event-1");
    expect(geminiFragment.facts.sessions[0]?.rawProjectId).toBe("project-hash");
    expect(geminiFragment.alternateRepresentation?.representation).toBe("jsonl");
    expect(fragment.facts.toolResults[0]?.sourceSessionId).toBe("session-1");
  });

  test("compares full fingerprints without number-coercing filesystem identities", () => {
    expect(sameFileFingerprint(fingerprint, { ...fingerprint })).toBe(true);
    expect(
      sameFileFingerprint(fingerprint, {
        ...fingerprint,
        physicalId: { ...fingerprint.physicalId, value: "16777234:9007199254740994" },
      }),
    ).toBe(false);
    expect(sameFileFingerprint(fingerprint, { ...fingerprint, sizeBytes: "124" })).toBe(false);
  });

  test("builds stable, namespace-scoped file and fact identities", () => {
    const fileInput = {
      source: "claude" as const,
      rootId: "claude-projects",
      role: "transcript" as const,
      relativePath: "project/session.jsonl",
      path: "/tmp/projects/project/session.jsonl",
    };
    const first = createFileIdentity(fileInput);
    const movedRoot = createFileIdentity({
      ...fileInput,
      path: "/different/absolute/root/project/session.jsonl",
    });
    const otherRelativePath = createFileIdentity({
      ...fileInput,
      relativePath: "other/session.jsonl",
    });

    expect(first.id).toBe(movedRoot.id);
    expect(first.id).not.toBe(otherRelativePath.id);

    const factPosition = { originKey: first.id, recordIndex: 4, itemIndex: 1 };
    expect(createFactId("message", "claude", "session-1", factPosition, "m1")).toBe(
      createFactId("message", "claude", "session-1", factPosition, "m1"),
    );
    expect(createFactId("message", "claude", "session-1", factPosition, "m1")).not.toBe(
      createFactId("invocation", "claude", "session-1", factPosition, "m1"),
    );
  });

  test("only complete discovery is authoritative for deletion", () => {
    const complete: DiscoveryResult = {
      status: "complete",
      source: "claude",
      rootId: "claude-projects",
      rootPath: "/tmp/projects",
      files: [],
      diagnostics: [],
    };
    const partial: DiscoveryResult = {
      status: "partial",
      source: "claude",
      rootId: "claude-projects",
      rootPath: "/tmp/projects",
      files: [],
      diagnostics: [
        {
          code: "unreadable_directory",
          severity: "error",
          phase: "discovery",
          message: "Permission denied",
        },
      ],
    };

    expect(isAuthoritativeDiscovery(complete)).toBe(true);
    expect(isAuthoritativeDiscovery(partial)).toBe(false);
  });

  test("uses session-scoped deterministic ordering when timestamps tie", () => {
    const unordered = [
      {
        timestampMs: 100,
        source: "claude" as const,
        sourceSessionId: "session-b",
        position: { originKey: "b", recordIndex: 0, itemIndex: 0 },
        stableId: "b",
      },
      {
        timestampMs: 100,
        source: "codex" as const,
        sourceSessionId: "session-a",
        position: { originKey: "a", recordIndex: 0, itemIndex: 0 },
        stableId: "a",
      },
      {
        timestampMs: 100,
        source: "claude" as const,
        sourceSessionId: "session-a",
        position: { originKey: "a", recordIndex: 1, itemIndex: 0 },
        stableId: "c",
      },
      {
        timestampMs: 100,
        source: "claude" as const,
        sourceSessionId: "session-a",
        position: { originKey: "a", recordIndex: 0, itemIndex: 0 },
        stableId: "a",
      },
    ];

    expect(unordered.sort(compareReconciliationOrder).map((item) => item.stableId)).toEqual([
      "a",
      "c",
      "b",
      "a",
    ]);
  });
});
