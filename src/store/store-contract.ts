import { createHash } from "node:crypto";
import type { FrictionEvent } from "../indexing/friction.ts";
import type {
  AgentSource,
  FrictionTotals,
  MessageRecord,
  ParseResult,
  SessionMeta,
  Usage,
} from "../types.ts";
import type { ToolCategory } from "../tool-categories.ts";

/**
 * Increment when serialized fragment semantics change incompatibly.
 * Source parser versions remain independent so one adapter can invalidate narrowly.
 * v2: dropped external (AgentsView) import fragments — stale stores re-parse from disk.
 * v3: producers emit interaction-opening PromptFacts (#117); stale fragments re-parse.
 */
export const PARSED_FRAGMENT_CONTRACT_VERSION = 3;

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
  /** The assistant turn's text (#122/#120), in-memory only — reconcile reads it onto the owning
   *  interaction's responseText and it is never stored on this fact. For sources that split usage from
   *  message text (codex meters on token_count events), the producer carries the turn's text here. */
  text?: string;
  position: SourcePosition;
}

/** Who authored an interaction's opening prompt (see docs/session-model.md). Only `human`-initiated
 *  prompts carry intent — task interpretation filters on this. */
export type InteractionInitiator = "human" | "agent" | "harness";

/** How an interaction's loop ended — a fact (mechanical), distinct from a task's interpreted outcome.
 *  `interrupted` = a known human interrupt (a friction signal); `incomplete` = stopped with no
 *  response, cause unknown; `error` = the loop failed.
 *
 *  Support matrix (mirrors the friction module, which only some producers observe): `interrupted`
 *  and a non-zero `compactionCount` are derivable only for producers that observe friction (claude,
 *  cowork). For codex/gemini, which expose no interrupt/compaction markers, an interaction that lacks
 *  a response is `incomplete` (cause unknown) — it is *not* a claim that no interrupt happened, the
 *  same unknown-vs-zero distinction the friction module documents. */
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
  /** The human prompt's text, set ONLY for human-initiated openings that pass the task noise filter —
   *  i.e. the interaction openings that are task starts (#122). Reconcile copies it onto the opened
   *  interaction's promptText (the sole source of task candidates). In-memory only — never written to
   *  the store (the stored InteractionFact stays text-free). Absent on agent/harness openings and on
   *  filtered-out human turns (AGENTS.md / env-context / aborted / Argus-generated). */
  text?: string;
  position: SourcePosition;
}

/**
 * One interaction: prompt → agent loop → response (see docs/session-model.md). The atomic unit of a
 * session. **Reconcile-derived**, not a per-file fact: reconcile groups the deduped timeline into
 * these. The stored `interaction_json` is always text-free (the slot positions pin where the text
 * lives); prompt/response text is persisted separately, opt-in and local-only, in
 * resolved_interaction_text (#120). Tasks (#122) span interactions.
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
  /** The opening prompt's text, for human-initiated task-start interactions (#122). The Interpret stage
   *  reads it (pass-1 segmentation + pass-2 dialogue). Never embedded in the stored interaction_json;
   *  persisted (opt-in, local-only) in resolved_interaction_text under #120's retention. Absent on
   *  agent/harness openings and noise-filtered human turns. */
  promptText?: string;
  /** The response slot's text (the interaction's final own-session assistant turn), when present.
   *  Pass-2 dialogue projection; persisted opt-in/local-only in resolved_interaction_text (#120),
   *  never in the stored interaction_json. */
  responseText?: string;
  position: SourcePosition;
}

/** One retained conversation-text chunk (#120): a piece of the dialogue with its role. `seq` is the
 *  chunk's own per-session ordinal (timeline order); `interactionSeq` is the owning interaction, or
 *  null for a future session-level chunk that belongs to no single interaction. `type` is a controlled
 *  vocabulary — `"prompt"` | `"response"` today, `"narration"` (etc.) later — kept as a string so new
 *  kinds need no type change. Local-only — never on the sync wire. */
