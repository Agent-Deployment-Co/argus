import { Check, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLabelCatalogMutations, useLabelsQuery, useSessionLabelMutations } from "../lib/labels";
import type { AppliedLabel, LabelRecord } from "../types";

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
  const toggle = (labelId: string) => {
    const vars = { labelId, taskSeq };
    if (appliedIds.has(labelId)) unassign.mutate(vars);
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
          {applied.length === 0 ? (
            <>
              <Tag size={12} strokeWidth={1.75} aria-hidden />
              <span>Label</span>
            </>
          ) : (
            <Plus size={13} strokeWidth={2} aria-hidden />
          )}
        </button>

        {open && (
          <LabelPopover
            labels={catalog.data ?? []}
            loading={catalog.isPending}
            appliedIds={appliedIds}
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

function LabelPopover({
  labels,
  loading,
  appliedIds,
  busy,
  error,
  onToggle,
  onCreate,
  onRename,
  onDelete,
}: {
  labels: LabelRecord[];
  loading: boolean;
  appliedIds: Set<string>;
  busy: boolean;
  error: string | null;
  onToggle: (labelId: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = query.trim();
  const filtered = trimmed
    ? labels.filter((l) => l.name.toLowerCase().includes(trimmed.toLowerCase()))
    : labels;
  const exactMatch = labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase());
  const canCreate = trimmed.length > 0 && !exactMatch;

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
                  className={`label-popover-pick${appliedIds.has(label.id) ? " is-applied" : ""}`}
                  onClick={() => onToggle(label.id)}
                  disabled={busy}
                >
                  <span className="label-popover-check">
                    {appliedIds.has(label.id) && <Check size={13} strokeWidth={2.25} aria-hidden />}
                  </span>
                  <span className="label-popover-name">{label.name}</span>
                  {label.origin === "system" && <span className="label-popover-tag">system</span>}
                </button>
                <button type="button" className="label-icon-btn" aria-label={`Rename ${label.name}`} onClick={() => startRename(label)}>
                  <Pencil size={13} strokeWidth={1.75} aria-hidden />
                </button>
                <button type="button" className="label-icon-btn label-icon-btn--danger" aria-label={`Delete ${label.name}`} onClick={() => onDelete(label.id)}>
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
    </div>
  );
}
