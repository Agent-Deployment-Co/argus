import { Link, useParams, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  Check,
  ListChecks,
  Loader2,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { saveSetting, useSettingsQuery } from "../lib/settings";
import type { SettingDescriptor, SettingsCategory } from "../types";

/** Icon per category id. Categories themselves come from the server (registry-driven); this is the
 *  only purely-presentational mapping the surface adds. Unknown ids fall back to the sliders icon. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  general: SlidersHorizontal,
  tasks: ListChecks,
  llm: Bot,
};

/** The full settings surface (#154): a Codex-style take-over with a left category nav and a right
 *  pane of sectioned settings. Reached at /settings/$category and deep-linkable. */
export function SettingsSurface() {
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
          onClick={() => router.history.back()}
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
          <span>Back to app</span>
        </button>
        <h1 className="settings-title">Settings</h1>
        <nav className="settings-categories" aria-label="Settings categories">
          <p className="settings-group-heading">Configuration</p>
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

function SettingsCategoryPane({ category }: { category: SettingsCategory }) {
  const sections = category.sections.filter((s) => s.settings.length > 0);
  return (
    <div className="settings-content">
      <header className="settings-pane-head">
        <h2>{category.label}</h2>
      </header>
      {sections.length === 0 ? (
        <p className="settings-empty">No settings in this category yet.</p>
      ) : (
        sections.map((section, i) => (
          <section className="settings-section" key={section.label ?? i}>
            {section.label && <h3 className="settings-section-head">{section.label}</h3>}
            <div className="settings-rows">
              {section.settings.map((s) => (
                <SettingRow key={s.path} descriptor={s} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** One setting: name + description on the left, its control on the right (#154). Text-like controls
 *  save on blur; toggles/selects save immediately. The control edits the `argus.json` layer; when an
 *  env var overrides it, the row says so (a file edit won't take effect until the override is unset). */
function SettingRow({ descriptor }: { descriptor: SettingDescriptor }) {
  const { ui, fileValue, effectiveValue, override } = descriptor;
  const [state, setState] = useState<SaveState>({ kind: "idle" });

  // Local control state, so edits reflect immediately (we don't refetch the whole surface per save).
  const initialText = fileValue != null ? String(fileValue) : "";
  const [text, setText] = useState(initialText);
  const [checked, setChecked] = useState(Boolean(fileValue ?? effectiveValue));
  const placeholder = effectiveValue != null ? String(effectiveValue) : "Default";

  async function save(value: unknown) {
    setState({ kind: "saving" });
    try {
      await saveSetting(descriptor.path, value);
      setState({ kind: "saved" });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
      throw err;
    }
  }

  const control = (() => {
    switch (ui.control) {
      case "toggle":
        return (
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            className="setting-toggle"
            onClick={() => {
              const next = !checked;
              setChecked(next); // optimistic
              save(next).catch(() => setChecked(!next)); // revert on failure
            }}
          >
            <span className="setting-toggle-knob" />
          </button>
        );
      case "select":
        return (
          <select
            className="setting-input"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              void save(e.target.value).catch(() => {});
            }}
          >
            <option value="">Default{effectiveValue != null ? ` (${effectiveValue})` : ""}</option>
            {(ui.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        );
      case "textarea":
        return (
          <textarea
            className="setting-input setting-textarea"
            value={text}
            placeholder={placeholder}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== initialText && void save(text).catch(() => {})}
          />
        );
      case "number":
        return (
          <input
            type="number"
            className="setting-input"
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== initialText && void save(text).catch(() => {})}
          />
        );
      default:
        return (
          <input
            type="text"
            className="setting-input"
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== initialText && void save(text).catch(() => {})}
          />
        );
    }
  })();

  return (
    <div className="setting-row">
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
        <SaveStatus state={state} />
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
