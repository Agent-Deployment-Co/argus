// The session-detail warning for secret-scan findings (#327). Renders when a session's scan found
// likely exposed credentials: what kind, where (prompt/response), and a redacted hint so the user
// recognizes which credential it was. The store never holds the secret itself.
// Each finding is a link into the Timeline at the interaction it was found in (#336), so the user
// can see the turn that leaked it.
// Dismissal is anchored to the current finding set server-side, so it lapses if a re-scan finds
// something different; a dismissed banner collapses to a muted line with a way back.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import type { SecretFinding } from "../types";
import { dismissSecretFindings, undismissSecretFindings } from "../lib/sessions";
import { pluralize } from "../lib/format";
import { useReadOnly } from "../lib/read-only";
import {
  interactionNumber,
  orderSecretFindings,
  secretFindingKey,
  secretFindingLine,
} from "../lib/secret-findings";
import { VIEW_QUERY_KEY } from "../lib/views";

export function SecretFindingsBanner({
  sessionId,
  findings,
  dismissed,
  onFindingClick,
}: {
  sessionId: string;
  findings: SecretFinding[];
  dismissed: boolean;
  /** Open the Timeline at the interaction a finding was found in. Omitted when there's nowhere to
   *  go, in which case the findings render as plain text. */
  onFindingClick?: (interactionSeq: number) => void;
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

  const ordered = orderSecretFindings(findings);

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
          <li key={secretFindingKey(f)}>
            {onFindingClick ? (
              <button
                type="button"
                className="secret-banner-link"
                onClick={() => onFindingClick(f.interactionSeq)}
                title={`Show interaction ${interactionNumber(f.interactionSeq)} in the timeline`}
              >
                {secretFindingLine(f)}
              </button>
            ) : (
              secretFindingLine(f)
            )}
          </li>
        ))}
        {/* The list stops at 5, but every finding is marked on its turn in the timeline, so say where
            the rest are rather than leaving them unreachable. */}
        {ordered.length > 5 && (
          <li>
            …and {ordered.length - 5} more
            {onFindingClick ? ", marked on their turns in the timeline" : ""}
          </li>
        )}
      </ol>
      <p className="secret-banner-detail">
        If any of these are real, rotate them. Only the redacted hint is stored, never the
        credential itself.
      </p>
      {error && <p className="task-error">{error}</p>}
    </div>
  );
}
