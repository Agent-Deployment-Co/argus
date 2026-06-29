import { Link, useParams, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Brain,
  Check,
  Loader2,
  Lock,
  SlidersHorizontal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSecretStatus, saveSecret, saveSetting, useSettingsQuery } from "../lib/settings";
import { Select } from "../components/Select";
import type { SecretFieldDescriptor, SecretStatus, SettingDescriptor, SettingsCategory } from "../types";

/** Icon per category id. Categories themselves come from the server (registry-driven); this is the
 *  only purely-presentational mapping the surface adds. Unknown ids fall back to the sliders icon. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  general: SlidersHorizontal,
  interpretation: Brain,
};

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
  const active = categories.find((c) => c.id === activeId);
  const save = useSaveQueue();

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
          <SettingsCategoryPane key={active.id} category={active} enqueue={save.enqueue} />
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

function SettingsCategoryPane({
  category,
  enqueue,
}: {
  category: SettingsCategory;
  enqueue: SaveQueue["enqueue"];
}) {
  const sections = category.sections.filter(
    (s) => s.settings.length > 0 || (s.secretFields?.length ?? 0) > 0,
  );
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
  // A secret field targets the secret named for the currently-selected provider; it's shown only when
  // that provider takes a key, and inactive (like the other LLM fields) until its gate is on.
  const secretName = (f: SecretFieldDescriptor) => f.secretNames[condValue(f.providerPath)];
  const secretActive = (f: SecretFieldDescriptor) => !f.activeWhen || Boolean(values[f.activeWhen.path]);

  return (
    <div className="settings-content">
      <header className="settings-pane-head">
        <h2>{category.label}</h2>
      </header>
      {sections.length === 0 ? (
        <p className="settings-empty">No settings in this category yet.</p>
      ) : (
        sections.map((section, i) => {
          const visibleSettings = section.settings.filter(isVisible);
          const visibleSecrets = (section.secretFields ?? [])
            .map((f) => ({ field: f, name: secretName(f) }))
            .filter((x): x is { field: SecretFieldDescriptor; name: string } => Boolean(x.name));
          if (!visibleSettings.length && !visibleSecrets.length) return null;
          return (
            <section className="settings-section" key={section.label ?? i}>
              {section.label && <h3 className="settings-section-head">{section.label}</h3>}
              <div className="settings-rows">
                {visibleSettings.map((s) => (
                  <SettingRow
                    key={s.path}
                    descriptor={s}
                    value={values[s.path]}
                    disabled={!isActive(s)}
                    onChange={(v) => setValue(s.path, v)}
                    enqueue={enqueue}
                  />
                ))}
                {visibleSecrets.map(({ field, name }) => (
                  <SecretRow key={field.key} field={field} secretName={name} disabled={!secretActive(field)} />
                ))}
              </div>
            </section>
          );
        })
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

  // (Re)load the masked status whenever the target secret changes (e.g. the provider changed).
  useEffect(() => {
    let live = true;
    setStatus(null);
    setEditing(false);
    setValue("");
    setError(null);
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
          <>
            <input
              type="password"
              className="setting-input"
              autoComplete="new-password"
              placeholder={status.configured ? "New API key" : "Paste API key"}
              value={value}
              disabled={disabled || saving}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
            />
            <div className="secret-actions">
              <button type="button" className="secret-btn" disabled={disabled || saving || !value.trim()} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </button>
              {status.configured && (
                <button
                  type="button"
                  className="secret-btn ghost"
                  disabled={saving}
                  onClick={() => {
                    setEditing(false);
                    setValue("");
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <span className="secret-set">
              <code>****{status.hint}</code>
            </span>
            <div className="secret-actions">
              <button type="button" className="secret-btn" disabled={disabled} onClick={() => setEditing(true)}>
                Replace
              </button>
            </div>
          </>
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
  onChange,
  enqueue,
}: {
  descriptor: SettingDescriptor;
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
  enqueue: SaveQueue["enqueue"];
}) {
  const { ui, fileValue, effectiveValue, override } = descriptor;
  // The last value queued for save, so a blur with no real change doesn't re-queue.
  const savedRef = useRef(fileValue != null ? String(fileValue) : "");

  const text = value == null ? "" : String(value);
  const checked = Boolean(value);
  const placeholder = effectiveValue != null ? String(effectiveValue) : "Default";

  const saveText = () => {
    if (text === savedRef.current) return;
    savedRef.current = text;
    enqueue(descriptor.path, text);
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
              enqueue(descriptor.path, next);
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
              enqueue(descriptor.path, e.target.value);
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
      <div className="setting-control">{control}</div>
    </div>
  );
}
