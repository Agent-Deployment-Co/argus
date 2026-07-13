import type { ReactNode } from "react";

// A top-level block on a data view. Renders a <section> (which carries the app's vertical rhythm —
// `section { margin: 0 0 42px }`) with an optional accent eyebrow heading above its content. This is
// the standard way to title and space a region of a page; don't hand-write <section> + <h2
// className="t-eyebrow"> or reach for inline margins. See docs/internals/design-system.md.
//
// Composition rule: a Section holds Panels (charts / mixed content) and/or bare tables (DataTable
// owns its own chrome, so tables are NOT wrapped in a Panel). Use `.grid2` inside a Section to place
// two Panels side by side.
export function Section({
  eyebrow,
  children,
  className,
  id,
}: {
  /** Accent overline that labels the section (e.g. "Trends"). Omit for an unlabeled block. */
  eyebrow?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={className} id={id}>
      {eyebrow != null && <h2 className="t-eyebrow">{eyebrow}</h2>}
      {children}
    </section>
  );
}
