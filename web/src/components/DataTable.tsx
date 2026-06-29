import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState, type ReactNode } from "react";

/** Column descriptor mirroring the old makeTable: a sort accessor + a cell renderer. */
export interface Column<T> {
  id: string;
  label: string;
  num?: boolean;
  className?: string;
  /** Value used for sorting. Omit to make the column non-sortable. */
  sortValue?: (row: T) => string | number;
  cell: (row: T) => ReactNode;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  /** Initial sort column id (descending, matching the static report's behavior). */
  initialSort?: string;
  maxHeight?: number;
}

export function DataTable<T>({ columns, rows, initialSort, maxHeight = 510 }: Props<T>) {
  const [sorting, setSorting] = useState<SortingState>(
    initialSort ? [{ id: initialSort, desc: true }] : [],
  );

  const defs = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((c) => ({
        id: c.id,
        header: c.label,
        accessorFn: c.sortValue ?? (() => 0),
        enableSorting: !!c.sortValue,
        sortDescFirst: true,
        cell: ({ row }) => c.cell(row.original),
        meta: { className: [c.num ? "num" : "", c.className ?? ""].filter(Boolean).join(" ") },
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: defs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const cls = (id: string) =>
    (defs.find((d) => d.id === id)?.meta as { className?: string } | undefined)?.className ?? "";

  return (
    <div className="scroll" style={{ maxHeight }}>
      <table>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const sorted = h.column.getIsSorted();
                const sortable = h.column.getCanSort();
                return (
                  <th
                    key={h.id}
                    className={`t-overline ${cls(h.column.id)}`.trim()}
                    onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
                    style={sortable ? undefined : { cursor: "default" }}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sorted === "desc" ? " ▾" : sorted === "asc" ? " ▴" : ""}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className={cls(cell.column.id)}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
