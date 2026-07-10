import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** A small icon button that copies `value` to the clipboard, flipping to a check briefly. `label` is
 *  the tooltip / accessible name (e.g. "Copy prompt", "Copy transcript path"). Shared by the Session
 *  Data card and the timeline's prompt/response halves. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // Clipboard API unavailable (e.g. non-secure context) — silently no-op.
        }
      }}
    >
      {copied ? <Check size={13} strokeWidth={1.75} aria-hidden /> : <Copy size={13} strokeWidth={1.75} aria-hidden />}
    </button>
  );
}
