import { createHash } from "node:crypto";
import type { FrictionEvent } from "../indexing/friction.ts";
import type { AgentSource, MessageRecord, ParseResult, SessionMeta, Usage } from "../types.ts";

/**
 * Increment when serialized fragment semantics change incompatibly.
 * Source parser versions remain independent so one adapter can invalidate narrowly.
 * v2: dropped external (AgentsView) import fragments — stale stores re-parse from disk.
 */
export const PARSED_FRAGMENT_CONTRACT_VERSION = 2;

/** Decimal string used for filesystem values that may exceed JavaScript's safe integer range. */
export type SerializedInt64 = string;

export type FileRole =
  | "transcript"
  | "history"
  | "project_registry"
  | "project_marker"
  | "external_database";

export interface FileIdentity {
  /** Stable hash/key of source, rootId, role, and relativePath. */
  id: string;
  source?: AgentSource;
  rootId: string;
  role: FileRole;
  relativePath: string;
  /** Observed path for I/O and diagnostics; not the sole correlation identity. */
  path: string;
}

export type FileIdentityInput = Omit<FileIdentity, "id">;

export interface PhysicalFileIdentity {
  scheme: "posix_dev_inode" | "windows_file_identity";
  value: string;
}

export interface FileFingerprint {
  sizeBytes: SerializedInt64;
  mtimeNs: SerializedInt64;
  ctimeNs?: SerializedInt64;
  physicalId?: PhysicalFileIdentity;
}

export interface StableFileSnapshot {
  file: FileIdentity;
  fingerprint: FileFingerprint;
  /** Number of pre-read/post-read attempts required to obtain this stable snapshot. */
  attempts: number;
}

export interface DiscoveredFile {
  file: FileIdentity;
  fingerprint: FileFingerprint;
}

export type DiagnosticSeverity = "info" | "warning" | "error";
export type DiagnosticPhase = "discovery" | "snapshot" | "parse" | "reconcile" | "import";

/** Source position is also valid for database rows through an adapter-owned originKey. */
export interface SourcePosition {
  originKey: string;
  recordIndex: number;
  itemIndex: number;
  byteOffset?: number;
}

export type FactKind =
  | "session"
  | "prompt"
  | "interaction"
  | "message"
  | "invocation"
  | "tool_result"
  | "task_candidate"
  | "relationship"
  | "task";

export interface ParserDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  phase: DiagnosticPhase;
  message: string;
  position?: SourcePosition;
}

export interface CompleteDiscovery {
  status: "complete";
  source: AgentSource;
  rootId: string;
  rootPath: string;
  files: DiscoveredFile[];
  diagnostics: ParserDiagnostic[];
}

export interface IncompleteDiscovery {
  status: "missing" | "unreadable" | "partial";
  source: AgentSource;
  rootId: string;
  rootPath: string;
  /** Files observed before discovery became incomplete. This is not an authoritative set. */
  files: DiscoveredFile[];
  diagnostics: ParserDiagnostic[];
}

export type DiscoveryResult = CompleteDiscovery | IncompleteDiscovery;

export interface ParserDescriptor {
  name: string;
  source: AgentSource;
  version: string;
}

export type SessionKind = "main" | "subagent" | "unknown";

export interface SessionFact {
  id: string;
  source: AgentSource;
  sourceSessionId: string;
  kind: SessionKind;
  transcriptPath: string;
  cwd?: string;
  gitBranch?: string;
  /** Gemini hash/slug or another source identity used by auxiliary resolution. */
  rawProjectId?: string;
  /** Native prompt when the transcript itself owns it (for example Codex or Gemini). */
  firstPrompt?: string;
  /** Raw user-message events observed in this session, when the source exposes them. */
  userMessages?: number;
  /** Raw agent-message events observed in this session, when the source exposes them. */
  agentMessages?: number;
  /** Raw conversational turns observed in this session, when the source exposes them. */
  rawTurns?: number;
  /**
   * Session friction events (#37) observed in this file, identified stably so the
   * reconciler can dedupe replays across resumed-session files. Claude only.
   */
  frictionEvents?: FrictionEvent[];
  position: SourcePosition;
}

