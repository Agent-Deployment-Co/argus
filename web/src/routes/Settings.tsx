import { Link, useParams, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Brain,
  Bug,
  Check,
  Loader2,
  Lock,
  Monitor,
  Moon,
  Pencil,
  PlugZap,
  SlidersHorizontal,
  Sun,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  deleteSecret,
  fetchSecretStatus,
  saveSecret,
  saveSetting,
  testConnection,
  useSettingsQuery,
} from "../lib/settings";
import { Select } from "../components/Select";
import { useTheme, type ThemePref } from "../lib/theme";
import { Debug } from "./Debug";
import type { SecretFieldDescriptor, SecretStatus, SettingDescriptor, SettingsCategory } from "../types";

/** Icon per category id. Categories themselves come from the server (registry-driven); this is the
 *  only purely-presentational mapping the surface adds. Unknown ids fall back to the sliders icon. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  general: SlidersHorizontal,
  sessions: Brain,
  debug: Bug,
};

/** A client-only nav entry: diagnostics live in the settings surface as the "Debug" tab, but it's a
 *  read-only view (the /api/debug payload), not a registry-driven settings category. */
const DEBUG_TAB = { id: "debug", label: "Debug" };

/** Serializes setting writes (auto-save) into one queue: one request in flight at a time, so the
 *  server's read-modify-write of argus.json can't race, and the surface shows a single save state
 *  instead of per-field status. Repeated edits to the same setting collapse to the latest value. */
interface SaveQueue {
  saving: boolean;
  error: string | null;
  justSaved: boolean;
  enqueue: (path: string, value: unknown) => void;
}

function useSaveQueue(): SaveQueue {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const queue = useRef(new Map<string, unknown>());
  const running = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaving(true);
    setJustSaved(false);
    setError(null);
    let hadError = false;
    while (queue.current.size) {
      const [path, value] = queue.current.entries().next().value as [string, unknown];
      queue.current.delete(path);
      try {
        await saveSetting(path, value);
      } catch (err) {
        hadError = true;
        setError((err as Error).message);
      }
    }
    running.current = false;
    setSaving(false);
    if (!hadError) {
      setJustSaved(true);
      savedTimer.current = setTimeout(() => setJustSaved(false), 1800);
    }
  }, []);

  const enqueue = useCallback(
    (path: string, value: unknown) => {
      queue.current.set(path, value); // latest value per path wins
      void run();
    },
    [run],
  );

  return { saving, error, justSaved, enqueue };
}

