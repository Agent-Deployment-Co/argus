import type { ReactNode } from "react";

export const Dash = () => <span className="muted">—</span>;

export function SkillPill({ skill }: { skill: string }) {
  return <span className="pill skill" title={skill}>{skill}</span>;
}

export function Skills({ skills }: { skills: string[] }) {
  if (!skills.length) return <Dash />;
  return <>{skills.map((s) => <SkillPill key={s} skill={s} />)}</>;
}

export function OutcomeCell({ outcome }: { outcome?: string }): ReactNode {
  if (outcome === "clean") return <span className="pill clean">clean</span>;
  if (outcome === "interrupted") return <span className="pill interrupted">intr.</span>;
  return <Dash />;
}

export function TokGrowthCell({ growth }: { growth: number | null }): ReactNode {
  if (growth == null) return <Dash />;
  const txt = growth.toFixed(1) + "×";
  return growth >= 5 ? <span className="pill warn">{txt}</span> : <>{txt}</>;
}
