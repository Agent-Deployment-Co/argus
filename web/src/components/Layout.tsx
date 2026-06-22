import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Activity, Folder, HeartPulse, MessagesSquare, Moon, PanelLeftClose, PanelLeftOpen, Sun, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { SnapshotProvider, useSnapshotQuery } from "../lib/snapshot";
import { useTheme } from "../lib/theme";

const BrandMark = () => (
  <svg className="brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="6 0 128 100" role="img" aria-label="The Agent Deployment Co. chevron">
    <path d="M6 0 L30 0 L62 50 L30 100 L6 100 L38 50 Z" fill="#e2302c" />
    <path d="M30 0 L54 0 L86 50 L54 100 L30 100 L62 50 Z" fill="#ef8920" />
    <path d="M54 0 L78 0 L110 50 L78 100 L54 100 L86 50 Z" fill="#5dbcdf" />
    <path d="M78 0 L102 0 L134 50 L102 100 L78 100 L110 50 Z" fill="#286992" />
  </svg>
);

const RAIL_KEY = "argus-rail-collapsed";

function readCollapsed(): boolean {
  try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; }
}

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme();
  if (collapsed) {
    const next = theme === "dark" ? "light" : "dark";
    return (
      <button
        className="rail-icon-btn"
        type="button"
        onClick={() => setTheme(next)}
        title={`Switch to ${next} theme`}
        aria-label={`Switch to ${next} theme`}
      >
        {theme === "dark" ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />}
      </button>
    );
  }
  const choice = (value: "light" | "dark", Ico: LucideIcon, label: string) => (
    <button
      className="theme-choice"
      type="button"
      aria-pressed={theme === value}
      onClick={() => setTheme(value)}
      title={label}
      aria-label={label}
    >
      <Ico size={15} strokeWidth={1.75} aria-hidden />
    </button>
  );
  return (
    <div className="theme-switcher" role="group" aria-label="Color theme">
      {choice("light", Sun, "Light theme")}
      {choice("dark", Moon, "Dark theme")}
    </div>
  );
}

const NAV: { to: string; label: string; icon: LucideIcon; healthOnly?: boolean }[] = [
  { to: "/", label: "Activity", icon: Activity },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare },
  { to: "/projects", label: "Projects", icon: Folder },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/health", label: "Health", icon: HeartPulse, healthOnly: true },
];

export function Layout() {
  // /debug is diagnostics: it must render even when the snapshot fails to load, so it bypasses the
  // snapshot gate below (it fetches its own data and never calls useSnapshot). Skip the snapshot
  // fetch entirely there — otherwise a broken/slow /api/snapshot still fires in the background and
  // undermines the page as a diagnostic surface.
  const isDebug = useRouterState({ select: (s) => s.location.pathname === "/debug" });
  const query = useSnapshotQuery(!isDebug);
  const snap = query.data;
  const hasHealth = (snap?.dashboard.frictionTotals.observableSessions ?? 0) > 0;

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleRail = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(RAIL_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  return (
    <div className={`app-shell${collapsed ? " rail-collapsed" : ""}`}>
      <aside className="rail">
        <div className="rail-brand">
          <BrandMark />
          <span className="rail-wordmark">Argus</span>
        </div>
        <nav className="rail-nav" aria-label="Dashboard sections">
          {NAV.map((item) => {
            const disabled = item.healthOnly && !hasHealth;
            const Ico = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className="rail-link"
                activeOptions={{ exact: item.to === "/" }}
                activeProps={{ "aria-current": "page" }}
                aria-disabled={disabled || undefined}
                title={disabled ? "No Claude sessions — friction signals require native Claude transcripts" : item.label}
              >
                <Ico className="rail-icon" size={18} strokeWidth={1.75} aria-hidden />
                <span className="rail-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="rail-footer">
          <ThemeToggle collapsed={collapsed} />
          <button
            className="rail-icon-btn rail-toggle"
            type="button"
            onClick={toggleRail}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen size={18} strokeWidth={1.75} /> : <PanelLeftClose size={18} strokeWidth={1.75} />}
          </button>
        </div>
      </aside>
      <div className="content">
        <main>
          {isDebug ? (
            <Outlet />
          ) : query.isPending ? (
            <div className="center-state">Reading transcripts…</div>
          ) : query.isError ? (
            <div className="center-state">Couldn't load data: {(query.error as Error).message}</div>
          ) : (
            <SnapshotProvider value={snap!}>
              <Outlet />
            </SnapshotProvider>
          )}
        </main>
      </div>
    </div>
  );
}
