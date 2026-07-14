// The canonical agent-source registry (#147): one descriptor per source that display labels,
// ordering, and (in a follow-up) the backend source lists all derive from, instead of the ~10
// hand-maintained copies that exist today. Runtime-safe — it imports only a type and pulls in no
// Node/store deps — so `web/` can import it at build time exactly like it imports types from `src/`.
// Visual encoding (per-source color + brand icon) is a UI concern and lives in `web/src/lib/sources`.
import type { AgentSource } from "./types";

export interface SourceDescriptor {
  /** The wire/source id (e.g. "claude-chat"). */
  id: AgentSource;
  /** Human display name, shared by the CLI and the web app (previously web-only in the FilterBar). */
  label: string;
  /** Canonical display + reconcile tie-break order, ascending (mirrors the old SOURCE_ORDER). */
  order: number;
  /** Excluded from the `sync` wire (the old LOCAL_ONLY_SOURCES). */
  localOnly: boolean;
}

// Order preserves the existing SOURCE_ORDER tie-break so the backend can adopt this registry later
// without changing reconcile behavior.
export const SOURCES: readonly SourceDescriptor[] = [
  { id: "claude", label: "Claude Code", order: 0, localOnly: false },
  { id: "codex", label: "Codex", order: 1, localOnly: false },
  { id: "gemini", label: "Gemini", order: 2, localOnly: false },
  { id: "cowork", label: "Claude Cowork", order: 3, localOnly: false },
  { id: "claude-chat", label: "Claude Chat", order: 4, localOnly: true },
];

// Compile-time completeness guard: every AgentSource must have a descriptor. If a new source is added
// to the union without an entry here, `_MissingSource` widens past `never` and this line fails to type.
type _MissingSource = Exclude<AgentSource, (typeof SOURCES)[number]["id"]>;
const _sourcesAreExhaustive: [_MissingSource] extends [never] ? true : false = true;
void _sourcesAreExhaustive;

const BY_ID = new Map<string, SourceDescriptor>(SOURCES.map((s) => [s.id, s]));

/** All source ids, in canonical order. */
export const SOURCE_IDS: readonly AgentSource[] = SOURCES.map((s) => s.id);

/** The descriptor for a source id, or undefined if unknown. */
export function sourceDescriptor(id: string): SourceDescriptor | undefined {
  return BY_ID.get(id);
}

/** Human label for a source id; falls back to the id itself for anything unmapped. */
export function sourceLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Source ids sorted by display label, ascending alpha — the order every source picker should use
 *  (there's no meaningful numeric/temporal order across sources, so labels sort per the UI rules). */
export const SOURCE_IDS_BY_LABEL: readonly AgentSource[] = [...SOURCE_IDS].sort((a, b) =>
  sourceLabel(a).localeCompare(sourceLabel(b)),
);
