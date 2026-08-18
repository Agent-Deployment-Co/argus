import { Link } from "@tanstack/react-router";
import type { Recommendation } from "../types";

export function Recommendations({ recs }: { recs: Recommendation[] }) {
  if (!recs.length) return null;
  return (
    <section>
      <h2 className="t-eyebrow">Recommendations</h2>
      <div className="rec-list">
        {recs.map((r) => (
          <div className={`rec ${r.severity}`} key={r.id}>
            <div className="rec-title">{r.title}</div>
            <div className="rec-detail">{r.detail}</div>
            {r.link && (
              // Spreading the current search keeps the active date range and source, so the list the
              // user lands on is scoped the same way the count was.
              <Link
                to={r.link.to}
                search={(prev: Record<string, unknown>) => ({ ...prev, ...r.link!.search })}
                className="rec-link"
              >
                {r.link.label}
              </Link>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
