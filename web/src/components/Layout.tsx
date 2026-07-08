import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useIsFetching } from "@tanstack/react-query";
import { Activity, Folder, HeartPulse, MessagesSquare, PanelLeftClose, PanelLeftOpen, Settings, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { FilterBar } from "./FilterBar";
import { VIEW_QUERY_KEY } from "../lib/views";
import { SettingsSurface } from "../routes/Settings";
import { WelcomeModal } from "../routes/Welcome";

// The Argus arch mark — the ADC chevron un-bent into a rounded archway (a proto-"A"), four bands
// in the ADC accent colors. Shown alone when the rail is collapsed; otherwise it's the symbol at the
// head of the wordmark below. Colors are fixed (brand), so the mark reads the same in either theme.
export const ArchMark = () => (
  <svg className="brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Argus">
    <path d="M46 466 L46 256 A210 210 0 0 1 466 256 L466 466 L426 466 L426 256 A170 170 0 0 0 86 256 L86 466 Z" fill="#e2302c" />
    <path d="M92 466 L92 256 A164 164 0 0 1 420 256 L420 466 L380 466 L380 256 A124 124 0 0 0 132 256 L132 466 Z" fill="#ef8920" />
    <path d="M138 466 L138 256 A118 118 0 0 1 374 256 L374 466 L334 466 L334 256 A78 78 0 0 0 178 256 L178 466 Z" fill="#5dbcdf" />
    <path d="M184 466 L184 256 A72 72 0 0 1 328 256 L328 466 L288 466 L288 256 A32 32 0 0 0 224 256 L224 466 Z" fill="#286992" />
  </svg>
);

// The Argus wordmark — the arch plus "ARGUS" in Poppins SemiBold (text as vector outlines). Shown
// when the rail is expanded. The letterforms use currentColor so the lockup recolors per theme
// (Coffee Bean on light, Soft Apricot on dark) via .brand-wordmark in styles.css; the arch keeps its
// four brand colors on both. Geometry mirrors the canonical wordmark asset (kb Identity/logos).
export const Wordmark = () => (
  <svg className="brand-wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="-0.50 -18.44 98.60 19.11" role="img" aria-label="Argus">
    <g transform="translate(0 -17.734) scale(0.042224) translate(-46 -46)">
      <path d="M46 466 L46 256 A210 210 0 0 1 466 256 L466 466 L426 466 L426 256 A170 170 0 0 0 86 256 L86 466 Z" fill="#e2302c" />
      <path d="M92 466 L92 256 A164 164 0 0 1 420 256 L420 466 L380 466 L380 256 A124 124 0 0 0 132 256 L132 466 Z" fill="#ef8920" />
      <path d="M138 466 L138 256 A118 118 0 0 1 374 256 L374 466 L334 466 L334 256 A78 78 0 0 0 178 256 L178 466 Z" fill="#5dbcdf" />
      <path d="M184 466 L184 256 A72 72 0 0 1 328 256 L328 466 L288 466 L288 256 A32 32 0 0 0 224 256 L224 466 Z" fill="#286992" />
    </g>
    <g transform="translate(20.000 0.000) scale(0.025334 -0.025334)"><path d="M497 133L219 133L173 0L26 0L277 699L440 699L691 0L543 0L497 133ZM459 245L358 537L257 245L459 245Z" fill="currentColor" /></g>
    <g transform="translate(36.139 0.000) scale(0.025334 -0.025334)"><path d="M429 0L275 272L209 272L209 0L69 0L69 698L331 698Q412 698 469 669Q526 641 554 592Q583 544 583 484Q583 415 543 359Q503 304 424 283L591 0L429 0ZM209 377L326 377Q383 377 411 404Q439 432 439 481Q439 529 411 555Q383 582 326 582L209 582L209 377Z" fill="currentColor" /></g>
    <g transform="translate(50.378 0.000) scale(0.025334 -0.025334)"><path d="M555 488Q531 532 489 555Q447 578 391 578Q329 578 281 550Q233 522 206 470Q179 418 179 350Q179 280 206 228Q234 176 283 148Q332 120 397 120Q477 120 528 162Q579 205 595 281L355 281L355 388L733 388L733 266Q719 193 673 131Q627 69 554 31Q482 -6 392 -6Q291 -6 209 39Q128 85 81 166Q35 247 35 350Q35 453 81 534Q128 616 209 661Q291 707 391 707Q509 707 596 649Q683 592 716 488L555 488Z" fill="currentColor" /></g>
    <g transform="translate(67.835 0.000) scale(0.025334 -0.025334)"><path d="M207 698L207 266Q207 195 244 157Q281 120 348 120Q416 120 453 157Q490 195 490 266L490 698L631 698L631 267Q631 178 592 116Q554 55 489 24Q425 -7 346 -7Q268 -7 204 24Q141 55 104 116Q67 178 67 267L67 698L207 698Z" fill="currentColor" /></g>
    <g transform="translate(83.493 0.000) scale(0.025334 -0.025334)"><path d="M310 -7Q237 -7 178 18Q120 43 86 90Q52 137 51 201L201 201Q204 158 231 133Q259 108 307 108Q356 108 384 131Q412 155 412 193Q412 224 393 244Q374 264 345 275Q317 287 267 301Q199 321 156 340Q114 360 83 399Q53 439 53 505Q53 567 84 613Q115 659 171 683Q227 708 299 708Q407 708 474 655Q542 603 549 509L395 509Q393 545 364 568Q336 592 289 592Q248 592 223 571Q199 550 199 510Q199 482 217 463Q236 445 263 433Q291 422 341 407Q409 387 452 367Q495 347 526 307Q557 267 557 202Q557 146 528 98Q499 50 443 21Q387 -7 310 -7Z" fill="currentColor" /></g>
  </svg>
);

const RAIL_KEY = "argus-rail-collapsed";

function readCollapsed(): boolean {
  try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; }
}

