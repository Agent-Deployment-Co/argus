import type { ReactNode } from "react";

export interface Stat {
  label: string;
  value: ReactNode;
}

export function StatCards({ stats, id }: { stats: Stat[]; id?: string }) {
  return (
    <div className="cards" id={id}>
      {stats.map((s) => (
        <div className="card" key={s.label}>
          <div className="label t-overline">{s.label}</div>
          <div className="value">{s.value}</div>
        </div>
      ))}
    </div>
  );
}
