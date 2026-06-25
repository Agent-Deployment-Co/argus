// Discovery inputs + shared labeling for the indexing pipeline. `ParseOptions` names the source
// directories a run discovers; `projectLabel` derives the human-readable project name from a cwd.
// (Both previously lived in the removed monolithic oracle, src/parse.ts.)
import type { TranscriptSource } from "../types.ts";

/** Filesystem locations + source selection for one indexing run. */
export interface ParseOptions {
  projectsDir?: string;
  historyFile?: string;
  codexSessionsDir?: string;
  geminiDir?: string;
  coworkSessionsDir?: string;
  claudeChatCacheDir?: string;
  sources?: TranscriptSource[];
}

/** Last two path segments, e.g. /Users/mando/code/gw/webapp -> "gw/webapp". */
export function projectLabel(cwd: string): string {
  if (!cwd) return "(unknown)";
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}
