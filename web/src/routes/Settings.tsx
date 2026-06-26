import { Link, useParams, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Brain,
  Check,
  Loader2,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { saveSetting, useSettingsQuery } from "../lib/settings";
import { Select } from "../components/Select";
import type { SettingDescriptor, SettingsCategory } from "../types";

/** Icon per category id. Categories themselves come from the server (registry-driven); this is the
 *  only purely-presentational mapping the surface adds. Unknown ids fall back to the sliders icon. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  general: SlidersHorizontal,
  interpretation: Brain,
};

/** The full settings surface (#154): a Codex-style take-over with a left category nav and a right
 *  pane of sectioned settings. Reached at /settings/$category and deep-linkable. `backTo` is the app
 *  screen to return to on close — the Layout supplies the last non-settings location; it defaults to
 *  the dashboard for a cold deep-link (the route renders this with no props). */
export function SettingsSurface({ backTo = "/" }: { backTo?: string }) {
  const { category } = useParams({ strict: false }) as { category?: string };
  const router = useRouter();
  const query = useSettingsQuery();
  const categories = query.data?.categories ?? [];
  const activeId = category ?? categories[0]?.id ?? "general";
  const active = categories.find((c) => c.id === activeId);

  return (
    <div className="settings-surface">
      <aside className="settings-nav">
        <button
          type="button"
          className="settings-back"
          onClick={() => router.history.push(backTo)}
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
          <span>Back to app</span>
        </button>
        <h1 className="settings-title">Settings</h1>
        <nav className="settings-categories" aria-label="Settings categories">
          {categories.map((cat) => {
            const Ico = CATEGORY_ICONS[cat.id] ?? SlidersHorizontal;
            return (
              <Link
                key={cat.id}
                to="/settings/$category"
                params={{ category: cat.id }}
                className="settings-cat-link"
                aria-current={cat.id === activeId ? "page" : undefined}
              >
                <Ico size={16} strokeWidth={1.75} aria-hidden />
                <span>{cat.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="settings-pane">
        {query.isPending ? (
          <div className="center-state">Loading settings…</div>
        ) : query.isError ? (
          <div className="center-state">Couldn't load settings: {(query.error as Error).message}</div>
        ) : !active ? (
          <div className="center-state">Unknown settings category.</div>
        ) : (
          <SettingsCategoryPane key={active.id} category={active} />
        )}
      </main>
    </div>
  );
}

/** Seed the editable value for a setting from the file layer (toggles hold a boolean, the rest a
 *  string). Conditions read live from these values, so they react as the user edits. */
function seedValue(s: SettingDescriptor): unknown {
  if (s.ui.control === "toggle") return Boolean(s.fileValue ?? s.effectiveValue);
  return s.fileValue != null ? String(s.fileValue) : "";
}

function SettingsCategoryPane({ category }: { category: SettingsCategory }) {
  const sections = category.sections.filter((s) => s.settings.length > 0);
  const all = sections.flatMap((s) => s.settings);
  const byPath = new Map(all.map((s) => [s.path, s]));

  // Current value per setting path, lifted here so cross-field conditions (a field's activeWhen /
  // visibleWhen referencing another field) can be evaluated and react live as the user edits.
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(all.map((s) => [s.path, seedValue(s)])),
  );
  const setValue = (path: string, v: unknown) => setValues((prev) => ({ ...prev, [path]: v }));

  // The value used to evaluate a condition against `path`: the live value, or the referenced setting's
  // effectiveDefault when unset (e.g. an unset provider resolves to its default, claude-cli).
  const condValue = (path: string): string => {
    const v = values[path];
    if (v != null && v !== "") return String(v);
    return byPath.get(path)?.ui.effectiveDefault ?? "";
  };
  const isActive = (s: SettingDescriptor) => !s.ui.activeWhen || Boolean(values[s.ui.activeWhen.path]);
  const isVisible = (s: SettingDescriptor) =>
    !s.ui.visibleWhen || s.ui.visibleWhen.in.includes(condValue(s.ui.visibleWhen.path));

  return (
    <div className="settings-content">
      <header className="settings-pane-head">
        <h2>{category.label}</h2>
      </header>
      {sections.length === 0 ? (
        <p className="settings-empty">No settings in this category yet.</p>
      ) : (
        sections.map((section, i) => {
          const visible = section.settings.filter(isVisible);
          if (!visible.length) return null;
          return (
            <section className="settings-section" key={section.label ?? i}>
              {section.label && <h3 className="settings-section-head">{section.label}</h3>}
              <div className="settings-rows">
                {visible.map((s) => (
                  <SettingRow
                    key={s.path}
                    descriptor={s}
                    value={values[s.path]}
                    disabled={!isActive(s)}
                    onChange={(v) => setValue(s.path, v)}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** One setting: name + description on the left, its control on the right (#154). The value is owned by
 *  the pane (so conditions can see it); this row drives the control and its own save status. Text-like
 *  controls save on blur; toggles/selects save immediately. `disabled` greys the control out (e.g. the
 *  LLM fields until task extraction is on). When an env var overrides the value, the row says so. */
function SettingRow({
  descriptor,
  value,
  disabled,
  onChange,
}: {
  descriptor: SettingDescriptor;
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const { ui, fileValue, effectiveValue, override } = descriptor;
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  // The last value persisted to the server, so a blur with no real change doesn't re-save.
  const savedRef = useRef(fileValue != null ? String(fileValue) : "");

  const text = value == null ? "" : String(value);
  const checked = Boolean(value);
  const placeholder = effectiveValue != null ? String(effectiveValue) : "Default";

  async function save(v: unknown) {
    setState({ kind: "saving" });
    try {
      await saveSetting(descriptor.path, v);
      setState({ kind: "saved" });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
      throw err;
    }
  }
  const saveText = () => {
    if (text === savedRef.current) return;
    savedRef.current = text;
    void save(text).catch(() => {});
  };

  const control = (() => {
    switch (ui.control) {
      case "toggle":
        return (
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            className="setting-toggle"
            disabled={disabled}
            onClick={() => {
              const next = !checked;
              onChange(next); // optimistic; update the pane so conditions react
              save(next).catch(() => onChange(!next)); // revert on failure
            }}
          >
            <span className="setting-toggle-knob" />
          </button>
        );
      case "select":
        return (
          <Select
            wrapperClassName="setting-select"
            value={text}
            disabled={disabled}
            onChange={(e) => {
              onChange(e.target.value);
              savedRef.current = e.target.value;
              void save(e.target.value).catch(() => {});
            }}
          >
            {(ui.options ?? []).map((opt, i) =>
              opt === "separator" ? (
                <hr key={`sep-${i}`} />
              ) : (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ),
            )}
          </Select>
        );
      case "textarea":
        return (
          <textarea
            className="setting-input setting-textarea"
            value={text}
            placeholder={placeholder}
            rows={3}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onBlur={saveText}
          />
        );
      case "number":
        return (
          <input
            type="number"
            className="setting-input"
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onBlur={saveText}
          />
        );
      default:
        return (
          <input
            type="text"
            className="setting-input"
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onBlur={saveText}
          />
        );
    }
  })();

  return (
    <div className={`setting-row${disabled ? " setting-row-disabled" : ""}`}>
      <div className="setting-label">
        <span className="setting-name">{ui.label}</span>
        {ui.description && <span className="setting-desc">{ui.description}</span>}
        {override && (
          <span className="setting-override">
            Set by <code>{override.name}</code> — that value takes precedence; an edit here won't take
            effect until it's unset.
          </span>
        )}
      </div>
      <div className="setting-control">
        {control}
        {!disabled && <SaveStatus state={state} />}
      </div>
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state.kind === "saving") {
    return (
      <span className="setting-status">
        <Loader2 size={13} className="spin" aria-hidden /> Saving…
      </span>
    );
  }
  if (state.kind === "saved") {
    return (
      <span className="setting-status saved">
        <Check size={13} aria-hidden /> Saved
      </span>
    );
  }
  if (state.kind === "error") {
    return <span className="setting-status error">{state.message}</span>;
  }
  return null;
}
