import { fmt, usd } from "../lib/format";
import type { NamedUsage } from "../types";
import type { Column } from "./DataTable";

/** NamedUsage.meta is an open record; sessions count is stashed there by the aggregator. */
export const metaSessions = (r: NamedUsage): number =>
  typeof r.meta?.sessions === "number" ? r.meta.sessions : 0;

/** Shared columns for the source / project / user breakdown tables. */
export function namedUsageColumns(firstLabel: string): Column<NamedUsage>[] {
  return [
    { id: "name", label: firstLabel, sortValue: (r) => r.name, cell: (r) => r.name },
    { id: "sessions", label: "Sessions", num: true, sortValue: metaSessions, cell: (r) => metaSessions(r) },
    { id: "messages", label: "Msgs", num: true, sortValue: (r) => r.messages, cell: (r) => fmt(r.messages) },
    { id: "total", label: "Tokens", num: true, sortValue: (r) => r.total, cell: (r) => fmt(r.total) },
    { id: "cost", label: "Cost", num: true, sortValue: (r) => r.cost, cell: (r) => usd(r.cost) },
  ];
}
