import { useLayoutEffect, useRef, useState } from "react";

/**
 * Text clamped to `maxLines`, truncated at a word boundary with a trailing ellipsis and an inline
 * "Read more" link that expands to the full text (no collapse). The cut point is found by measuring
 * against an off-DOM clone that mirrors the paragraph's width and text styling (font, line-height,
 * white-space, wrapping) and reserves room for the non-breaking "… Read more" suffix, re-run on text,
 * maxLines, and viewport-width change. Null prefix = the text fits (or has been expanded), shown whole.
 *
 * Shared by the session summary (2 lines) and the timeline prompt/response (10 lines) so the
 * truncation behaves identically everywhere. `className` styles the rendered <p> (it also decides the
 * white-space/wrap the clone copies, so measurement matches the real element).
 */
export function ClampText({
  text,
  maxLines,
  className,
}: {
  text: string;
  maxLines: number;
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [prefix, setPrefix] = useState<string | null>(null);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || expanded) return;
    const measure = () => {
      const cs = getComputedStyle(host);
      const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.55;
      const maxHeight = lineHeight * maxLines + 1;
      const clone = document.createElement("p");
      // Measure at the host's CONTENT width — clientWidth includes padding, so subtract it (the clone
      // itself has padding:0). This keeps truncation correct when the text has a right gutter (e.g. the
      // timeline turns reserve room for their copy button).
      const contentWidth = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      Object.assign(clone.style, {
        position: "absolute",
        left: "-9999px",
        visibility: "hidden",
        margin: "0",
        padding: "0",
        border: "0",
        width: `${contentWidth}px`,
        fontStyle: cs.fontStyle,
        fontWeight: cs.fontWeight,
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        // Copy wrapping from the real element so a pre-wrap (newline-preserving) block measures the
        // same way it renders.
        whiteSpace: cs.whiteSpace,
        overflowWrap: cs.overflowWrap,
        wordBreak: cs.wordBreak,
      });
      document.body.appendChild(clone);
      // The suffix the truncated text carries: ellipsis + the "Read more" link. Non-breaking spaces
      // keep it on one line, matching the rendered (nowrap) link, so the reservation is accurate.
      const suffix = "… Read more";
      clone.textContent = text;
      if (clone.scrollHeight <= maxHeight) {
        setPrefix(null);
        clone.remove();
        return;
      }
      // Binary-search the longest character prefix that still fits `maxLines` with the suffix appended.
      let lo = 0;
      let hi = text.length;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        clone.textContent = text.slice(0, mid) + suffix;
        if (clone.scrollHeight <= maxHeight) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      clone.remove();
      // Snap back to a word boundary so we never cut mid-word (fall back to the raw slice for a single
      // unbroken word), dropping any trailing whitespace before the ellipsis.
      const raw = text.slice(0, best);
      const atWord = raw.replace(/\s+\S*$/, "");
      setPrefix((atWord || raw).trimEnd());
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, maxLines, expanded]);

  if (prefix !== null && !expanded) {
    return (
      <p ref={ref} className={className}>
        {prefix}
        {"… "}
        <button type="button" className="read-more" onClick={() => setExpanded(true)}>
          Read more
        </button>
      </p>
    );
  }
  return (
    <p ref={ref} className={className}>
      {text}
    </p>
  );
}
