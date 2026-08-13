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
  const mutation = useMutation({
    mutationFn: (action: "dismiss" | "undismiss") =>
      action === "dismiss" ? dismissSecretFindings(sessionId) : undismissSecretFindings(sessionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["session", sessionId] });
      void qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  if (!findings.length) return null;

  if (dismissed) {
    return (
      <div className="secret-banner-dismissed">
        <span>
          Credential warning dismissed ({findings.length} {pluralize(findings.length, "finding")}).
        </span>
        <button
          type="button"
          className="kv-more-link"
          onClick={() => mutation.mutate("undismiss")}
          disabled={mutation.isPending}
        >
          Show again
        </button>
      </div>
    );
  }

  return (
    <div className="secret-banner" role="alert">
      <div className="secret-banner-head">
        <ShieldAlert size={15} strokeWidth={2} aria-hidden />
        <span className="secret-banner-title">
          This session may contain {findings.length > 1 ? "exposed credentials" : "an exposed credential"}
        </span>
        <button
          type="button"
          className="task-action"
          onClick={() => mutation.mutate("dismiss")}
          disabled={mutation.isPending}
          title="Hide this warning until the findings change"
        >
          Dismiss
        </button>
      </div>
      <ul className="secret-banner-list">
        {findings.slice(0, 5).map((f, i) => (
          <li key={`${f.category}-${f.interactionSeq}-${f.chunkType}-${i}`}>{findingLine(f)}</li>
        ))}
        {findings.length > 5 && <li>…and {findings.length - 5} more</li>}
      </ul>
      <p className="secret-banner-detail">
        If any of these are real, rotate them. Only the redacted hint is stored, never the
        credential itself.
      </p>
    </div>
  );
}
