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
          </div>
        ))}
      </div>
    </section>
  );
}