/**
 * Token usage as metered by the provider at the assistant-turn grain (Claude `message.usage`, Codex
 * `token_count` events). Named for what it is — the model retires "message" as a unit of meaning; a
 * raw record is an *event* and this is the usage it carries. Not a structural unit: it is a metered
 * detail inside an interaction's loop. A row exists at this grain because cost is priced per-model
 * (SUM-then-price is exact only within one model). (#117 will attribute it to its owning interaction.)
 */
export interface UsageFact {
  id: string;
  source: AgentSource;
  sourceSessionId: string;
  /** Owning interaction (#117). Optional until producers emit interactions. */
  interactionId?: string;
  providerMessageId?: string;
  requestId?: string;
  timestampMs: number;
  model: string;
  usage: Usage;
  cwd?: string;
  gitBranch?: string;
  attributionSkill: string | null;
  /** Assistant stop_reason — first non-null value across the message's streamed lines. */
  stopReason?: string;
  position: SourcePosition;
}

/** Who authored an interaction's opening prompt (see docs/session-model.md). Only `human`-initiated
 *  prompts carry intent — task interpretation filters on this. */
export type InteractionInitiator = "human" | "agent" | "harness";

/** How an interaction's loop ended — a fact (mechanical), distinct from a task's interpreted outcome.
 *  `interrupted` = a known human interrupt (a friction signal); `incomplete` = stopped with no
 *  response, cause unknown; `error` = the loop failed. */
export type InteractionDisposition = "completed" | "interrupted" | "incomplete" | "error";

/**
 * A producer-emitted marker for one interaction-opening prompt (a user-role turn that opens an
 * exchange — not a tool-result delivery). Reconcile groups the deduped/ordered timeline into
 * InteractionFacts using these as the opening boundaries. Only `human`-initiated prompts open a
 * (main-session) interaction; `agent` markers (a subagent session's own prompts, folded onto the
 * parent) are loop content, never new openings — this is what keeps subagent prompts from becoming
 * phantom interactions/tasks (#118). Carries `dedupKey` (a replay-stable id like the record uuid)
 * so a resumed session's replayed prompt collapses to one in reconcile.
 */
export interface PromptFact {
  id: string;
  source: AgentSource;
  sourceSessionId: string;
  initiator: InteractionInitiator;
  timestampMs?: number;
  /** Replay-stable identity (e.g. record uuid) for dedup across resumed-session files; falls back to
   *  position when the source has no stable id. */
  dedupKey?: string;
  position: SourcePosition;
}

/**
 * One interaction: prompt → agent loop → response (see docs/session-model.md). The atomic unit of a
 * session. **Reconcile-derived**, not a per-file fact: reconcile groups the deduped timeline into
 * these. Text is NOT stored — the slot positions let Interpret re-read prompt/response from disk
 * without re-deriving structure from role tags. Tasks (#122) will span interactions.
 */
export interface InteractionFact {
  id: string;
  source: AgentSource;
  sourceSessionId: string;
  /** Ordinal within its session, in source/timeline order (0-based). */
  seq: number;
  /** Who authored the opening prompt. */
  initiator: InteractionInitiator;
  /** How the loop ended. */
  disposition: InteractionDisposition;
  /** Times the harness compacted context *during* this interaction's loop (usually 0). Not a boundary. */
  compactionCount: number;
  /** Interaction start time (the opening prompt's timestamp) when the source carries one. */
  timestampMs?: number;
  /** Position of the opening prompt's text. */
  promptPosition: SourcePosition;
  /** Position of the response slot, when the interaction produced one (absent if interrupted/incomplete). */
  responsePosition?: SourcePosition;
  position: SourcePosition;
}

export interface InvocationFact {
  id: string;
  source: AgentSource;
  sourceSessionId: string;
  /** Usage-bearing message/token event that owns this invocation. */
  messageId: string;
  /** Owning interaction (#117). Optional until producers emit interactions; pairs with `messageId`. */
  interactionId?: string;
  invocationId?: string;
  timestampMs?: number;
  name: string;
  skill?: string;
  args?: string;
  mcpServer?: string;
  mcpTool?: string;
  filePath?: string;
  /** Position of this call's paired tool result (the result half of the call+result unit), when present. */
  resultPosition?: SourcePosition;
  /** Permission outcome for this call: a human approval, a denial (human or policy), or auto-approved
   *  under policy. A primary friction signal. Absent when the source doesn't expose it. */
  permissionDecision?: "approved" | "denied" | "auto";
  /** Whether the call resolved: `completed` (response arrived) or `interrupted` (call made, no response). */
  invocationDisposition?: "completed" | "interrupted";
  position: SourcePosition;
}