// The Health tab is always shown; the Health route itself renders an empty state when no sessions
// carry friction data (native Claude transcripts), so it needs no cross-cutting pre-fetch here.
const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/", label: "Activity", icon: Activity },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare },
  { to: "/projects", label: "Projects", icon: Folder },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/health", label: "Health", icon: HeartPulse },
];

export function Layout() {
  // The settings surface (incl. the Debug tab) takes over the whole view and reads its own data, so
  // it bypasses the snapshot gate (and we skip the snapshot fetch while it's open).
  const isSettings = useRouterState({ select: (s) => s.location.pathname.startsWith("/settings") });
  // /sessions has its own search-first toolbar, not the shared date/source FilterBar — it still
  // gets the rail + app shell, just no FilterBar in .content.
  const isSessions = useRouterState({ select: (s) => s.location.pathname.startsWith("/sessions") });
  // Remember the last screen the user was actually on (not a settings sub-route) so "Back to app"
  // closes settings and returns there — including when they navigated between settings categories or
  // deep-linked straight into /settings. We keep the pathname + its validated search so "Back to app"
  // can navigate through the router (which re-applies the route's validateSearch — a raw history push
  // would skip it, landing on / with no default date range). Defaults to the dashboard root.
  const location = useRouterState({ select: (s) => s.location });
  const lastApp = useRef<{ pathname: string; search: Record<string, unknown> }>({ pathname: "/", search: {} });
  if (!isSettings) lastApp.current = { pathname: location.pathname, search: location.search as Record<string, unknown> };
  // The welcome modal is a one-shot overlay triggered by `?firstRun=1` on the dashboard route (not
  // a separate page) — it sits on top of the app shell rather than replacing it.
  const firstRun = Boolean((location.search as { firstRun?: boolean }).firstRun);
  // Each dashboard view fetches its own data now, so there's no single snapshot query to gate on;
  // any in-flight dashboard-view query drives the FilterBar's refreshing indicator. Scoped to the
  // view query prefix so unrelated fetches (session detail, list pagination, task-metrics, /debug)
  // don't spin it as if the date/source filter were reloading.
  const fetching = useIsFetching({ queryKey: [VIEW_QUERY_KEY] }) > 0;

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleRail = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(RAIL_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  // Full-screen take-over: the settings surface renders its own two-pane layout (its own nav + a
  // "Back to app" affordance), replacing the app shell entirely. Deep-linkable via /settings.
  if (isSettings) return <SettingsSurface backTo={lastApp.current} />;

  return (
    <div className={`app-shell${collapsed ? " rail-collapsed" : ""}`}>
      <aside className="rail">
        <div className="rail-brand">
          <ArchMark />
          <Wordmark />
        </div>
        <nav className="rail-nav" aria-label="Dashboard sections">
          {NAV.map((item) => {
            const Ico = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className="rail-link"
                activeOptions={{ exact: item.to === "/" }}
                activeProps={{ "aria-current": "page" }}
                title={item.label}
              >
                <Ico className="rail-icon" size={18} strokeWidth={1.75} aria-hidden />
                <span className="rail-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        {/* Bottom controls. DOM order is settings, expand — so the collapsed rail (stacked
            top-to-bottom) reads settings, expand; expanded, the toggle is pushed right. The color
            theme moved into Settings → General → Appearance. */}
        <div className="rail-footer">
          <Link
            to="/settings/$category"
            params={{ category: "general" }}
            className="rail-icon-btn"
            title="Settings"
            aria-label="Settings"
          >
            <Settings size={18} strokeWidth={1.75} />
          </Link>
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
        {!isSessions && <FilterBar refreshing={fetching} />}
        <main>
          <Outlet />
        </main>
      </div>
      {firstRun && <WelcomeModal />}
    </div>
  );
}
