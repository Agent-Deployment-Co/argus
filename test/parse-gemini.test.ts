import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AuxiliaryParseResult,
  DiscoveredFile,
  FileParseResult,
  ParsedAuxiliaryFragment,
  ParsedFileFragment,
} from "../src/store/store-contract.ts";
import {
  GEMINI_AUXILIARY_PARSER,
  GEMINI_TRANSCRIPT_PARSER,
  createGeminiAuxiliaryParserAdapter,
  createGeminiDiscoveryAdapter,
  createGeminiTranscriptParserAdapter,
  discoverGeminiAuxiliaryFiles,
  discoverGeminiTranscripts,
  normalizeGeminiUsage,
  parseGeminiAuxiliaryFile,
  parseGeminiTranscriptFile,
} from "../src/indexing/parse/producers/gemini/parser.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "gemini");

function currentTranscript(result: FileParseResult): ParsedFileFragment {
  if (result.status !== "current") {
    throw new Error(`Expected current transcript fragment, got ${result.status}`);
  }
  return result.fragment;
}

function currentAuxiliary(result: AuxiliaryParseResult): ParsedAuxiliaryFragment {
  if (result.status !== "current") {
    throw new Error(`Expected current auxiliary fragment, got ${result.status}`);
  }
  return result.fragment;
}

function discovered(
  files: DiscoveredFile[],
  relativePath: string,
): DiscoveredFile {
  const file = files.find((candidate) => candidate.file.relativePath === relativePath);
  if (!file) throw new Error(`Missing discovered file ${relativePath}`);
  return file;
}

function tempGemini(): string {
  return mkdtempSync(join(tmpdir(), "argus-gemini-adapter-"));
}

function writeTranscript(geminiDir: string, project: string, relativePath: string, raw: string): string {
  const path = join(geminiDir, "tmp", project, "chats", relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, raw);
  return path;
}

describe("Gemini transcript discovery", () => {
  test("recursively discovers JSONL, legacy JSON, and nested subagents", () => {
    const discovery = discoverGeminiTranscripts(FIXTURE);
    expect(discovery.status).toBe("complete");
    expect(discovery.files.map((file) => file.file.relativePath)).toEqual([
      "fixture-gemini/chats/gemini-main/subagent.jsonl",
      "fixture-gemini/chats/session-main.json",
      "fixture-gemini/chats/session-main.jsonl",
      "legacy-hash/chats/session-legacy.json",
    ]);
    expect(discovery.files.every((file) => file.file.role === "transcript")).toBe(true);
    expect(discovery.files.every((file) => file.file.source === "gemini")).toBe(true);
  });

  test("reports a missing root without claiming an authoritative empty scan", () => {
    const discovery = discoverGeminiTranscripts(join(tempGemini(), "missing"));
    expect(discovery.status).toBe("missing");
    expect(discovery.files).toEqual([]);
    expect(discovery.diagnostics[0]?.code).toBe("missing_root");
  });

  test("exposes contract-compatible adapter factories", () => {
    expect(createGeminiDiscoveryAdapter(FIXTURE).source).toBe("gemini");
    expect(createGeminiTranscriptParserAdapter().parser).toEqual(GEMINI_TRANSCRIPT_PARSER);
    expect(createGeminiAuxiliaryParserAdapter().parser).toEqual(GEMINI_AUXILIARY_PARSER);
  });
});

