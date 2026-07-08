import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

export interface FilterDropdownProps {
  icon: ReactNode;
  label: string;
  /** Text shown on the pill button; falls back to `label` when no filter is set. */
  summary?: string;
  /** Whether a filter is currently applied — drives the pill's filled/active look. */
  active: boolean;
  /** Present only when a filter is applied; omit to hide the "Clear" action. */
  onClear?: () => void;
  children: ReactNode;
}

/** A pill button that opens a panel of filter options below it — the shared shape for the sessions
 *  inbox toolbar's labels/date/sources filters (screenshot-matched structure, not colors). Closes on
 *  outside click or Escape; the panel's contents (search box, option list, …) are supplied by the
 *  caller since each filter's controls differ. */
export function FilterDropdown({ icon, label, summary, active, onClear, children }: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  return (
    <div className="filter-dropdown" ref={ref}>
      <button
        type="button"
        className={`filter-dropdown-btn${active ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {icon}
        <span>{summary ?? label}</span>
        <ChevronDown size={13} strokeWidth={2} aria-hidden />
      </button>
      {open && (
        <div className="filter-dropdown-panel" role="dialog" aria-label={label}>
          <div className="filter-dropdown-panel-head">
            <span className="filter-dropdown-title">{label}</span>
            {onClear && (
              <button type="button" className="filter-dropdown-clear" onClick={onClear}>
                Clear
              </button>
            )}
          </div>
          {children}
        </div>
      )}
    </div>
  );
}

/** One checkable row inside a `FilterDropdown` panel (the labels/sources option lists). */
export function FilterDropdownOption({
  label,
  selected,
  onToggle,
}: {
  label: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`filter-dropdown-option${selected ? " selected" : ""}`}
      onClick={onToggle}
      role="option"
      aria-selected={selected}
    >
      <span>{label}</span>
      {selected && <Check size={14} strokeWidth={2.5} aria-hidden />}
    </button>
  );
}
