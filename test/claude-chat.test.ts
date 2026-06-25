import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import {
  CLAUDE_CHAT_TRANSCRIPT_PARSER,
  createClaudeChatTranscriptParserAdapter,
  discoverClaudeChatProjects,
  discoverClaudeChatTranscripts,
  parseClaudeChatProjectsFile,
} from "../src/indexing/parse/producers/claude-chat/parser.ts";
import { selectAlternateRepresentations } from "../src/indexing/reconcile.ts";
import { parseFixtures } from "./helpers/parse-fixtures.ts";
import type { ParsedFileFragment } from "../src/store/store-contract.ts";

const SIMPLE_FILE_MAGIC = 0xfcfb6d1ba7725c30n;
const ORG = "00000000-0000-4000-8000-0000000000aa";

/** Build a synthetic Chromium Simple Cache entry: header + URL key + zstd-compressed body, plus a few
 *  trailing bytes standing in for the stream-0 HTTP headers (the decoder must ignore them). */
function buildCacheEntry(url: string, body: string): Buffer {
  const key = Buffer.from(url, "utf8");
  const header = Buffer.alloc(20);
  header.writeBigUInt64LE(SIMPLE_FILE_MAGIC, 0);
  header.writeUInt32LE(1, 8); // version
  header.writeUInt32LE(key.length, 12);
  header.writeUInt32LE(0, 16); // key_hash — unused by the reader
  const compressed = zlib.zstdCompressSync(Buffer.from(body, "utf8"));
  const trailer = Buffer.from("\x00stream0-http-headers-go-here", "utf8");
  return Buffer.concat([header, key, compressed, trailer]);
}

/** A Simple Cache entry whose body is NOT zstd (e.g. a tiny identity-encoded response). */
function buildRawCacheEntry(url: string, rawBody: string): Buffer {
  const key = Buffer.from(url, "utf8");
  const header = Buffer.alloc(20);
  header.writeBigUInt64LE(SIMPLE_FILE_MAGIC, 0);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(key.length, 12);
  header.writeUInt32LE(0, 16);
  return Buffer.concat([header, key, Buffer.from(rawBody, "utf8")]);
}

function projectsUrl(): string {
  return `https://claude.ai/api/organizations/${ORG}/projects?include_harmony_projects=true&limit=200`;
}

function transcriptUrl(uuid: string): string {
  return `https://claude.ai/api/organizations/${ORG}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong`;
}

function conversation(uuid: string, messages: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    uuid,
    name: "Synthetic conversation",
    model: "claude-opus-4-8",
    created_at: "2026-06-01T10:00:00.000Z",
    updated_at: "2026-06-01T10:05:00.000Z",
    chat_messages: messages,
    ...extra,
  });
}

const HUMAN = {
  uuid: "msg-human-1",
  sender: "human",
  text: "Help me plan a weekend trip to the coast",
  content: [{ type: "text", text: "Help me plan a weekend trip to the coast" }],
  created_at: "2026-06-01T10:00:00.000Z",
};
const ASSISTANT = {
  uuid: "msg-assistant-1",
  sender: "assistant",
  text: "",
  stop_reason: "end_turn",
  created_at: "2026-06-01T10:01:00.000Z",
  content: [
    { type: "thinking", text: "Considering options for a coastal weekend." },
    { type: "tool_use", id: "toolu_search1", name: "web_search", input: { query: "coastal weekend trips" } },
    {
      type: "tool_result",
      tool_use_id: "toolu_search1",
      name: "web_search",
      content: [{ type: "knowledge", title: "Best coastal towns", url: "https://example.com" }],
    },
    { type: "text", text: "Here is a detailed two-day itinerary for your coastal weekend trip." },
  ],
};