export interface ToolResultFact {
  id: string;
  source: AgentSource;
  sourceSessionId: string;
  invocationId?: string;
  /** Set when correlation was deterministic inside the source adapter. */
  resolvedInvocationFactId?: string;
  observedToolName?: string;
  approxTokens: number;
  position: SourcePosition;
}

/** Did the user get what they wanted (judged from the whole task dialogue, not just the ending). */
export type TaskOutcome = "success" | "failure" | "unclear";
/** How frustrated the user seemed across the task (re-asks, escalating tone, refusals). */
export type TaskFrustration = "none" | "low" | "high";

/**
 * A task's span over the reconciled session timeline (#88 "chapters"): an inclusive range of
 * message seq. Subsequent facts fall under the chapter that contains them; the materializer stamps
 * each message's owning task from these spans (resolved_messages.task_seq).
 */
export interface TaskChapter {
  startSeq: number;
  endSeq: number;
}

export interface TaskFact {
  id: string;
  source: AgentSource;
  sourceSessionId: string;
  /** Present when referenced source messages carried a valid timestamp. */
  timestampMs?: number;
  /** What the user was trying to accomplish, derived from one or more filtered user messages. */
  description: string;
  evidence: string;
  evidenceKind: "llm_inference" | "user_message";
  /** The chapter span this task owns over the session's reconciled messages (pass 1). */
  chapter?: TaskChapter;
  /** Per-task outcome, judged from the reconstructed task dialogue (pass 2). */
  outcome?: TaskOutcome;
  frustration?: TaskFrustration;
  /** Short evidence tags for the outcome/frustration call (e.g. "repeated re-asks", "no access"). */
  signals?: string[];
  /** One-line rationale for the outcome judgement. */
  outcomeReason?: string;
  position: SourcePosition;
}

export interface TaskCandidateFact {
  id: string;
  source: AgentSource;
  sourceSessionId: string;
  /** Present when the source user-message record carried a valid timestamp. */
  timestampMs?: number;
  /** Filtered user-authored text made available to the task extractor. Not materialized as a task. */
  text: string;
  position: SourcePosition;
}

export interface SessionRelationshipFact {
  id: string;
  source: AgentSource;
  childSourceSessionId: string;
  parentSourceSessionId: string;
  kind: "subagent";
  position: SourcePosition;
}

export interface NormalizedFacts {
  sessions: SessionFact[];
  /** Interaction-opening prompt markers (#117). Optional until producers emit them; reconcile groups
   *  these + the deduped messages into InteractionFacts. */
  prompts?: PromptFact[];
  messages: UsageFact[];
  invocations: InvocationFact[];
  toolResults: ToolResultFact[];
  taskCandidates: TaskCandidateFact[];
  tasks: TaskFact[];
  relationships: SessionRelationshipFact[];
}

export type AuxiliaryEffect = "session_first_prompt" | "session_cwd" | "session_project";

export interface AuxiliaryDependency {
  inputId: string;
  /** Source-specific join key, such as session ID or Gemini project hash/slug. */
  selector: string;
  affects: AuxiliaryEffect[];
}

/**
 * Adapter-owned metadata for files that are alternate representations of one logical unit.
 * Higher preference wins before updatedAtMs and stable file identity are used as tie-breakers.
 */
export interface AlternateRepresentation {
  logicalId: string;
  representation: string;
  preference: number;
  updatedAtMs?: number;
}

export interface SessionFirstPromptFact {
  id: string;
  kind: "session_first_prompt";
  source: "claude";
  sourceSessionId: string;
  firstPrompt: string;
  timestampMs: number;
  position: SourcePosition;
}

export interface ProjectRootFact {
  id: string;
  kind: "project_root";
  source: "gemini";
  selector: string;
  cwd: string;
  position: SourcePosition;
}

export type AuxiliaryFact = SessionFirstPromptFact | ProjectRootFact;

