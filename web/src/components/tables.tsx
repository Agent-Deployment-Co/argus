import type { ReactNode } from "react";
import { fmt, usd } from "../lib/format";
import type { NamedUsage } from "../types";
import type { Column } from "./DataTable";

/** NamedUsage.meta is an open record; sessions count is stashed there by the aggregator. */
export const metaSessions = (r: NamedUsage): number =>
  typeof r.meta?.sessions === "number" ? r.meta.sessions : 0;

/** Shared columns for the source / project / user breakdown tables. `firstCell` overrides how the
 *  name column renders (e.g. a <SourceBadge> for the by-source table); defaults to the plain name. */
export function namedUsageColumns(
  firstLabel: string,
  firstCell: (r: NamedUsage) => ReactNode = (r) => r.name,
): Column<NamedUsage>[] {
  return [
    { id: "name", label: firstLabel, sortValue: (r) => r.name, cell: firstCell },
    { id: "sessions", label: "Sessions", num: true, sortValue: metaSessions, cell: (r) => metaSessions(r) },
    { id: "messages", label: "Responses", num: true, sortValue: (r) => r.messages, cell: (r) => fmt(r.messages) },
    { id: "total", label: "Tokens", num: true, sortValue: (r) => r.total, cell: (r) => fmt(r.total) },
    { id: "cost", label: "Cost", num: true, sortValue: (r) => r.cost, cell: (r) => usd(r.cost) },
  ];
}
