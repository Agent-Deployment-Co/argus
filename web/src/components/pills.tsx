import { MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";
import { pluralize } from "../lib/format";

export const Dash = () => <span className="muted">—</span>;

/** A count of interactions rendered as "N" + the chat icon — the icon means "interactions"
 *  throughout the session UI (timeline chapter headers, a task's timeline link). */
export function InteractionCount({ n, size = 13, className }: { n: number; size?: number; className?: string }) {
  const label = `${n} ${pluralize(n, "interaction")}`;
  return (
    <span className={`interaction-count${className ? " " + className : ""}`} title={label} aria-label={label}>
      {n}
      <MessagesSquare size={size} strokeWidth={1.75} aria-hidden />
    </span>
  );
}

export function SkillPill({ skill }: { skill: string }) {
  return <span className="pill skill" title={skill}>{skill}</span>;
}

export function Skills({ skills }: { skills: string[] }) {
  if (!skills.length) return <Dash />;
  return <>{skills.map((s) => <SkillPill key={s} skill={s} />)}</>;
}


export function TokGrowthCell({ growth }: { growth: number | null }): ReactNode {
  if (growth == null) return <Dash />;
  const txt = growth.toFixed(1) + "×";
  return growth >= 5 ? <span className="pill warn">{txt}</span> : <>{txt}</>;
}