export interface ParsedFileFragment {
  kind: "transcript";
  id: string;
  contractVersion: typeof PARSED_FRAGMENT_CONTRACT_VERSION;
  parser: ParserDescriptor;
  snapshot: StableFileSnapshot;
  alternateRepresentation?: AlternateRepresentation;
  facts: NormalizedFacts;
  dependencies: AuxiliaryDependency[];
  diagnostics: ParserDiagnostic[];
}

export interface ParsedAuxiliaryFragment {
  kind: "auxiliary";
  id: string;
  contractVersion: typeof PARSED_FRAGMENT_CONTRACT_VERSION;
  parser: ParserDescriptor;
  snapshot: StableFileSnapshot;
  facts: AuxiliaryFact[];
  diagnostics: ParserDiagnostic[];
}

export type StoredFragment = ParsedFileFragment | ParsedAuxiliaryFragment;

export type FileParseResult =
  | {
      status: "current";
      fragment: ParsedFileFragment;
    }
  | {
      status: "unstable" | "missing" | "unreadable" | "failed";
      file: FileIdentity;
      observations: FileFingerprint[];
      diagnostics: ParserDiagnostic[];
    };

export type AuxiliaryParseResult =
  | {
      status: "current";
      fragment: ParsedAuxiliaryFragment;
    }
  | {
      status: "unstable" | "missing" | "unreadable" | "failed";
      file: FileIdentity;
      observations: FileFingerprint[];
      diagnostics: ParserDiagnostic[];
    };

export interface TranscriptDiscoveryAdapter {
  readonly source: AgentSource;
  discover(): DiscoveryResult;
}

export interface TranscriptParserAdapter {
  readonly parser: ParserDescriptor;
  parseFile(file: DiscoveredFile): FileParseResult;
}

export interface AuxiliaryParserAdapter {
  readonly parser: ParserDescriptor;
  parseFile(file: DiscoveredFile): AuxiliaryParseResult;
}

export interface FragmentMetadata {
  id: string;
  kind: StoredFragment["kind"];
  source?: AgentSource;
  fileId?: string;
  contractVersion: number;
  parserVersion?: string;
  updatedAtMs: number;
  status: "success" | "failed" | "unstable";
}

export type InvalidationReason =
  | "contract_version"
  | "parser_version"
  | "file_changed"
  | "auxiliary_input_changed"
  | "manual_rebuild";

/**
 * Fragments rebuilt from the materialized `fact_*` tables (the queryable read model) rather than
 * from the opaque `fragment_json` blob. Round-trips losslessly with the stored fragments, so the
 * reconciler can run over either source — this is what proves the rows are a faithful projection.
 */
export interface ReconstructedFragments {
  nativeFragments: ParsedFileFragment[];
  auxiliaryFragments: ParsedAuxiliaryFragment[];
}

/** Filters applied to the materialized read model at read time (SQL pushdown). */
export interface ResolvedQuery {
  sources?: AgentSource[];
  since?: string;
  until?: string;
  projectSubstring?: string;
}

/** A cheap per-session rollup for the paginated session list: session columns + per-model token
 *  sums (SQL `GROUP BY`, no per-message JS walk). Cost is priced from `byModel` by the caller, since
 *  the price table lives in JS. Local-only (not on the sync wire). */
export interface SessionAggregate {
  meta: SessionMeta;
  /** Whole-session token sums per model (source-scoped, NOT windowed by the date filter — see
   *  readSessionAggregates), so they're consistent with the whole-session firstTs/lastTs/counts. */
  byModel: { model: string; usage: Usage }[];
  /** First/last message timestamps (epoch ms) for this session from resolved_sessions. */
  firstTs: number | null;
  lastTs: number | null;
  messageCount: number;
}

/** One reconciled session ready to materialize: its meta, messages, and tool-result stats. */
export interface MaterializeSession {
  meta: SessionMeta;
  messages: MessageRecord[];
  toolResults: Array<{ name: string; count: number; approxTokens: number }>;
  tasks?: TaskFact[];
}

/** Per-source freshness attestation. */
export interface SourceCoverageRow {
  source: string;
  filesDigest: string | null;
  lastSyncAtMs: number | null;
  sessionCount: number;
}

/** A transcript fragment's structural index entry — enough to detect change and re-parse its file. */
export interface TranscriptIndexEntry {
  fragmentId: string;
  file: FileIdentity;
  fingerprint: FileFingerprint;
  parserName: string | null;
  parserVersion: string | null;
  status: FragmentMetadata["status"];
  /** Source session ids this fragment contributes (pre-canonicalization). */
  sourceSessionIds: string[];
}