export interface InteractionTextChunk {
  seq: number;
  interactionSeq: number | null;
  type: string;
  text: string;
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
  /** Per-task outcome, judged from the reconstructed task dialogue (pass 2). */
  outcome?: TaskOutcome;
  frustration?: TaskFrustration;
  /** Short evidence tags for the outcome/frustration call (e.g. "repeated re-asks", "no access"). */
  signals?: string[];
  /** One-line rationale for the outcome judgement. */
  outcomeReason?: string;
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
  // Gemini resolves a project hash/slug → cwd; claude-chat resolves a claude.ai project uuid → its
  // name. reconcile's project_root handling is source-agnostic (it only reads selector + cwd).
  source: "gemini" | "claude-chat";
  selector: string;
  /** The resolved value reconcile uses as the session's cwd, then labels via projectLabel. For
   *  gemini this is a filesystem path; for claude-chat (no filesystem) it is the project name. */
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

/** Usage sums + message count for one grouping key crossed with model (cost is priced per-model in JS
 *  from these, exactly, since pricing is linear). */
export interface UsageGroupRow {
  model: string;
  usage: Usage;
  messages: number;
}

/**
 * Pre-grouped dashboard inputs read from the materialized model via SQL `GROUP BY` (#121), so the
 * snapshot builds without loading every per-turn usage row into JS. A pure assembler turns these into
 * the `Dashboard` (applying per-model pricing). Local-only (not on the sync wire). Each grouping that
 * needs cost is crossed with model. Tool breakdowns come from resolved_invocations; friction/outcome
 * from session metadata + light scans (no full message materialization).
 */
export interface DashboardAggregates {
  usageByDateModel: Array<{ date: string } & UsageGroupRow>;
  usageBySourceModel: Array<{ source: string } & UsageGroupRow>;
  usageByProjectModel: Array<{ project: string } & UsageGroupRow>;
  /** skill === "" means unattributed ("(none)"). */
  usageBySkillModel: Array<{ skill: string } & UsageGroupRow>;
  /** Per (date, skill) total tokens, attributed skills only — backs the skill-over-time chart. */
  skillTokensByDate: Array<{ date: string; skill: string; total: number }>;
  /** Distinct session counts per source/project. The grand total isn't carried — each session has one
   *  source, so the assembler sums sessionsBySource (avoids a redundant COUNT(DISTINCT) scan). */
  sessionsBySource: Array<{ source: string; sessions: number }>;
  sessionsByProject: Array<{ project: string; sessions: number }>;
  /** Per-tool result-size stats, scoped by source ONLY (not date/project) — mirrors the legacy
   *  `ParseResult.toolResults` map. The assembler joins this for every `approxResultTokens` and derives
   *  `heaviestToolResults` from it; call counts/sessions come from the fully-filtered lists below. */
  toolResultStats: Array<{ tool: string; count: number; approxTokens: number }>;
  /** Call counts/sessions per tool, fully filtered (source/date/project). category is constant per tool. */
  byTool: Array<{ tool: string; category: ToolCategory; calls: number; sessions: number }>;
  byToolCategory: Array<{ category: ToolCategory; calls: number; tools: number; sessions: number }>;
  mcpServers: Array<{ server: string; calls: number }>;
  /** Per MCP server, the raw tool names called + counts (assembler parses `mcp__server__tool`). */
  mcpServerTools: Array<{ server: string; tool: string; count: number }>;
  skillInvocations: Array<{ skill: string; count: number; sampleArgs: string }>;
  frictionTotals: FrictionTotals;
  projectFriction: Array<{ project: string; friction: FrictionTotals }>;
  highTokenGrowthSessions: number;
}

/** One reconciled session ready to materialize: its meta, messages, tasks, and interactions. Tool
 *  result sizes ride on each message's toolUses (#130: approxResultTokens) — no separate field. */
export interface MaterializeSession {
  meta: SessionMeta;
  messages: MessageRecord[];
  tasks?: TaskFact[];
  /** Reconcile-derived interactions for this session (#117/#119), persisted to resolved_interactions.
   *  Each carries in-memory promptText/responseText (#122) the Interpret stage reads; the stored
   *  interaction_json is always text-free, and that text is persisted (opt-in, default-on, local-only)
   *  in resolved_interaction_text (#120). */
  interactions?: InteractionFact[];
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

/** One observation in the client-fingerprint log: a key/value pair stamped with when it was seen. */
export interface ClientFingerprintEntry {
  key: string;
  value: string;
  tsMs: number;
}

/** Coarse store-wide counts for status/debug surfaces. */
export interface StoreStats {
  /** The store's on-disk schema version (PRAGMA user_version). */
  schemaVersion: number;
  sessions: number;
  messages: number;
  tasks: number;
  /** Usage rows whose owning interaction is attributed to a task (#122) — task coverage. */
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
  materializeSessions(
    owner: string,
    sessions: MaterializeSession[],
    opts?: { retainText?: boolean },
  ): Promise<string[]>;
  /** Metadata for a single resolved session, without loading messages or tasks. */
  readSessionMeta(sessionId: string): Promise<SessionMeta | undefined>;
  /** Opt-in retained conversation text for a session (#120): the session's text chunks in timeline
   *  order (the table's own `seq`), each tagged with its owning `interactionSeq` and `type`. A reader
   *  groups by `interactionSeq` as needed. Empty when retention was off at index time. Local-only —
   *  never on the sync wire. */
  readInteractionText(sessionId: string): Promise<InteractionTextChunk[]>;
  /** Task facts for a resolved session, oldest to newest; tasks without timestamps sort last. */
  readSessionTasks(sessionId: string): Promise<TaskFact[]>;
  /** The interaction spine for a session, rehydrated with its retained prompt/response text (#153) —
   *  the single text source the Interpret stage reads (both the background drain and inline refresh).
   *  interaction_json is text-free (#120); promptText/responseText are merged back from
   *  resolved_interaction_text by interaction_seq. Interactions without retained text have neither. */
  readSessionInteractions(sessionId: string): Promise<InteractionFact[]>;
  /** Canonical ids of sessions eligible for (re)interpretation, newest-first, capped at `limit` (#153).
   *  Eligible = content_indexed_at_ms > COALESCE(interpreted_at_ms, 0) AND a retained human opening
   *  prompt exists. interpretation_version is intentionally NOT a factor (a version bump must not
   *  re-trigger the drain — only content change or explicit refresh does). */
  readPendingInterpretationSessions(limit: number): Promise<string[]>;
  /** Sole writer of resolved_tasks + interpretation state (#153): replace a session's tasks (without
   *  re-materializing messages/interactions/text), re-derive task↔interaction membership, and stamp
   *  interpreted_at_ms + interpretation_version. Always stamps — even for an empty task list — so a
   *  session with no extractable tasks de-queues instead of re-running every drain tick. */
  writeSessionTasks(sessionId: string, tasks: TaskFact[], version: string): Promise<void>;
  /** Take up to `want` credits from the persisted Interpret rate limiter (#153) — one credit = one
   *  session's worth of interpretation (unrelated to LLM tokens). Refilled continuously at
   *  `maxPerHour`/hour (capacity `maxPerHour`, fresh bucket full). Returns how many were granted,
   *  decrementing by that amount. Persisted in store_metadata so the hourly ceiling holds across
   *  process restarts and repeated one-shot index runs. The inline refresh path does not call this. */
  takeInterpretCredits(want: number, maxPerHour: number): Promise<number>;
  /** Backfill progress for `argus status` (#153): sessions interpreted at least once, the eligible
   *  backlog (pending), and how many are interpreted-but-outdated (content changed since). */
  interpretationProgress(): Promise<{ interpreted: number; pending: number; outdated: number }>;
  /** Messages attributed to each task in a session (joined usage → interaction → task, #122), keyed by
   *  task id, oldest first. Tasks with no attributed messages are absent from the map. */
  readSessionTaskMessages(sessionId: string): Promise<Map<string, MessageRecord[]>>;
  /** All messages for one session, oldest first. Backs the on-demand /api/session/:id detail. */
  readSessionMessages(sessionId: string): Promise<MessageRecord[]>;
  /** Per-session token rollups for the paginated session list: one entry per matching session with
   *  its meta + per-model token sums (SQL `GROUP BY`, no per-message JS walk). Filters match
   *  readResolved (sources/since/until/project). The date filter selects which sessions appear (those
   *  with a message in range); each row's token sums are whole-session, not windowed. */
  readSessionAggregates(query?: ResolvedQuery): Promise<SessionAggregate[]>;
  /** Pre-grouped dashboard inputs for the serve snapshot (#121): numeric/tool/friction breakdowns via
   *  SQL `GROUP BY`, so the snapshot builds without materializing every usage row. Filters match
   *  readResolved (sources/since/until/project), windowed by message date like the JS aggregate. */
  readDashboardAggregates(query?: ResolvedQuery): Promise<DashboardAggregates>;
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
  /** Stable per-install client id (`client-<uuid>`), generated and persisted on first call (#141). */
  getClientId(): Promise<string>;
  /** Append-only log of client fingerprint observations (key/value/timestamp tuples). Used to
   *  attribute snapshots to their originating client at registration. A repeat write of the SAME
   *  value for a key is a no-op (only changes accumulate, so the log stays bounded). */
  recordClientFingerprint(key: string, value: string, tsMs: number): Promise<void>;
  /** All client-fingerprint observations, oldest first. */
  listClientFingerprint(): Promise<ClientFingerprintEntry[]>;
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
  "claude-chat": 4,
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

/**
 * The single rule for "is a prompt agent-authored rather than human intent?": a subagent session's
 * prompts. Both the prompt-fact initiator and each producer's task-candidate guard call this so the
 * rule lives in one place (a new SessionKind or detection only changes here, not in N producers).
 */
export function isAgentInitiated(kind?: SessionKind): boolean {
  return kind === "subagent";
}

/**
 * Build an interaction-opening PromptFact uniformly across producers (#117). Centralizing this keeps
 * the guards consistent (timestamp set only when finite; dedupKey only when present) and derives
 * `initiator` from the owning session's kind (via {@link isAgentInitiated}) rather than each producer
 * re-deriving "is this agent-initiated?" and drifting.
 */
export function buildPromptFact(args: {
  source: AgentSource;
  sourceSessionId: string;
  position: SourcePosition;
  /** Owning session kind; a `subagent` session's prompts are agent-initiated. */
  kind?: SessionKind;
  /** Replay-stable id (record uuid / message id) so resumed-session replays dedupe in reconcile. */
  dedupKey?: string;
  timestampMs?: number;
  /** The human prompt text, set by the producer only when this opening is a task start (#122) —
   *  human-initiated and past the noise filter. Carried in-memory so reconcile can build the
   *  per-session task-prompt list; never stored. */
  text?: string;
}): PromptFact {
  const prompt: PromptFact = {
    id: createFactId("prompt", args.source, args.sourceSessionId, args.position, "user_message"),
    source: args.source,
    sourceSessionId: args.sourceSessionId,
    initiator: isAgentInitiated(args.kind) ? "agent" : "human",
    position: args.position,
  };
  if (args.timestampMs != null && Number.isFinite(args.timestampMs)) prompt.timestampMs = args.timestampMs;
  if (args.dedupKey) prompt.dedupKey = args.dedupKey;
  if (args.text) prompt.text = args.text;
  return prompt;
}

/**
 * Assign each interaction to its owning task (#122), bookmark semantics: an interaction belongs to the
 * latest task that started at or before it. Returns a map of interaction `seq` -> task index (which is
 * the `resolved_tasks.seq` materialize writes, since it stores `tasks` in array order). Only dated
 * tasks participate; an interaction earlier than the first task, or without a timestamp, is
 * unattributed (absent from the map -> NULL `resolved_interactions.task_seq`). Pure, so the store
 * (resolved_interactions.task_seq) and the Interpret stage (dialogue slicing) assign identically.
 */
/** The minimal interaction shape `assignInteractionTaskSeqs` reads: its ordinal and (optional) start
 *  time. Narrow on purpose so callers that rebuild interactions from a couple of columns (e.g. the
 *  store's `writeSessionTasks`) pass a typed object instead of casting a partial to `InteractionFact`. */
export type TaskSeqInteraction = Pick<InteractionFact, "seq" | "timestampMs">;

export function assignInteractionTaskSeqs(
  tasks: TaskFact[],
  interactions: readonly TaskSeqInteraction[],
): Map<number, number> {
  const out = new Map<number, number>();
  // Dated tasks carrying their original index (= resolved_tasks.seq), oldest first.
  const dated = tasks
    .map((task, index) => ({ ts: task.timestampMs, index }))
    .filter((t): t is { ts: number; index: number } => t.ts != null)
    .sort((a, b) => a.ts - b.ts);
  if (!dated.length) return out;
  // Both sides ascending by ts, so a single advancing pointer over `dated` assigns each interaction to
  // the latest task started at/before it — O(n log n + m log m), no per-interaction rescan. The helper
  // runs twice per session per index (Interpret + materialize), so the linear pass matters on long ones.
  const ordered = interactions
    .filter((i): i is TaskSeqInteraction & { timestampMs: number } => i.timestampMs != null)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  let t = -1;
  for (const interaction of ordered) {
    while (t + 1 < dated.length && dated[t + 1]!.ts <= interaction.timestampMs) t++;
    if (t >= 0) out.set(interaction.seq, dated[t]!.index);
  }
  return out;
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