describe("Gemini transcript fragments", () => {
  const discovery = discoverGeminiTranscripts(FIXTURE);
  if (discovery.status !== "complete") throw new Error("Gemini fixture discovery failed");

  test("replays updates and rewinds while preserving normalized usage and positions", () => {
    const file = discovered(
      discovery.files,
      "fixture-gemini/chats/session-main.jsonl",
    );
    const fragment = currentTranscript(parseGeminiTranscriptFile(file));

    expect(fragment.parser).toEqual(GEMINI_TRANSCRIPT_PARSER);
    expect(fragment.alternateRepresentation).toEqual({
      logicalId: "gemini:gemini-main",
      representation: "jsonl",
      preference: 1,
      updatedAtMs: Date.parse("2026-06-01T10:10:00.000Z"),
    });
    expect(fragment.facts.sessions[0]).toMatchObject({
      sourceSessionId: "gemini:gemini-main",
      kind: "main",
      rawProjectId: "fixture-hash",
      firstPrompt: "gemini hello",
    });
    expect(fragment.facts.prompts!.filter((p) => p.text).map((task) => task.text)).toEqual([
      "gemini hello",
      "run the checks",
    ]);
    expect(fragment.facts.prompts!.filter((p) => p.text).map((task) => task.timestampMs)).toEqual([
      Date.parse("2026-06-01T10:00:00.000Z"),
      Date.parse("2026-06-01T10:02:00.000Z"),
    ]);
    expect(fragment.facts.tasks).toEqual([]);
    expect(fragment.facts.messages.map((message) => message.providerMessageId)).toEqual([
      "g1",
      "g3",
    ]);
    expect(fragment.facts.messages[0]).toMatchObject({
      model: "gemini-2.5-flash",
      usage: {
        input: 75,
        output: 15,
        cacheRead: 25,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
      position: {
        originKey: file.file.id,
        recordIndex: 3,
        itemIndex: 0,
      },
    });
    expect(fragment.facts.messages.some((message) => message.usage.input === 999)).toBe(false);

    const read = fragment.facts.invocations.find((invocation) => invocation.name === "read_file");
    expect(read).toMatchObject({
      invocationId: "call-1",
      timestampMs: Date.parse("2026-06-01T10:00:01.000Z"),
      filePath: "/Users/fixture/gemini-proj/a.ts",
      position: { recordIndex: 3, itemIndex: 1 },
    });
    expect(read?.args).toContain('"file_path":"/Users/fixture/gemini-proj/a.ts"');
    expect(fragment.facts.toolResults[0]).toMatchObject({
      invocationId: "call-1",
      resolvedInvocationFactId: read?.id,
      observedToolName: "read_file",
      position: { recordIndex: 3, itemIndex: 2 },
    });
    expect(fragment.facts.toolResults[0]?.approxTokens).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(fragment))).toEqual(fragment);
  });

  test("emits deterministic metadata for alternate JSON and JSONL representations", () => {
    const json = currentTranscript(
      parseGeminiTranscriptFile(
        discovered(discovery.files, "fixture-gemini/chats/session-main.json"),
      ),
    );
    const jsonl = currentTranscript(
      parseGeminiTranscriptFile(
        discovered(discovery.files, "fixture-gemini/chats/session-main.jsonl"),
      ),
    );

    expect(json.alternateRepresentation?.logicalId).toBe(
      jsonl.alternateRepresentation?.logicalId,
    );
    expect(json.alternateRepresentation).toMatchObject({
      representation: "json",
      preference: 0,
      updatedAtMs: Date.parse("2026-06-01T10:09:00.000Z"),
    });
    expect(jsonl.alternateRepresentation?.preference).toBe(1);
  });

  test("parses legacy JSON with transcript-owned cwd and first prompt", () => {
    const fragment = currentTranscript(
      parseGeminiTranscriptFile(
        discovered(discovery.files, "legacy-hash/chats/session-legacy.json"),
      ),
    );
    expect(fragment.facts.sessions[0]).toMatchObject({
      sourceSessionId: "gemini:gemini-legacy",
      kind: "main",
      cwd: "/Users/fixture/gemini-legacy",
      firstPrompt: "search the docs",
    });
    expect(fragment.facts.prompts!.filter((p) => p.text).map((task) => task.text)).toEqual(["search the docs"]);
    expect(fragment.facts.messages[0]?.usage).toEqual({
      input: 15,
      output: 5,
      cacheRead: 5,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    expect(fragment.facts.invocations[0]?.invocationId).toBe("legacy-call");
    expect(fragment.facts.toolResults[0]?.resolvedInvocationFactId).toBe(
      fragment.facts.invocations[0]?.id,
    );
  });

  test("retains nested subagent attribution and parent relationships", () => {
    const fragment = currentTranscript(
      parseGeminiTranscriptFile(
        discovered(
          discovery.files,
          "fixture-gemini/chats/gemini-main/subagent.jsonl",
        ),
      ),
    );
    expect(fragment.facts.sessions[0]).toMatchObject({
      sourceSessionId: "gemini:gemini-subagent",
      kind: "subagent",
      firstPrompt: "update the generated file",
    });
    // A subagent session's prompts are agent-authored, not human intent, so they yield no task
    // candidates (#118) — even though the session still records its firstPrompt + relationships.
    expect(fragment.facts.prompts!.filter((p) => p.text)).toEqual([]);
    expect(fragment.facts.relationships).toEqual([
      expect.objectContaining({
        childSourceSessionId: "gemini:gemini-subagent",
        parentSourceSessionId: "gemini:gemini-main",
        kind: "subagent",
      }),
    ]);
  });

  test("records malformed lines while preserving set replay, modern usage, MCP, and skill facts", () => {
    const geminiDir = tempGemini();
    const records = [
      {
        sessionId: "modern-session",
        projectHash: "modern-hash",
        lastUpdated: "2026-06-10T10:00:00.000Z",
      },
      "{not-json",
      {
        $set: {
          messages: [
            {
              id: "u1",
              timestamp: "2026-06-10T09:59:59.000Z",
              type: "user",
              content: [{ text: "inspect modern tokens" }],
            },
            {
              id: "g1",
              timestamp: "2026-06-10T10:00:00.000Z",
              type: "gemini",
              model: "gemini-modern",
              tokens: {
                promptTokenCount: 120,
                cachedContentTokenCount: 20,
                candidatesTokenCount: 8,
                thoughtsTokenCount: 4,
                toolUsePromptTokenCount: 3,
              },
              toolCalls: [
                {
                  callId: "mcp-call",
                  name: "mcp__files__read__many",
                  timestamp: "2026-06-10T10:00:00.500Z",
                  args: { path: "/tmp/a.ts" },
                  result: { llmContent: "contents" },
                },
                {
                  id: "skill-call",
                  name: "activate_skill",
                  args: { skill: "review-code", detail: "focused" },
                  result: "activated",
                },
              ],
            },
          ],
        },
      },
    ];
    writeTranscript(
      geminiDir,
      "modern-project",
      "session.jsonl",
      records
        .map((record) => (typeof record === "string" ? record : JSON.stringify(record)))
        .join("\n"),
    );
    const discoveredFiles = discoverGeminiTranscripts(geminiDir);
    if (discoveredFiles.status !== "complete") throw new Error("Temporary discovery failed");
    const fragment = currentTranscript(
      parseGeminiTranscriptFile(discoveredFiles.files[0]!),
    );

    expect(fragment.diagnostics).toEqual([
      expect.objectContaining({
        code: "malformed_record",
        position: expect.objectContaining({ recordIndex: 1 }),
      }),
    ]);
    expect(fragment.facts.sessions[0]?.firstPrompt).toBe("inspect modern tokens");
    expect(fragment.facts.messages[0]?.usage).toEqual({
      input: 100,
      output: 15,
      cacheRead: 20,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    expect(fragment.facts.invocations[0]).toMatchObject({
      invocationId: "mcp-call",
      name: "mcp__files__read__many",
      mcpServer: "files",
      mcpTool: "read__many",
      filePath: "/tmp/a.ts",
      timestampMs: Date.parse("2026-06-10T10:00:00.500Z"),
    });
    expect(fragment.facts.invocations[0]?.args).toContain('"path":"/tmp/a.ts"');
    expect(fragment.facts.invocations[1]).toMatchObject({
      invocationId: "skill-call",
      name: "activate_skill",
      skill: "review-code",
    });
    expect(fragment.facts.invocations[1]?.args).toContain('"skill":"review-code"');
    expect(new Set(fragment.facts.invocations.map((fact) => fact.position.itemIndex)).size).toBe(2);
    expect(new Set(fragment.facts.toolResults.map((fact) => fact.position.itemIndex)).size).toBe(2);
  });

  test("normalizes total-only Gemini usage without dropping the message", () => {
    expect(normalizeGeminiUsage({ totalTokenCount: 44 })).toEqual({
      input: 44,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
  });
});

describe("Gemini project auxiliary fragments", () => {
  test("discovers and parses projects.json and project markers separately", () => {
    const discovery = discoverGeminiAuxiliaryFiles(FIXTURE);
    expect(discovery.status).toBe("complete");
    expect(discovery.files.map((file) => file.file.relativePath)).toEqual([
      "projects.json",
      "tmp/fixture-gemini/.project_root",
    ]);

    const registryFile = discovered(discovery.files, "projects.json");
    const registry = currentAuxiliary(parseGeminiAuxiliaryFile(registryFile));
    const root = "/Users/fixture/gemini-proj";
    const hash = createHash("sha256").update(root).digest("hex");
    expect(registry.facts).toEqual([
      expect.objectContaining({ selector: "fixture-gemini", cwd: root }),
      expect.objectContaining({ selector: hash, cwd: root }),
    ]);

    const markerFile = discovered(
      discovery.files,
      "tmp/fixture-gemini/.project_root",
    );
    const marker = currentAuxiliary(parseGeminiAuxiliaryFile(markerFile));
    expect(marker.facts).toEqual([
      expect.objectContaining({
        selector: "fixture-gemini",
        cwd: "/Users/fixture/gemini-proj",
      }),
    ]);

    const transcripts = discoverGeminiTranscripts(FIXTURE);
    if (transcripts.status !== "complete") throw new Error("Fixture discovery failed");
    const transcript = currentTranscript(
      parseGeminiTranscriptFile(
        discovered(transcripts.files, "fixture-gemini/chats/session-main.jsonl"),
      ),
    );
    expect(transcript.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: registryFile.file.id,
          selector: "fixture-gemini",
        }),
        expect.objectContaining({
          inputId: markerFile.file.id,
          selector: "fixture-gemini",
        }),
      ]),
    );
  });

  test("metadata changes replace auxiliary facts without changing transcript fragments", () => {
    const geminiDir = tempGemini();
    mkdirSync(join(geminiDir, "tmp", "project-slug"), { recursive: true });
    writeFileSync(
      join(geminiDir, "projects.json"),
      JSON.stringify({ projects: { "/workspace/one": "project-slug" } }),
    );
    writeFileSync(join(geminiDir, "tmp", "project-slug", ".project_root"), "/workspace/marker\n");
    writeTranscript(
      geminiDir,
      "project-slug",
      "session.jsonl",
      [
        JSON.stringify({
          sessionId: "project-session",
          projectHash: "project-hash",
          lastUpdated: "2026-06-11T10:00:00.000Z",
        }),
        JSON.stringify({
          id: "g1",
          timestamp: "2026-06-11T10:00:00.000Z",
          type: "gemini",
          tokens: { input: 1 },
        }),
      ].join("\n"),
    );

    const transcriptDiscovery = discoverGeminiTranscripts(geminiDir);
    if (transcriptDiscovery.status !== "complete") throw new Error("Transcript discovery failed");
    const transcript = currentTranscript(
      parseGeminiTranscriptFile(transcriptDiscovery.files[0]!),
    );

    const firstDiscovery = discoverGeminiAuxiliaryFiles(geminiDir);
    if (firstDiscovery.status !== "complete") throw new Error("Auxiliary discovery failed");
    const firstRegistry = currentAuxiliary(
      parseGeminiAuxiliaryFile(discovered(firstDiscovery.files, "projects.json")),
    );
    expect(
      firstRegistry.facts.some(
        (fact) => fact.kind === "project_root" && fact.cwd === "/workspace/one",
      ),
    ).toBe(true);

    writeFileSync(
      join(geminiDir, "projects.json"),
      JSON.stringify({ projects: { "/workspace/a-different-root": "project-slug" } }),
    );
    const secondDiscovery = discoverGeminiAuxiliaryFiles(geminiDir);
    if (secondDiscovery.status !== "complete") throw new Error("Auxiliary rediscovery failed");
    const secondRegistry = currentAuxiliary(
      parseGeminiAuxiliaryFile(discovered(secondDiscovery.files, "projects.json")),
    );

    expect(secondRegistry.id).toBe(firstRegistry.id);
    expect(secondRegistry.snapshot.fingerprint).not.toEqual(firstRegistry.snapshot.fingerprint);
    expect(
      secondRegistry.facts.some(
        (fact) =>
          fact.kind === "project_root" && fact.cwd === "/workspace/a-different-root",
      ),
    ).toBe(true);
    expect(transcript.facts.sessions[0]).toMatchObject({
      sourceSessionId: "gemini:project-session",
      rawProjectId: "project-hash",
    });
    expect(
      transcript.dependencies.some(
        (dependency) =>
          dependency.inputId === secondRegistry.snapshot.file.id &&
          dependency.selector === "project-slug",
      ),
    ).toBe(true);
  });
});