/** The structural index for one source: per-fragment session mapping + subagent relationships. */
export interface TranscriptIndex {
  fragments: TranscriptIndexEntry[];
  relationships: Array<{ child: string; parent: string }>;
}

/** Coarse store-wide counts for status/debug surfaces. */
export interface StoreStats {
  /** The store's on-disk schema version (PRAGMA user_version). */
  schemaVersion: number;
  sessions: number;
  messages: number;
  tasks: number;
  /** Messages attributed to a task (resolved_messages.task_seq IS NOT NULL) — chapter coverage. */
  messagesWithTask: number;
}

/**
 * Tier 1 — the structural index: per-file fingerprints + the file→session map producers write while
 * indexing. Fully re-derivable from disk (rebuilt freely by clearIndex/reindex). Maintaining this
 * tier is the indexing pipeline's job; readers never touch it.
 */
export interface StructuralIndexStore {
  /** Reconstruct an auxiliary fragment from its envelope + rows (transcripts/imports are re-parsed
   *  from disk, not reconstructed, so they return undefined). */
  load(id: string): Promise<StoredFragment | undefined>;
  list(source?: AgentSource): Promise<FragmentMetadata[]>;
  replace(fragment: StoredFragment): Promise<void>;
  removeMissing(discovery: CompleteDiscovery): Promise<void>;
  invalidate(ids: string[], reason: InvalidationReason): Promise<void>;
  /** The structural index for a source: which sessions each transcript file maps to (+ fingerprints
   *  for change detection). Heavy content is re-parsed from disk, not reconstructed. */
  transcriptIndex(source: AgentSource): Promise<TranscriptIndex>;
  /** Drop the whole structural index + coverage (re-derivable from disk). Leaves the trusted
   *  read model (resolved_*) and ownership intact — used by non-destructive `reindex`. */
  clearIndex(): Promise<void>;
  getCoverage(source: string): Promise<SourceCoverageRow | undefined>;
  setCoverage(source: string, filesDigest: string | null, sessionCount: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Tier 2 — the trusted read model: the reconciled rows readers SELECT (no reconcile on read). NOT
 * re-derivable once a source ages off disk, so it is preserved across schema changes via real
 * migrations, never silently dropped.
 */
export interface ReadModelStore {
  /** Read the reconciled sessions/messages/tool-results, with optional SQL-pushdown filters.
   *  Includes archived (off-disk, retained) sessions — the store is a durable archive, not a
   *  mirror of disk. */
  readResolved(query?: ResolvedQuery): Promise<ParseResult>;
  /**
   * Upsert the given reconciled sessions for `owner` (replacing any prior rows per session) and
   * mark them present (on-disk). Don't-regress guard: a re-materialization with *fewer* messages than
   * already stored (files missing/unreadable this run, or another producer holds a richer copy) keeps
   * the fuller stored row instead of overwriting it — regardless of owner, so a handoff can't regress
   * the count. The archived flag is left untouched (whether a session truly left disk is decided by
   * discovery, not a count dip). Returns the ids it kept (skipped) that way.
   */
  materializeSessions(owner: string, sessions: MaterializeSession[]): Promise<string[]>;
  /** Metadata for a single resolved session, without loading messages or tasks. */
  readSessionMeta(sessionId: string): Promise<SessionMeta | undefined>;
  /** Task facts for a resolved session, oldest to newest; tasks without timestamps sort last. */
  readSessionTasks(sessionId: string): Promise<TaskFact[]>;
  /** Messages attributed to each task in a session (by resolved_messages.task_seq), keyed by task id,
   *  oldest first. Tasks with no attributed messages are absent from the map. */
  readSessionTaskMessages(sessionId: string): Promise<Map<string, MessageRecord[]>>;
  /** All messages for one session, oldest first. Backs the on-demand /api/session/:id detail. */
  readSessionMessages(sessionId: string): Promise<MessageRecord[]>;
  /** Per-session token rollups for the paginated session list: one entry per matching session with
   *  its meta + per-model token sums (SQL `GROUP BY`, no per-message JS walk). Filters match
   *  readResolved (sources/since/until/project). The date filter selects which sessions appear (those
   *  with a message in range); each row's token sums are whole-session, not windowed. */
  readSessionAggregates(query?: ResolvedQuery): Promise<SessionAggregate[]>;
  /** Permanently remove reconciled sessions (the explicit `forget` path — destroys retained data). */
  retractSessions(sessionIds: string[]): Promise<void>;
  /** Flag/unflag sessions as archived (retained but no longer backed by their source on disk). */
  setSessionsArchived(sessionIds: string[], archived: boolean): Promise<void>;
  /** Canonical ids of archived (off-disk, retained) sessions, optionally restricted by source. */
  listArchived(source?: AgentSource): Promise<string[]>;
  /** Count of archived (off-disk, retained) sessions currently owned by `owner`. */
  archivedCountForOwner(owner: string): Promise<number>;
  /** Resolved session counts grouped by owning producer (present on disk vs archived). */
  resolvedSessionCounts(): Promise<Array<{ owner: string; present: number; archived: number }>>;
  /** Coarse row counts for status/debug surfaces (cheap COUNT(*)s + the store schema version). */
  storeStats(): Promise<StoreStats>;
  /** Canonical session ids currently materialized for `owner` (present and archived). */
  resolvedSessionIdsForOwner(owner: string): Promise<string[]>;
  /** Canonical session ids owned by some producer other than `owner`. */
  ownedSessionIdsExcept(owner: string): Promise<Set<string>>;
  close(): Promise<void>;
}

/** The full store: both tiers. The SQLite implementation provides both; callers that only read or
 *  only index can depend on the narrower tier above. */
export interface Store extends StructuralIndexStore, ReadModelStore {}

export interface ReconciliationInput {
  nativeFragments: ParsedFileFragment[];
  auxiliaryFragments: ParsedAuxiliaryFragment[];
  diagnostics: ParserDiagnostic[];
}

export interface FragmentReconciler {
  reconcile(input: ReconciliationInput): ParseResult;
}

export interface ReconciliationOrder {
  timestampMs: number;
  source: AgentSource;
  sourceSessionId: string;
  position: SourcePosition;
  stableId: string;
}

const SOURCE_ORDER: Record<AgentSource, number> = {
  claude: 0,
  codex: 1,
  gemini: 2,
  cowork: 3,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Length-prefix every part before hashing so identities remain unambiguous when values contain
 * separators. Callers must pass normalized, source-owned values rather than display labels.
 */
export function stableId(namespace: string, parts: readonly (string | number)[]): string {
  const hash = createHash("sha256");
  hash.update(`${namespace.length}:${namespace}`);
  for (const part of parts) {
    const value = String(part);
    hash.update(`${value.length}:${value}`);
  }
  return `${namespace}:${hash.digest("hex")}`;
}

export function createFileIdentity(input: FileIdentityInput): FileIdentity {
  return {
    ...input,
    id: stableId("file", [
      input.source ?? "",
      input.rootId,
      input.role,
      input.relativePath,
    ]),
  };
}

export function createFactId(
  kind: FactKind,
  source: AgentSource,
  sourceSessionId: string,
  position: SourcePosition,
  sourceIdentity = "",
): string {
  return stableId(`fact:${kind}`, [
    source,
    sourceSessionId,
    position.originKey,
    position.recordIndex,
    position.itemIndex,
    sourceIdentity,
  ]);
}

/** Locale-independent total order for global first-occurrence and tie-breaking rules. */
export function compareReconciliationOrder(
  a: ReconciliationOrder,
  b: ReconciliationOrder,
): number {
  return (
    a.timestampMs - b.timestampMs ||
    SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
    compareText(a.sourceSessionId, b.sourceSessionId) ||
    compareText(a.position.originKey, b.position.originKey) ||
    a.position.recordIndex - b.position.recordIndex ||
    a.position.itemIndex - b.position.itemIndex ||
    compareText(a.stableId, b.stableId)
  );
}

export function sameFileFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return (
    a.sizeBytes === b.sizeBytes &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.physicalId?.scheme === b.physicalId?.scheme &&
    a.physicalId?.value === b.physicalId?.value
  );
}

export function isAuthoritativeDiscovery(
  discovery: DiscoveryResult,
): discovery is CompleteDiscovery {
  return discovery.status === "complete";
}
