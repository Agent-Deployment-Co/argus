import type { ReactNode } from "react";

// The canonical surface card: a rounded, bordered container on the surface background (radius 12,
// 1px line, 18px padding — the shared `.panel` token). Use it for a chart or mixed content that
// needs its own framed region, with an optional title (rendered as a `.t-subhead`) and optional
// right-aligned actions. This is the one panel; don't hand-write <div className="panel"> or invent
// alternate card tokens/radii. See docs/internals/design-system.md.
//
// Composition rule: charts and mixed content go in a Panel. Tables do NOT — a DataTable owns its own
// chrome (borders, sticky header), so it sits bare inside a Section instead. Pair two Panels with a
// `.grid2` wrapper.
export function Panel({
  title,
  actions,
  children,
  className,
}: {
  /** Panel heading (rendered as `.t-subhead`). Omit for an untitled panel. */
  title?: ReactNode;
  /** Right-aligned controls in the title row (e.g. a refresh button). Requires nothing else. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`panel${className ? ` ${className}` : ""}`}>
      {(title != null || actions != null) && (
        <div className="panel-head">
          {title != null ? <h3 className="t-subhead">{title}</h3> : <span />}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
