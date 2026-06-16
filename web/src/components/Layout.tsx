import { Link, Outlet } from "@tanstack/react-router";
import { dt } from "../lib/format";
import { SnapshotProvider, useSnapshotQuery } from "../lib/snapshot";
import { useTheme, type Theme } from "../lib/theme";

const BrandMark = () => (
  <svg className="brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="6 0 128 100" role="img" aria-label="The Agent Deployment Co. chevron">
    <path d="M6 0 L30 0 L62 50 L30 100 L6 100 L38 50 Z" fill="#e2302c" />
    <path d="M30 0 L54 0 L86 50 L54 100 L30 100 L62 50 Z" fill="#ef8920" />
    <path d="M54 0 L78 0 L110 50 L78 100 L54 100 L86 50 Z" fill="#5dbcdf" />
    <path d="M78 0 L102 0 L134 50 L102 100 L78 100 L110 50 Z" fill="#286992" />
  </svg>
);

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const choice = (value: Theme, label: string) => (
    <button
      className="theme-choice"
      type="button"
      aria-pressed={theme === value}
      onClick={() => setTheme(value)}
    >
      {label}
    </button>
  );
  return (
    <div className="theme-switcher" role="group" aria-label="Color theme">
      {choice("light", "Light")}
      {choice("dark", "Dark")}
    </div>
  );
}

const TABS: { to: string; label: string; healthOnly?: boolean }[] = [
  { to: "/", label: "Activity" },
  { to: "/projects", label: "Projects" },
  { to: "/tools", label: "Tools" },
  { to: "/health", label: "Health", healthOnly: true },
];

export function Layout() {
  const query = useSnapshotQuery();
  const snap = query.data;
  const hasHealth = (snap?.dashboard.frictionTotals.observableSessions ?? 0) > 0;

  const subtitle = snap
    ? `Claude Code, Codex, and Gemini CLI usage · ${snap.dashboard.range.start} → ${snap.dashboard.range.end} · generated ${dt(snap.generatedAtMs)}`
    : "Claude Code, Codex, and Gemini CLI usage";

  return (
    <>
      <header>
        <div className="header-inner">
          <div className="brand">
            <BrandMark />
            <h1>Argus</h1>
          </div>
          <span className="sub">{subtitle}</span>
          <div className="header-controls">
            <ThemeSwitcher />
          </div>
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="Dashboard sections">
        <div className="tabs-inner">
          {TABS.map((t) => {
            const disabled = t.healthOnly && !hasHealth;
            return (
              <Link
                key={t.to}
                to={t.to}
                className="tab"
                role="tab"
                activeOptions={{ exact: t.to === "/" }}
                activeProps={{ "aria-selected": "true" }}
                aria-disabled={disabled || undefined}
                title={disabled ? "No Claude sessions — friction signals require native Claude transcripts" : undefined}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
      <main>
        {query.isPending ? (
          <div className="center-state">Reading transcripts…</div>
        ) : query.isError ? (
          <div className="center-state">Couldn't load data: {(query.error as Error).message}</div>
        ) : (
          <SnapshotProvider value={snap!}>
            <Outlet />
          </SnapshotProvider>
        )}
      </main>
    </>
  );
}
