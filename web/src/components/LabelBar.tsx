import { Check, Minus, Pencil, Plus, TagPlus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLabelCatalogMutations, useLabelsQuery, useSessionLabelMutations } from "../lib/labels";
import type { AppliedLabel, LabelRecord } from "../types";

/** Tri-state a label can be in relative to a set of sessions: fully applied, fully absent, or
 *  (bulk-mode only) applied to some but not all of the selected sessions. */
export type TriState = "checked" | "unchecked" | "mixed";

// The add/remove/edit control for a session's or a task's labels (session-and-task-labels). Renders
// the applied labels as removable chips plus a popover to apply an existing label, create a new one,
// or rename/delete a label in the catalog. `taskSeq` undefined => the whole session; a number => that
// task position within the session.
export function LabelBar({
  sessionId,
  taskSeq,
  applied,
  size = "md",
}: {
  sessionId: string;
  taskSeq?: number;
  applied: AppliedLabel[];
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const catalog = useLabelsQuery();
  const { assign, unassign } = useSessionLabelMutations(sessionId);
  const { create, rename, remove } = useLabelCatalogMutations();

  // Close the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const appliedIds = new Set(applied.map((l) => l.id));
  const stateFor = (label: LabelRecord): TriState => (appliedIds.has(label.id) ? "checked" : "unchecked");
  const toggle = (label: LabelRecord) => {
    const vars = { labelId: label.id, taskSeq };
    if (appliedIds.has(label.id)) unassign.mutate(vars);
    else assign.mutate(vars);
  };
  const removeChip = (labelId: string) => unassign.mutate({ labelId, taskSeq });

  return (
    <div className={`labelbar labelbar--${size}`} ref={rootRef}>
      {applied.map((label) => (
        <span
          key={label.id}
          className={`label-chip${label.origin === "system" ? " label-chip--system" : ""}`}
          title={label.origin === "system" ? "System label" : "Label"}
        >
          {label.name}
          <button
            type="button"
            className="label-chip-x"
            aria-label={`Remove label ${label.name}`}
            onClick={() => removeChip(label.id)}
          >
            <X size={12} strokeWidth={2} aria-hidden />
          </button>
        </span>
      ))}

      <div className="labelbar-add">
        <button
          type="button"
          className="label-add-btn"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title="Add a label"
        >
          <TagPlus size={13} strokeWidth={2} aria-hidden />
          <span>Add Label</span>
        </button>

        {open && (
          <LabelPopover
            labels={catalog.data ?? []}
            loading={catalog.isPending}
            stateFor={stateFor}
            busy={assign.isPending || unassign.isPending || create.isPending}
            error={
              [create.error, assign.error, unassign.error, rename.error, remove.error].find(
                (e): e is Error => e instanceof Error,
              )?.message ?? null
            }
            onToggle={toggle}
            onCreate={async (name) => {
              const res = await create.mutateAsync(name);
              assign.mutate({ labelId: res.label.id, taskSeq });
            }}
            onRename={(id, name) => rename.mutate({ id, name })}
            onDelete={(id) => remove.mutate(id)}
          />
        )}
      </div>
    </div>
  );
}

const STATE_RANK: Record<TriState, number> = { checked: 0, mixed: 1, unchecked: 2 };

/** The add/pick/create/rename/delete popover shared by the per-session/task {@link LabelBar} and
 *  the bulk-selection label editor (`BulkLabelButton` in `Sessions.tsx`) — bulk mode is a superset
 *  (it can show a "mixed" tri-state across the selection), so both drive the same UI off a
 *  `stateFor` predicate rather than a plain `appliedIds` set. Rows are always sorted
 *  [checked, mixed, unchecked] first, then alphabetically. */
export function LabelPopover({
  labels,
  loading,
  stateFor,
  busy,
  error,
  onToggle,
  onCreate,
  onRename,
  onDelete,
}: {
  labels: LabelRecord[];
  loading: boolean;
  stateFor: (label: LabelRecord) => TriState;
  busy: boolean;
  error: string | null;
  onToggle: (label: LabelRecord) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = query.trim();
  const filtered = (trimmed ? labels.filter((l) => l.name.toLowerCase().includes(trimmed.toLowerCase())) : labels)
    .slice()
    .sort((a, b) => STATE_RANK[stateFor(a)] - STATE_RANK[stateFor(b)] || a.name.localeCompare(b.name));
  const exactMatch = labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase());
  const canCreate = trimmed.length > 0 && !exactMatch;
  const confirmingDelete = labels.find((l) => l.id === confirmingDeleteId) ?? null;

  const submitCreate = () => {
    if (!canCreate) return;
    onCreate(trimmed);
    setQuery("");
  };

  const startRename = (label: LabelRecord) => {
    setEditingId(label.id);
    setEditingName(label.name);
  };
  const commitRename = () => {
    if (editingId && editingName.trim()) onRename(editingId, editingName.trim());
    setEditingId(null);
  };

  return (
    <div className="label-popover" role="dialog" aria-label="Manage labels">
      <input
        ref={inputRef}
        className="label-popover-input"
        placeholder="Find or create a label…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submitCreate();
        }}
      />

      {error && <div className="label-popover-error" role="alert">{error}</div>}

      <div className="label-popover-list">
        {loading ? (
          <div className="label-popover-empty">Loading…</div>
        ) : filtered.length === 0 && !canCreate ? (
          <div className="label-popover-empty">{trimmed ? "No matching labels." : "No labels yet."}</div>
        ) : (
          filtered.map((label) =>
            editingId === label.id ? (
              <div key={label.id} className="label-popover-row label-popover-row--editing">
                <input
                  className="label-popover-input label-popover-rename"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  autoFocus
                />
                <button type="button" className="label-icon-btn" aria-label="Save name" onClick={commitRename}>
                  <Check size={14} strokeWidth={2} aria-hidden />
                </button>
                <button type="button" className="label-icon-btn" aria-label="Cancel" onClick={() => setEditingId(null)}>
                  <X size={14} strokeWidth={2} aria-hidden />
                </button>
              </div>
            ) : (
              <div key={label.id} className="label-popover-row">
                <button
                  type="button"
                  className={`label-popover-pick${stateFor(label) !== "unchecked" ? " is-applied" : ""}`}
                  onClick={() => onToggle(label)}
                  disabled={busy}
                >
                  <span className={`label-popover-check${stateFor(label) === "mixed" ? " is-mixed" : ""}`}>
                    {stateFor(label) === "checked" && <Check size={13} strokeWidth={2.25} aria-hidden />}
                    {stateFor(label) === "mixed" && <Minus size={9} strokeWidth={3} aria-hidden />}
                  </span>
                  <span className="label-popover-name">{label.name}</span>
                  {label.origin === "system" && <span className="label-popover-tag">system</span>}
                </button>
                <button type="button" className="label-icon-btn" aria-label={`Rename ${label.name}`} onClick={() => startRename(label)}>
                  <Pencil size={13} strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  type="button"
                  className="label-icon-btn label-icon-btn--danger"
                  aria-label={`Delete ${label.name}`}
                  onClick={() => setConfirmingDeleteId(label.id)}
                >
                  <Trash2 size={13} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
            ),
          )
        )}

        {canCreate && (
          <button type="button" className="label-popover-create" onClick={submitCreate} disabled={busy}>
            <Plus size={13} strokeWidth={2} aria-hidden />
            <span>Create &amp; apply “{trimmed}”</span>
          </button>
        )}
      </div>

      {confirmingDelete && (
        <DeleteLabelDialog
          label={confirmingDelete}
          onCancel={() => setConfirmingDeleteId(null)}
          onConfirm={() => {
            onDelete(confirmingDelete.id);
            setConfirmingDeleteId(null);
          }}
        />
      )}
    </div>
  );
}

/** The label-catalog delete confirmation modal, rendered from the shared {@link LabelPopover}
 *  above — deleting a label from the catalog has no mixed-state nuance even in bulk mode. */
export function DeleteLabelDialog({
  label,
  onCancel,
  onConfirm,
}: {
  label: LabelRecord;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="label-delete-backdrop" onMouseDown={onCancel}>
      <div
        className="label-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete label"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="label-delete-text">
          Delete the label “{label.name}”? It will be removed from every session it's applied to.
        </p>
        <div className="label-delete-actions">
          <button type="button" className="label-delete-btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button type="button" className="label-delete-btn label-delete-btn--danger" onClick={onConfirm}>
            Delete label
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
