// The session-detail warning for secret-scan findings (#327). Renders when a session's scan found
// likely exposed credentials: what kind, where (prompt/response), and a redacted hint so the user
// recognizes which credential it was. The store never holds the secret itself.
// Dismissal is anchored to the current finding set server-side, so it lapses if a re-scan finds
// something different; a dismissed banner collapses to a muted line with a way back.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import type { SecretFinding } from "../types";
import { dismissSecretFindings, undismissSecretFindings } from "../lib/sessions";
import { pluralize } from "../lib/format";
import { useReadOnly } from "../lib/read-only";
import { VIEW_QUERY_KEY } from "../lib/views";

/** User-facing labels for the scanner's categories (plain words, not rule ids). */
const CATEGORY_LABELS: Record<SecretFinding["category"], string> = {
  aws_access_key: "AWS access key",
  github_token: "GitHub token",
  anthropic_api_key: "Anthropic API key",
  openai_api_key: "OpenAI API key",
  stripe_key: "Stripe key",
  slack_token: "Slack token",
  private_key: "Private key",
  jwt: "JWT",
  generic_secret: "Possible secret",
};

function findingLine(f: SecretFinding): string {
  const where = f.chunkType === "prompt" ? "in your prompt" : "in the agent's reply";
  return `${CATEGORY_LABELS[f.category] ?? f.category}${f.hint ? ` (${f.hint})` : ""} ${where}`;
}

/** Finding display order (documented, per the repo's ordered-list rule): chronological by
 *  interaction, the prompt before the response within an interaction, then category and hint to
 *  break ties. The scanner emits rule-order within a chunk; the user cares about where in the
 *  session a credential appeared, so we sort here rather than trust arrival order. */
function orderFindings(findings: SecretFinding[]): SecretFinding[] {
  return [...findings].sort(
    (a, b) =>
      a.interactionSeq - b.interactionSeq ||
      (a.chunkType === b.chunkType ? 0 : a.chunkType === "prompt" ? -1 : 1) ||
      a.category.localeCompare(b.category) ||
      a.hint.localeCompare(b.hint),
  );
}

export function SecretFindingsBanner({
  sessionId,
  findings,
  dismissed,
}: {
  sessionId: string;
  findings: SecretFinding[];
  dismissed: boolean;
}) {
  const qc = useQueryClient();
  // The warning itself is worth showing everywhere; dismissing is a write, and a read-only server
  // never mounts that route, so the buttons would fail silently.
  const readOnly = useReadOnly();
  const mutation = useMutation({
    mutationFn: (action: "dismiss" | "undismiss") =>
      action === "dismiss" ? dismissSecretFindings(sessionId) : undismissSecretFindings(sessionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["session", sessionId] });
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      // The credential warning leads the Activity recommendations, and that view caches for 30s —
      // without this it keeps counting a session the user just dismissed. Prefix-matching the path
      // covers every filter combination cached for it.
      void qc.invalidateQueries({ queryKey: [VIEW_QUERY_KEY, "/api/recommendations"] });
    },
  });

  if (!findings.length) return null;

  // A dismissal can fail for reasons the user can act on — Argus stopped, or a re-index cleared the
  // findings this page still shows. Say so; silently leaving the banner in place reads as a bug.
  const error = mutation.error instanceof Error ? mutation.error.message : null;

  if (dismissed) {
    return (
      <div className="secret-banner-dismissed">
        <span>
          Credential warning dismissed ({findings.length} {pluralize(findings.length, "finding")}).
        </span>
        {error && <span className="task-error" role="alert">{error}</span>}
        {!readOnly && (
          <button
            type="button"
            className="kv-more-link"
            onClick={() => mutation.mutate("undismiss")}
            disabled={mutation.isPending}
          >
            Show again
          </button>
        )}
      </div>
    );
  }

  const ordered = orderFindings(findings);

  return (
    <div className="secret-banner" role="alert">
      <div className="secret-banner-head">
        <ShieldAlert size={15} strokeWidth={2} aria-hidden />
        <span className="secret-banner-title">
          This session may contain {findings.length > 1 ? "exposed credentials" : "an exposed credential"}
        </span>
        {!readOnly && (
          <button
            type="button"
            className="task-action"
            onClick={() => mutation.mutate("dismiss")}
            disabled={mutation.isPending}
            title="Hide this warning until the findings change"
          >
            Dismiss
          </button>
        )}
      </div>
      <ol className="secret-banner-list">
        {ordered.slice(0, 5).map((f) => (
          <li key={`${f.category}-${f.interactionSeq}-${f.chunkType}-${f.hint}`}>{findingLine(f)}</li>
        ))}
        {ordered.length > 5 && <li>…and {ordered.length - 5} more</li>}
      </ol>
      <p className="secret-banner-detail">
        If any of these are real, rotate them. Only the redacted hint is stored, never the
        credential itself.
      </p>
      {error && <p className="task-error">{error}</p>}
    </div>
  );
}
