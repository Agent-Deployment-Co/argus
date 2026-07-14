// The UI layer over the canonical source registry (src/sources): the visual encoding — a stable
// per-source color and brand icon — plus a <SourceBadge> that renders icon + label together. Colors
// are identity-stable (keyed by source id, not by position in a dataset), so a source reads as the
// same color in every chart, legend, and table. The three Claude-family sources share the Claude
// mark and are told apart by their color + label. Colors are drawn from the vetted app palette.
import type { ComponentType, SVGProps } from "react";
import { SOURCE_IDS, SOURCE_IDS_BY_LABEL, sourceLabel } from "../../../src/sources";
import { ClaudeCodeMark, ClaudeMark, GeminiMark, OpenAiMark } from "../components/source-icons";

export { SOURCE_IDS, SOURCE_IDS_BY_LABEL, sourceLabel };

interface SourceVisual {
  color: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

// Claude family as a warm lightness ramp (dark brown -> accent orange -> light amber) so the three
// read as one brand yet stay distinguishable; Codex a monochrome-leaning slate (OpenAI reads as a
// black/white brand); Gemini a deeper, saturated blue.
const VISUALS: Record<string, SourceVisual> = {
  cowork: { color: "#a04800", Icon: ClaudeMark },
  claude: { color: "#ef8920", Icon: ClaudeCodeMark },
  "claude-chat": { color: "#f5a850", Icon: ClaudeMark },
  codex: { color: "#5f7385", Icon: OpenAiMark },
  gemini: { color: "#286992", Icon: GeminiMark },
};

const FALLBACK_COLOR = "#887060";

/** The stable color for a source id; a muted neutral for anything unmapped. */
export function sourceColor(id: string): string {
  return VISUALS[id]?.color ?? FALLBACK_COLOR;
}

/** The brand-mark component for a source id, or undefined if unmapped. */
export function sourceIcon(id: string): ComponentType<SVGProps<SVGSVGElement>> | undefined {
  return VISUALS[id]?.Icon;
}

/** Icon + label for a source. The icon uses the ambient theme icon color (like every other icon in
 *  the app), not the source's color — that stays reserved for charts. Use wherever a source is named
 *  (filter picker, table cells, legends). `size` is the icon edge in px. */
export function SourceBadge({ id, size = 16 }: { id: string; size?: number }) {
  const Icon = sourceIcon(id);
  return (
    <span className="source-badge">
      {Icon ? <Icon width={size} height={size} /> : null}
      <span>{sourceLabel(id)}</span>
    </span>
  );
}
