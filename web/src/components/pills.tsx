import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { pluralize } from "../lib/format";
import { InteractionsIcon } from "../lib/icons";

export const Dash = () => <span className="muted">—</span>;

/** A compact "value + icon" stat, e.g. tokens (coins), interactions (chat), tasks (clipboard).
 *  `title` is the tooltip / accessible name (the value spelled out); the icon is decorative. */
export function IconStat({
  value,
  title,
  icon: Icon,
  size = 13,
  className,
  iconFirst = false,
}: {
  value: ReactNode;
  title: string;
  icon: LucideIcon;
  size?: number;
  className?: string;
  /** Put the icon before the value (e.g. the session list) instead of after it (the default). */
  iconFirst?: boolean;
}) {
  const icon = <Icon size={size} strokeWidth={1.75} aria-hidden />;
  return (
    <span className={`icon-stat${className ? " " + className : ""}`} title={title} aria-label={title}>
      {iconFirst ? <>{icon}{value}</> : <>{value}{icon}</>}
    </span>
  );
}

/** A count of interactions rendered as the count + the chat icon — the icon means "interactions"
 *  throughout the session UI (timeline chapter headers, a task's timeline link, the session list). */
export function InteractionCount({ n, size = 13, className, iconFirst = false }: { n: number; size?: number; className?: string; iconFirst?: boolean }) {
  return <IconStat value={n} title={`${n} ${pluralize(n, "interaction")}`} icon={InteractionsIcon} size={size} className={className} iconFirst={iconFirst} />;
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