function seedCache(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-claude-chat-"));
  // Richer snapshot of the conversation (both messages).
  writeFileSync(join(dir, "aaaa1111_0"), buildCacheEntry(transcriptUrl("conv-1"), conversation("conv-1", [HUMAN, ASSISTANT])));
  // Older, thinner snapshot of the SAME conversation (human only) — should lose the dedupe.
  writeFileSync(join(dir, "bbbb2222_0"), buildCacheEntry(transcriptUrl("conv-1"), conversation("conv-1", [HUMAN], { updated_at: "2026-06-01T09:00:00.000Z" })));
  // A list-endpoint response (not a transcript) — discovery must ignore it.
  writeFileSync(
    join(dir, "cccc3333_0"),
    buildCacheEntry(`https://claude.ai/api/organizations/${ORG}/chat_conversations?limit=5&starred=false`, JSON.stringify({ conversations: [] })),
  );
  // A non-Simple-Cache file — discovery must ignore it.
  writeFileSync(join(dir, "the-real-index"), Buffer.from("not a cache entry"));
  return dir;
}

describe("claude-chat producer", () => {
  test("discovers only full chat transcripts, decodes zstd, and emits estimated facts", () => {
    const dir = seedCache();
    try {
      const discovery = discoverClaudeChatTranscripts(dir);
      expect(discovery.status).toBe("complete");
      // Two transcript snapshots for conv-1; the list endpoint and the index file are excluded.
      expect(discovery.files.length).toBe(2);

      const adapter = createClaudeChatTranscriptParserAdapter();
      const richer = discovery.files.find((f) => f.file.path.includes("aaaa1111"))!;
      const result = adapter.parseFile(richer);
      expect(result.status).toBe("current");
      if (result.status !== "current") return;
      const facts = result.fragment.facts;

      // Session
      expect(facts.sessions).toHaveLength(1);
      const session = facts.sessions[0]!;
      expect(session.source).toBe("claude-chat");
      expect(session.sourceSessionId).toBe("claude-chat:conv-1");
      expect(session.kind).toBe("main");
      expect(session.firstPrompt).toContain("weekend trip");
      expect(session.userMessages).toBe(1);
      expect(session.agentMessages).toBe(1);

      // Prompt fact (human turn → task start)
      const prompts = facts.prompts ?? [];
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.initiator).toBe("human");
      expect(prompts[0]!.text).toContain("weekend trip");
      expect(prompts[0]!.dedupKey).toBe("msg-human-1");

      // Estimated usage on the assistant turn, priced under the conversation model.
      expect(facts.messages).toHaveLength(1);
      const usage = facts.messages[0]!;
      expect(usage.model).toBe("claude-opus-4-8");
      expect(usage.usage.output).toBeGreaterThan(0); // estimated from assistant text length
      expect(usage.usage.input).toBeGreaterThan(0); // estimated from the preceding human turn
      expect(usage.stopReason).toBe("end_turn");

      // Tool call + result correlated by tool_use_id.
      expect(facts.invocations).toHaveLength(1);
      expect(facts.invocations[0]!.name).toBe("web_search");
      expect(facts.toolResults).toHaveLength(1);
      expect(facts.toolResults[0]!.resolvedInvocationFactId).toBe(facts.invocations[0]!.id);
      expect(facts.toolResults[0]!.approxTokens).toBeGreaterThan(0);

      // AlternateRepresentation keyed by uuid with preference = message count.
      expect(result.fragment.alternateRepresentation?.logicalId).toBe("claude-chat:conv-1");
      expect(result.fragment.alternateRepresentation?.preference).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dedupes snapshots of one conversation, keeping the richest copy", () => {
    const dir = seedCache();
    try {
      const discovery = discoverClaudeChatTranscripts(dir);
      const adapter = createClaudeChatTranscriptParserAdapter();
      const fragments = discovery.files
        .map((f) => adapter.parseFile(f))
        .filter((r): r is { status: "current"; fragment: ParsedFileFragment } => r.status === "current")
        .map((r) => r.fragment);
      expect(fragments).toHaveLength(2);

      const selected = selectAlternateRepresentations(fragments);
      expect(selected).toHaveLength(1);
      // The richer snapshot (2 messages, preference 2) wins over the thinner one.
      expect(selected[0]!.alternateRepresentation?.preference).toBe(2);
      expect(selected[0]!.facts.messages).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flows end-to-end through the pipeline as a claude-chat session", async () => {
    const dir = seedCache();
    try {
      const parsed = await parseFixtures({ sources: ["claude-chat"], claudeChatCacheDir: dir });
      // One conversation after uuid dedupe, materialized under the claude-chat source.
      expect(parsed.sessions.size).toBe(1);
      const session = [...parsed.sessions.values()][0]!;
      expect(session.source).toBe("claude-chat");
      expect(session.project).toBe("claude.ai chat");
      expect(parsed.messages.length).toBe(1);
      expect(parsed.messages[0]!.source).toBe("claude-chat");
      expect(parsed.messages[0]!.model).toBe("claude-opus-4-8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parser descriptor identifies the claude-chat source", () => {
    expect(CLAUDE_CHAT_TRANSCRIPT_PARSER.source).toBe("claude-chat");
  });

  test("skips an undecodable projects entry without a hard read error", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-claude-chat-rawproj-"));
    try {
      // A real-world case: a tiny, non-zstd projects response (no zstd frame to decode).
      writeFileSync(join(dir, "rawproj_0"), buildRawCacheEntry(projectsUrl(), "[]"));
      const aux = discoverClaudeChatProjects(dir);
      expect(aux.files).toHaveLength(1);
      const result = parseClaudeChatProjectsFile(aux.files[0]!);
      // Best-effort: current with no facts (NOT "failed", which would inflate "couldn't be read").
      expect(result.status).toBe("current");
      if (result.status === "current") {
        expect(result.fragment.facts).toEqual([]);
        expect(result.fragment.diagnostics.every((d) => d.severity !== "error")).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves a conversation's claude.ai project to its name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-claude-chat-proj-"));
    try {
      const PROJECT_UUID = "019e23aa-6f5f-76b2-8811-61a88cef40a3";
      // A conversation started inside a claude.ai Project carries project_uuid.
      writeFileSync(
        join(dir, "proj-conv_0"),
        buildCacheEntry(transcriptUrl("conv-proj"), conversation("conv-proj", [HUMAN, ASSISTANT], { project_uuid: PROJECT_UUID })),
      );
      // A loose conversation (no project) — should keep the fallback label.
      writeFileSync(join(dir, "loose-conv_0"), buildCacheEntry(transcriptUrl("conv-loose"), conversation("conv-loose", [HUMAN, ASSISTANT])));
      // The Projects inventory endpoint maps the uuid → name. /projects is a bare array.
      writeFileSync(
        join(dir, "projects_0"),
        buildCacheEntry(
          `https://claude.ai/api/organizations/${ORG}/projects?include_harmony_projects=true`,
          JSON.stringify([{ uuid: PROJECT_UUID, name: "Test Project" }]),
        ),
      );

      // Auxiliary discovery finds the projects endpoint and the parser yields a project-root fact.
      const aux = discoverClaudeChatProjects(dir);
      expect(aux.files).toHaveLength(1);
      const auxResult = parseClaudeChatProjectsFile(aux.files[0]!);
      expect(auxResult.status).toBe("current");
      if (auxResult.status === "current") {
        expect(auxResult.fragment.facts).toEqual([
          expect.objectContaining({ kind: "project_root", source: "claude-chat", selector: PROJECT_UUID, cwd: "Test Project" }),
        ]);
      }

      // End-to-end: the project conversation is labelled by its project; the loose one falls back.
      const parsed = await parseFixtures({ sources: ["claude-chat"], claudeChatCacheDir: dir });
      const projSession = parsed.sessions.get("claude-chat:conv-proj");
      const looseSession = parsed.sessions.get("claude-chat:conv-loose");
      expect(projSession?.project).toBe("Test Project");
      expect(looseSession?.project).toBe("claude.ai chat");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