/** The single, global save indicator shown in the top-right of the surface. */
function SaveIndicator({ saving, error, justSaved }: SaveQueue) {
  if (saving) {
    return (
      <div className="save-indicator">
        <Loader2 size={14} className="spin" aria-hidden /> Saving…
      </div>
    );
  }
  if (error) {
    return (
      <div className="save-indicator error" title={error}>
        <TriangleAlert size={14} aria-hidden /> Couldn't save
      </div>
    );
  }
  if (justSaved) {
    return (
      <div className="save-indicator saved">
        <Check size={14} aria-hidden /> Saved
      </div>
    );
  }
  return null;
}

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
  const isDebug = activeId === DEBUG_TAB.id;
  const active = categories.find((c) => c.id === activeId);
  const save = useSaveQueue();
  // The Debug tab is appended to whatever settings categories the API returns.
  const navCategories = [...categories, DEBUG_TAB];

  return (
    <div className="settings-surface">
      <SaveIndicator {...save} />
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
          {navCategories.map((cat) => {
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
        {isDebug ? (
          // Diagnostics — fetches its own /api/debug, independent of the settings query.
          <Debug />
        ) : query.isPending ? (
          <div className="center-state">Loading settings…</div>
        ) : query.isError ? (
          <div className="center-state">Couldn't load settings: {(query.error as Error).message}</div>
        ) : !active ? (
          <div className="center-state">Unknown settings category.</div>
        ) : (
          <SettingsCategoryPane
            key={active.id}
            category={active}
            providerConfigs={query.data?.providerConfigs}
            enqueue={save.enqueue}
          />
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

/** The color theme picker: a tri-state segmented control (System / Light / Dark) modeled after the
 *  rail's old theme switcher. It's a client-only preference (localStorage), not an `argus.json`
 *  setting, so it lives here rather than in the registry-driven rows. */
function AppearanceRow() {
  const { pref, setPref } = useTheme();
  const choice = (value: ThemePref, Ico: LucideIcon, label: string) => (
    <button
      key={value}
      type="button"
      className="theme-choice"
      aria-pressed={pref === value}
      onClick={() => setPref(value)}
      title={label}
    >
      <Ico size={15} strokeWidth={1.75} aria-hidden />
      <span>{label}</span>
    </button>
  );
  return (
    <div className="setting-row">
      <div className="setting-label">
        <span className="setting-name">Appearance</span>
        <span className="setting-desc">Color theme for the app. System follows your operating system.</span>
      </div>
      <div className="setting-control">
        <div className="theme-switcher theme-switcher-labeled" role="group" aria-label="Color theme">
          {choice("system", Monitor, "System")}
          {choice("light", Sun, "Light")}
          {choice("dark", Moon, "Dark")}
        </div>
      </div>
    </div>
  );
}

function SettingsCategoryPane({
  category,
  providerConfigs,
  enqueue,
}: {
  category: SettingsCategory;
  providerConfigs?: Record<string, Record<string, unknown>>;
  enqueue: SaveQueue["enqueue"];
}) {
  // The General category leads with the client-only Appearance (theme) control.
  const showAppearance = category.id === "general";
  const sections = category.sections.filter(
    (s) => s.settings.length > 0 || (s.secretFields?.length ?? 0) > 0,
  );
  const all = sections.flatMap((s) => s.settings);
  const byPath = new Map(all.map((s) => [s.path, s]));

  // Current value per setting path, lifted here so cross-field conditions (a field's activeWhen /
  // visibleWhen referencing another field) can be evaluated and react live as the user edits.
  // Provider-scoped fields are keyed by their full write path (llm.providerConfigs.<provider>.<field>),
  // seeded from every provider's stored config, so switching providers shows that provider's own value.
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = Object.fromEntries(all.map((s) => [s.path, seedValue(s)]));
    for (const [prov, cfg] of Object.entries(providerConfigs ?? {})) {
      for (const [field, val] of Object.entries(cfg)) {
        seed[`llm.providerConfigs.${prov}.${field}`] = val == null ? "" : String(val);
      }
    }
    return seed;
  });
  const setValue = (path: string, v: unknown) => setValues((prev) => ({ ...prev, [path]: v }));

  // The value used to evaluate a condition against `path`: the live value, or the referenced setting's
  // effectiveDefault when unset (e.g. an unset provider resolves to its default, claude-cli).
  const condValue = (path: string): string => {
    const v = values[path];
    if (v != null && v !== "") return String(v);
    return byPath.get(path)?.ui.effectiveDefault ?? "";
  };
  // Where a field's value is read/written: a provider-scoped field targets the *selected* provider's
  // block; everything else uses its flat path.
  const writePath = (s: SettingDescriptor): string =>
    s.providerScoped ? `llm.providerConfigs.${condValue("llm.provider")}.${s.path.slice("llm.".length)}` : s.path;
  const isActive = (s: SettingDescriptor) => !s.ui.activeWhen || Boolean(values[s.ui.activeWhen.path]);
  const isVisible = (s: SettingDescriptor) =>
    !s.ui.visibleWhen || s.ui.visibleWhen.in.includes(condValue(s.ui.visibleWhen.path));
  // A context-dependent placeholder (e.g. the Model field shows the selected provider's default model).
  const placeholderFor = (s: SettingDescriptor): string | undefined =>
    s.ui.placeholderByValue?.values[condValue(s.ui.placeholderByValue.path)];
  // A secret field targets the secret named for the currently-selected provider; it's shown only when
  // that provider takes a key, and inactive (like the other LLM fields) until its gate is on.
  const secretName = (f: SecretFieldDescriptor) =>
    f.secretName ?? (f.secretNames ? f.secretNames[condValue(f.providerPath)] : undefined);
  const secretActive = (f: SecretFieldDescriptor) => !f.activeWhen || Boolean(values[f.activeWhen.path]);
  const connTestActive = (ct: { activeWhen?: { path: string } }) =>
    !ct.activeWhen || Boolean(values[ct.activeWhen.path]);

  return (
    <div className="settings-content">
      <header className="settings-pane-head">
        <h2 className="t-title">{category.label}</h2>
      </header>
      {showAppearance && (
        <section className="settings-section">
          <div className="settings-rows">
            <AppearanceRow />
          </div>
        </section>
      )}
      {sections.length === 0 ? (
        showAppearance ? null : <p className="settings-empty">No settings in this category yet.</p>
      ) : (
        sections.map((section, i) => {
          const visibleSettings = section.settings.filter(isVisible);
          const visibleSecrets = (section.secretFields ?? [])
            .map((f) => ({ field: f, name: secretName(f) }))
            .filter((x): x is { field: SecretFieldDescriptor; name: string } => Boolean(x.name));
          if (!visibleSettings.length && !visibleSecrets.length) return null;
          return (
            <section className="settings-section" key={section.label ?? i}>
              {section.label && <h3 className="t-eyebrow">{section.label}</h3>}
              <div className="settings-rows">
                {visibleSettings.map((s) => {
                  const wp = writePath(s);
                  return (
                  <Fragment key={s.path}>
                    <SettingRow
                      key={wp}
                      descriptor={s}
                      value={values[wp]}
                      savePath={wp}
                      disabled={!isActive(s)}
                      placeholderOverride={placeholderFor(s)}
                      onChange={(v) => setValue(wp, v)}
                      enqueue={enqueue}
                    />
                    {/* A secret field renders right after the setting it's anchored to (its provider). */}
                    {visibleSecrets
                      .filter(({ field }) => field.providerPath === s.path)
                      .map(({ field, name }) => (
                        <SecretRow key={field.key} field={field} secretName={name} disabled={!secretActive(field)} />
                      ))}
                  </Fragment>
                  );
                })}
                {/* Fallback: any secret whose anchor setting isn't shown renders at the end. */}
                {visibleSecrets
                  .filter(({ field }) => !visibleSettings.some((s) => s.path === field.providerPath))
                  .map(({ field, name }) => (
                    <SecretRow key={field.key} field={field} secretName={name} disabled={!secretActive(field)} />
                  ))}
              </div>
              {section.connectionTest && (
                <ConnectionTest
                  // Remount (reset the result) whenever a field in this section changes — a prior
                  // "Connected" for provider A shouldn't linger after switching to provider B.
                  key={section.settings.map((s) => `${writePath(s)}=${values[writePath(s)] ?? ""}`).join("|")}
                  disabled={!connTestActive(section.connectionTest)}
                />
              )}
            </section>
          );
        })
      )}
    </div>
  );
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; model?: string }
  | { kind: "error"; message: string };

/** "Test connection" action: sends a tiny live prompt through the configured provider and reports
 *  whether a completion came back, so the user can confirm their setup works. */
function ConnectionTest({ disabled }: { disabled: boolean }) {
  const [state, setState] = useState<TestState>({ kind: "idle" });
  const run = async () => {
    setState({ kind: "testing" });
    try {
      const r = await testConnection();
      setState(r.ok ? { kind: "ok", model: r.model } : { kind: "error", message: r.error ?? "No response." });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  };
  return (
    <div className="connection-test">
      <button
        type="button"
        className="secret-btn"
        disabled={disabled || state.kind === "testing"}
        onClick={() => void run()}
      >
        {state.kind === "testing" ? (
          <Loader2 size={14} className="spin" aria-hidden />
        ) : (
          <PlugZap size={14} aria-hidden />
        )}
        {state.kind === "testing" ? "Testing…" : "Test connection"}
      </button>
      {state.kind === "ok" && (
        <span className="conn-result ok">
          <Check size={14} aria-hidden /> Connected{state.model ? ` (${state.model})` : ""}
        </span>
      )}
      {state.kind === "error" && (
        <span className="conn-result error">
          <TriangleAlert size={14} aria-hidden /> {state.message}
        </span>
      )}
    </div>
  );
}

/** An API-key field backed by the secret store (#132). Shows whether a key is set (masked hint),
 *  lets the user replace it, and treats the value as a password — the raw key is never read back. */
function SecretRow({
  field,
  secretName,
  disabled,
}: {
  field: SecretFieldDescriptor;
  secretName: string;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // (Re)load the masked status whenever the target secret changes (e.g. the provider changed).
  useEffect(() => {
    let live = true;
    setStatus(null);
    setEditing(false);
    setValue("");
    setError(null);
    setConfirmingRemove(false);
    fetchSecretStatus(secretName)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ configured: false }));
    return () => {
      live = false;
    };
  }, [secretName]);

  const save = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const next = await saveSecret(secretName, value);
      setStatus(next);
      setEditing(false);
      setValue("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setEditing(false);
    setValue("");
    setError(null);
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await deleteSecret(secretName);
      setStatus(next);
      setConfirmingRemove(false);
      setValue("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const showInput = !status?.configured || editing;

  return (
    <div className={`setting-row${disabled ? " setting-row-disabled" : ""}`}>
      <div className="setting-label">
        <span className="setting-name">
          {field.label} <Lock size={12} strokeWidth={2} aria-hidden className="setting-name-icon" />
        </span>
        {field.description && <span className="setting-desc">{field.description}</span>}
      </div>
      <div className="setting-control">
        {status == null ? (
          <span className="secret-set">
            <Loader2 size={13} className="spin" aria-hidden /> Checking…
          </span>
        ) : showInput ? (
          <div className="secret-line">
            <input
              type="password"
              className="setting-input secret-input"
              autoComplete="new-password"
              placeholder={status.configured ? "New API key" : "Paste API key"}
              value={value}
              disabled={disabled || saving}
              autoFocus={editing}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape" && status.configured) cancel();
              }}
            />
            <button
              type="button"
              className="secret-icon-btn"
              title="Save key"
              aria-label="Save key"
              disabled={disabled || saving || !value.trim()}
              onClick={() => void save()}
            >
              {saving ? <Loader2 size={15} className="spin" aria-hidden /> : <Check size={15} aria-hidden />}
            </button>
            {status.configured && (
              <button
                type="button"
                className="secret-icon-btn"
                title="Cancel"
                aria-label="Cancel"
                disabled={saving}
                onClick={cancel}
              >
                <X size={15} aria-hidden />
              </button>
            )}
          </div>
        ) : confirmingRemove ? (
          <div className="secret-line">
            <span className="secret-confirm">Remove key?</span>
            <button
              type="button"
              className="secret-icon-btn danger"
              title="Confirm remove"
              aria-label="Confirm remove"
              disabled={saving}
              onClick={() => void remove()}
            >
              {saving ? <Loader2 size={15} className="spin" aria-hidden /> : <Check size={15} aria-hidden />}
            </button>
            <button
              type="button"
              className="secret-icon-btn"
              title="Cancel"
              aria-label="Cancel"
              disabled={saving}
              onClick={() => setConfirmingRemove(false)}
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        ) : (
          <div className="secret-line">
            <code className="secret-mask">****{status.hint}</code>
            <button
              type="button"
              className="secret-icon-btn"
              title="Replace key"
              aria-label="Replace key"
              disabled={disabled}
              onClick={() => setEditing(true)}
            >
              <Pencil size={15} aria-hidden />
            </button>
            <button
              type="button"
              className="secret-icon-btn"
              title="Remove key"
              aria-label="Remove key"
              disabled={disabled}
              onClick={() => setConfirmingRemove(true)}
            >
              <Trash2 size={15} aria-hidden />
            </button>
          </div>
        )}
        {error && <span className="setting-status error">{error}</span>}
      </div>
    </div>
  );
}

/** One setting: name + description on the left, its control on the right (#154). The value is owned by
 *  the pane (so conditions can see it); edits are pushed onto the shared save queue via `enqueue`.
 *  Text-like controls save on blur; toggles/selects save immediately. `disabled` greys the control out
 *  (e.g. the LLM fields until task extraction is on). When an env var overrides the value, the row says so. */
function SettingRow({
  descriptor,
  value,
  disabled,
  placeholderOverride,
  savePath,
  onChange,
  enqueue,
}: {
  descriptor: SettingDescriptor;
  value: unknown;
  disabled: boolean;
  placeholderOverride?: string;
  /** Where edits are written. Defaults to the setting's flat path; a provider-scoped field passes
   *  `llm.providerConfigs.<provider>.<field>` (the row is keyed by it, so it remounts per provider). */
  savePath?: string;
  onChange: (v: unknown) => void;
  enqueue: SaveQueue["enqueue"];
}) {
  const { ui, effectiveValue, override } = descriptor;
  const path = savePath ?? descriptor.path;
  // The last value queued for save, so a blur with no real change doesn't re-queue. Seeded from the
  // current value (the row remounts when its save path changes, so this stays correct per provider).
  const savedRef = useRef(value != null ? String(value) : "");

  const text = value == null ? "" : String(value);
  const checked = Boolean(value);
  // Placeholder precedence: a cross-field placeholder (e.g. the provider's default model), then a
  // server-computed one (e.g. the auto-resolved claude binary path), then the effective value, then
  // "Default".
  const placeholder =
    placeholderOverride ?? descriptor.placeholder ?? (effectiveValue != null ? String(effectiveValue) : "Default");

  const saveText = () => {
    if (text === savedRef.current) return;
    savedRef.current = text;
    enqueue(path, text);
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
              onChange(next); // update the pane so conditions react
              enqueue(path, next);
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
              enqueue(path, e.target.value);
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

  // A textarea is too wide for the right-hand control column, so its row stacks: label + description
  // on top, the full-width control beneath.
  const stacked = ui.control === "textarea";

  return (
    <div
      className={`setting-row${stacked ? " setting-row-stacked" : ""}${disabled ? " setting-row-disabled" : ""}`}
    >
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
      <div className="setting-control">{control}</div>
    </div>
  );
}
