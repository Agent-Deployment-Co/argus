// A producer owns one source: how to discover + parse its sessions, and what it observes
// (capabilities the reconcile engine reads generically). Adding a source is a single new file under
// src/producers/<id>.ts plus one line in src/producers/index.ts — nothing else in the pipeline
// changes. Producers parse local transcripts.
import type {
  AuxiliaryParserAdapter,
  DiscoveryResult,
  FileParseResult,
  TranscriptParserAdapter,
} from "./store-contract.ts";
import type { ProducerCapabilities } from "./reconcile.ts";
import type { DialogueTurn } from "./dialogue.ts";
import type { AgentSource } from "./types.ts";

/** Filesystem locations + options a producer needs to discover its sessions. */
export interface ProducerContext {
  projectsDir?: string;
  historyFile?: string;
  codexSessionsDir?: string;
  geminiDir?: string;
  coworkSessionsDir?: string;
}

/** A native producer: discovers and parses local transcripts (+ optional auxiliary inputs). */
export interface NativeProducer {
  readonly id: string;
  readonly source: AgentSource;
  readonly capabilities: ProducerCapabilities;
  /** Authoritative transcript discovery for this run. */
  discoverTranscripts(ctx: ProducerContext): DiscoveryResult;
  transcriptParser(): TranscriptParserAdapter;
  /** Parse one transcript path directly, for source-owned per-session operations. */
  parseTranscriptPath(path: string): FileParseResult;
  /**
   * All transcript files for one session, discovered fresh from disk given its main transcript path
   * — e.g. Claude's main transcript plus its subagent transcripts. Lets single-session reindex pick
   * up files (subagents) added since the last full index. Omit when a session is always one file.
   */
  discoverSessionTranscripts?(mainTranscriptPath: string): string[];
  /**
   * Reconstruct the ordered human↔assistant dialogue for one transcript (#91), stripping tool-call
   * noise. The transcript file format is this producer's concern, so each owns its reconstruction.
   * The result is an in-memory analysis intermediate — never persisted.
   */
  reconstructDialogue(path: string): DialogueTurn[];
  /** Optional auxiliary inputs (claude history first-prompts, gemini project roots). */
  discoverAuxiliary?(ctx: ProducerContext): DiscoveryResult;
  auxiliaryParser?(): AuxiliaryParserAdapter;
}
