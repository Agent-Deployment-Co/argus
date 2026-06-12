import type { Dashboard } from "./types.ts";

export interface RenderOptions {
  /** Chart.js source to inline. If omitted, falls back to a CDN script tag. */
  chartJs?: string;
  /** Brand @font-face CSS to inline. Omit when the host provides Aleo and Poppins. */
  fontCss?: string;
  /** When present, render a user selector in the header (Worker/team mode). */
  users?: string[];
  /** Currently-selected user ("all" or a user id). */
  selectedUser?: string;
  /** Subtitle shown next to the title (e.g. "team" or a user id). */
  scopeLabel?: string;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render the dashboard to a single self-contained HTML document. */
export function renderHtml(d: Dashboard, opts: RenderOptions = {}): string {
  const generated = new Date(d.generatedAtMs).toISOString().replace("T", " ").slice(0, 16);
  const data = JSON.stringify(d).replace(/</g, "\\u003c");
  const chartTag = opts.chartJs
    ? `<script>${opts.chartJs}</script>`
    : `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>`;

  const userSelector =
    opts.users && opts.users.length
      ? `<label class="usersel">view:
           <select onchange="location.search='?user='+encodeURIComponent(this.value)">
             <option value="all"${opts.selectedUser === "all" || !opts.selectedUser ? " selected" : ""}>all users</option>
             ${opts.users
               .map((u) => `<option value="${esc(u)}"${opts.selectedUser === u ? " selected" : ""}>${esc(u)}</option>`)
               .join("")}
           </select></label>`
      : "";
  const scope = opts.scopeLabel ? ` · ${esc(opts.scopeLabel)}` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Argus — Claude Code, Codex, and Gemini CLI usage</title>
<script>
  (() => {
    let theme;
    try { theme = localStorage.getItem("argus-theme"); } catch {}
    if (theme !== "light" && theme !== "dark") {
      theme = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    document.documentElement.dataset.theme = theme;
  })();
</script>
${chartTag}
<style>
${opts.fontCss || ""}
  :root {
    color-scheme:light dark;
    --coffee-bean:#1c1105; --dark-coffee:#341f09; --tiger-orange:#ef8920;
    --racing-red:#e2302c; --cornflower-ocean:#286992; --sky-surge:#5dbcdf;
    --soft-apricot:#f3d7ba; --antique-white:#f9ebdc; --porcelain:#fefaf5;
    /* Semantic roles — dark (Coffee Bean world) is the default. */
    --bg:var(--coffee-bean); --surface:var(--dark-coffee);
    --text:var(--antique-white); --heading:var(--porcelain); --muted:var(--soft-apricot);
    --line:rgba(243,215,186,.18); --hover:rgba(249,235,220,.055);
    --accent:var(--tiger-orange);
    --link:var(--sky-surge); --link-hover:var(--tiger-orange);
    --pill-cool:var(--sky-surge); --pill-cool-line:var(--cornflower-ocean);
    --code-bg:rgba(249,235,220,.07); --code-text:var(--porcelain);
    --sel-bg:var(--tiger-orange); --sel-text:var(--coffee-bean);
    --hm0:rgba(243,215,186,.08); --hm1:rgba(239,137,32,.32); --hm2:rgba(239,137,32,.54); --hm3:rgba(239,137,32,.77); --hm4:var(--tiger-orange);
  }
  :root[data-theme="dark"] { color-scheme:dark; }
  :root[data-theme="light"] {
    color-scheme:light;
    /* Light (Antique White world): paper surfaces, coffee ink; cool accents shift Sky→Ocean. */
    --bg:var(--antique-white); --surface:var(--porcelain);
    --text:var(--dark-coffee); --heading:var(--coffee-bean);
    --muted:color-mix(in srgb, var(--dark-coffee) 68%, var(--antique-white));
    --line:rgba(52,31,9,.16); --hover:rgba(52,31,9,.045);
    --link:var(--cornflower-ocean); --link-hover:var(--tiger-orange);
    --pill-cool:var(--cornflower-ocean); --pill-cool-line:var(--cornflower-ocean);
    --code-bg:rgba(52,31,9,.06); --code-text:var(--coffee-bean);
    --sel-bg:var(--tiger-orange); --sel-text:var(--porcelain);
    --hm0:rgba(52,31,9,.06); --hm1:rgba(239,137,32,.34); --hm2:rgba(239,137,32,.56); --hm3:rgba(239,137,32,.78); --hm4:var(--tiger-orange);
  }
  @media (prefers-color-scheme:light) {
    :root:not([data-theme]) {
      --bg:var(--antique-white); --surface:var(--porcelain);
      --text:var(--dark-coffee); --heading:var(--coffee-bean);
      --muted:color-mix(in srgb, var(--dark-coffee) 68%, var(--antique-white));
      --line:rgba(52,31,9,.16); --hover:rgba(52,31,9,.045);
      --link:var(--cornflower-ocean); --link-hover:var(--tiger-orange);
      --pill-cool:var(--cornflower-ocean); --pill-cool-line:var(--cornflower-ocean);
      --code-bg:rgba(52,31,9,.06); --code-text:var(--coffee-bean);
      --sel-bg:var(--tiger-orange); --sel-text:var(--porcelain);
      --hm0:rgba(52,31,9,.06); --hm1:rgba(239,137,32,.34); --hm2:rgba(239,137,32,.56); --hm3:rgba(239,137,32,.78); --hm4:var(--tiger-orange);
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 "Aleo",Georgia,serif; -webkit-font-smoothing:antialiased; }
  header { border-bottom:1px solid var(--line); }
  .header-inner { max-width:1200px; margin:0 auto; padding:24px 32px; display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  .brand { display:flex; align-items:center; gap:11px; }
  .brand-mark { display:block; width:34px; height:auto; flex:0 0 auto; }
  header h1 { margin:0; color:var(--heading); font-family:"Poppins","Avenir Next",Arial,sans-serif; font-size:21px; font-weight:700; letter-spacing:.01em; }
  header .sub { color:var(--muted); font-size:13px; }
  .header-controls { display:flex; align-items:center; gap:12px; margin-left:auto; }
  .theme-switcher { display:inline-flex; align-items:center; padding:2px; background:var(--surface); border:1px solid var(--line); border-radius:8px; }
  .theme-choice { border:0; border-radius:6px; padding:4px 9px; background:transparent; color:var(--muted); font:600 11px "Poppins","Avenir Next",Arial,sans-serif; text-transform:uppercase; letter-spacing:.05em; cursor:pointer; }
  .theme-choice:hover { color:var(--heading); }
  .theme-choice[aria-pressed="true"] { background:var(--accent); color:var(--coffee-bean); }
  .theme-choice:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  nav.tabs { border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; background:var(--bg); }
  .tabs-inner { max-width:1200px; margin:0 auto; padding:0 32px; display:flex; gap:2px; }
  .tab { border:0; background:transparent; color:var(--muted); font:600 12px "Poppins","Avenir Next",Arial,sans-serif; text-transform:uppercase; letter-spacing:.1em; padding:14px 16px; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tab:hover { color:var(--heading); }
  .tab[aria-selected="true"] { color:var(--accent); border-bottom-color:var(--accent); }
  .tab:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
  .screen[hidden] { display:none; }
  .heatmap-wrap { overflow-x:auto; padding-bottom:4px; }
  svg.heatmap { display:block; }
  svg.heatmap text { fill:var(--muted); font:10px "Poppins","Avenir Next",Arial,sans-serif; }
  svg.heatmap rect.cell { stroke:var(--line); stroke-width:.5; }
  .hm-l0 { fill:var(--hm0); } .hm-l1 { fill:var(--hm1); } .hm-l2 { fill:var(--hm2); } .hm-l3 { fill:var(--hm3); } .hm-l4 { fill:var(--hm4); }
  .hm-legend { display:flex; align-items:center; gap:6px; justify-content:flex-end; margin-top:8px; color:var(--muted); font:11px "Poppins","Avenir Next",Arial,sans-serif; }
  .hm-legend .swatch { width:12px; height:12px; border-radius:2px; border:.5px solid var(--line); display:inline-block; }
  main { padding:30px 32px 64px; max-width:1200px; margin:0 auto; }
  section { margin:0 0 42px; }
  section h2 { font-family:"Poppins","Avenir Next",Arial,sans-serif; font-size:12px; text-transform:uppercase; letter-spacing:.14em; color:var(--accent); margin:0 0 14px; font-weight:600; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; }
  .card { background:var(--surface); border:1px solid var(--line); border-top:3px solid var(--accent); border-radius:12px; padding:15px 16px 16px; }
  .card .label { color:var(--muted); font-family:"Poppins","Avenir Next",Arial,sans-serif; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; }
  .card .value { color:var(--heading); font-size:25px; font-weight:700; margin-top:4px; font-variant-numeric:tabular-nums; }
  .card .value small { font-size:13px; color:var(--muted); font-weight:400; }
  .usersel { color:var(--muted); font-family:"Poppins","Avenir Next",Arial,sans-serif; font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .usersel select { background:var(--surface); color:var(--text); border:1px solid var(--cornflower-ocean); border-radius:7px; padding:5px 9px; font:13px "Aleo",Georgia,serif; text-transform:none; letter-spacing:normal; }
  .usersel select:focus-visible { outline:2px solid var(--tiger-orange); outline-offset:2px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
  @media (max-width:880px){ .grid2{grid-template-columns:1fr;} }
  .panel { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:18px; }
  .panel h3 { margin:0 0 12px; color:var(--heading); font-size:15px; font-weight:700; }
  canvas { max-width:100%; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-family:"Poppins","Avenir Next",Arial,sans-serif; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; cursor:pointer; user-select:none; white-space:nowrap; }
  th:hover { color:var(--accent); }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .nowrap { white-space:nowrap; }
  .session-project { width:clamp(160px,24vw,260px); max-width:clamp(160px,24vw,260px); }
  .truncate { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  tr:hover td { background:var(--hover); }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; font:11px "Poppins","Avenir Next",Arial,sans-serif; border:1px solid var(--line); color:var(--muted); margin:1px 3px 1px 0; }
  .pill.on { color:var(--pill-cool); border-color:var(--pill-cool-line); }
  .pill.warn { color:var(--tiger-orange); border-color:var(--racing-red); }
  .pill.skill { max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:middle; color:var(--pill-cool); border-color:var(--pill-cool-line); }
  .muted { color:var(--muted); }
  .prompt { color:var(--muted); font-size:12px; }
  .summary { font-size:12.5px; }
  .scroll { overflow:auto; background:var(--surface); border:1px solid var(--line); border-radius:12px; }
  .note { color:var(--muted); font-size:12px; margin-top:8px; }
  a { color:var(--link); text-underline-offset:2px; }
  a:hover { color:var(--link-hover); }
  code { background:var(--code-bg); color:var(--code-text); padding:1px 5px; border-radius:4px; font-size:12px; }
  ::selection { background:var(--sel-bg); color:var(--sel-text); }
  @media (max-width:600px) {
    .header-inner,main { padding-left:18px; padding-right:18px; }
    .header-inner { align-items:flex-start; }
    .header-controls { width:100%; margin-left:45px; justify-content:space-between; }
  }
</style>
</head>
<body>
<header>
  <div class="header-inner">
    <div class="brand">
      <svg class="brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="6 0 128 100" role="img" aria-label="The Agent Deployment Co. chevron">
        <path d="M6 0 L30 0 L62 50 L30 100 L6 100 L38 50 Z" fill="#e2302c"/>
        <path d="M30 0 L54 0 L86 50 L54 100 L30 100 L62 50 Z" fill="#ef8920"/>
        <path d="M54 0 L78 0 L110 50 L78 100 L54 100 L86 50 Z" fill="#5dbcdf"/>
        <path d="M78 0 L102 0 L134 50 L102 100 L78 100 L110 50 Z" fill="#286992"/>
      </svg>
      <h1>Argus</h1>
    </div>
    <span class="sub">Claude Code, Codex, and Gemini CLI usage${scope} · ${esc(d.range.start)} → ${esc(d.range.end)} · generated ${esc(generated)}</span>
    <div class="header-controls">
      ${userSelector}
      <div class="theme-switcher" role="group" aria-label="Color theme">
        <button class="theme-choice" type="button" data-theme-choice="light" aria-pressed="false">Light</button>
        <button class="theme-choice" type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>
      </div>
    </div>
  </div>
</header>
<nav class="tabs" role="tablist" aria-label="Dashboard sections">
  <div class="tabs-inner">
    <button class="tab" type="button" role="tab" data-tab="activity" aria-selected="true">Activity</button>
    <button class="tab" type="button" role="tab" data-tab="projects" aria-selected="false">Projects</button>
    <button class="tab" type="button" role="tab" data-tab="tools" aria-selected="false">Tools</button>
  </div>
</nav>
<main>
  <div class="screen" data-screen="activity">
    <section>
      <div class="cards" id="cards"></div>
      ${d.unpriced.length ? `<p class="note">Unpriced models (cost excluded): ${d.unpriced.map(esc).join(", ")}.</p>` : ""}
    </section>

    <section>
      <h2>Activity over time</h2>
      <div class="panel">
        <h3>Tokens per day</h3>
        <div class="heatmap-wrap" id="tokensHeatmap"></div>
        <div class="hm-legend">Less <span class="swatch hm-l0"></span><span class="swatch hm-l1"></span><span class="swatch hm-l2"></span><span class="swatch hm-l3"></span><span class="swatch hm-l4"></span> More</div>
      </div>
      <div class="panel" style="margin-top:24px">
        <h3>Est. cost per day (USD)</h3>
        <div class="heatmap-wrap" id="costHeatmap"></div>
        <div class="hm-legend">Less <span class="swatch hm-l0"></span><span class="swatch hm-l1"></span><span class="swatch hm-l2"></span><span class="swatch hm-l3"></span><span class="swatch hm-l4"></span> More</div>
      </div>
    </section>

    <section>
      <h2>Trends</h2>
      <div class="grid2">
        <div class="panel"><h3>Tokens per day</h3><canvas id="tokensChart" height="220"></canvas></div>
        <div class="panel"><h3>Cost per day (USD)</h3><canvas id="costChart" height="220"></canvas></div>
      </div>
    </section>

    <section>
      <h2>Sources</h2>
      <div class="grid2">
        <div class="panel"><h3>Tokens by source</h3><canvas id="sourceChart" height="220"></canvas></div>
        <div class="panel"><h3>Est. cost by source</h3><canvas id="sourceCostChart" height="220"></canvas></div>
      </div>
      <div class="scroll" style="margin-top:24px"><table id="sourceTable"></table></div>
    </section>

    ${
      d.byUser && d.byUser.length
        ? `<section>
      <h2>By user</h2>
      <div class="grid2">
        <div class="panel"><h3>Tokens by user</h3><canvas id="userChart" height="240"></canvas></div>
        <div class="panel"><h3>Est. cost by user</h3><canvas id="userCostChart" height="240"></canvas></div>
      </div>
      <div class="scroll" style="margin-top:24px"><table id="userTable"></table></div>
    </section>`
        : ""
    }

    <section>
      <h2>Models</h2>
      <div class="grid2">
        <div class="panel"><h3>Tokens by model</h3><canvas id="modelChart" height="260"></canvas></div>
      </div>
    </section>
  </div>

  <div class="screen" data-screen="projects" hidden>
    <section>
      <h2>Projects</h2>
      <div class="grid2">
        <div class="panel"><h3>Tokens by project</h3><canvas id="projectChart" height="260"></canvas></div>
        <div class="panel"><h3>Est. cost by project</h3><canvas id="projectCostChart" height="260"></canvas></div>
      </div>
      <div class="scroll" style="margin-top:24px"><table id="projectTable"></table></div>
    </section>

    <section>
      <h2>Sessions (${d.sessions.length})</h2>
      <div class="scroll"><table id="sessionTable"></table></div>
    </section>
  </div>

  <div class="screen" data-screen="tools" hidden>
    <section>
      <h2>Skills</h2>
      <div class="grid2">
        <div class="panel"><h3>Top skills by tokens</h3><canvas id="skillChart" height="260"></canvas>
          <p class="note">Token attribution is exact — usage and the active skill are recorded on the same message.</p></div>
      </div>
    </section>

    <section>
      <h2>Tools</h2>
      <div class="grid2">
        <div class="panel"><h3>Tool calls by category</h3><canvas id="toolCatChart" height="240"></canvas></div>
        <div class="panel"><h3>Most-used tools (by calls)</h3><canvas id="toolRankChart" height="240"></canvas></div>
      </div>
      <div class="scroll" style="margin-top:24px"><table id="toolTable"></table></div>
      <p class="note">MCP tool names are displayed as <code>server · tool</code>.</p>
    </section>

    <section>
      <h2>MCP servers &amp; tool output weight</h2>
      <div class="grid2">
        <div class="panel"><h3>MCP server calls</h3><canvas id="mcpChart" height="240"></canvas></div>
        <div class="panel"><h3>Heaviest tool results (approx tokens dumped into context)</h3><canvas id="toolChart" height="240"></canvas>
          <p class="note">Approximate (≈chars/4). Shows which tools flood context — useful for trimming.</p></div>
      </div>
    </section>

    <section>
      <h2>Plugins</h2>
      <div class="scroll"><table id="pluginTable"></table></div>
      <p class="note">Rows marked <span class="pill warn">enabled · unused</span> are candidates to disable — every enabled plugin's skills/MCP tools add context overhead before you prompt.</p>
    </section>
  </div>
</main>

<script id="data" type="application/json">${data}</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
// Data-series hues are brand colors that read on either background; only the chart
// chrome (tick/label text, gridlines, tooltip surface) changes with the selected theme.
const CHART_THEMES = {
  dark: { grid:'rgba(243,215,186,.18)', muted:'#f3d7ba', panel:'#341f09', fg:'#fefaf5' },
  light:{ grid:'rgba(52,31,9,.13)', muted:'#6f5331', panel:'#fefaf5', fg:'#1c1105' },
};
const currentTheme = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
const initialChartTheme = CHART_THEMES[currentTheme()];
const C = {
  input:'#5dbcdf', output:'#ef8920', cacheRead:'#286992', cacheWrite:'#e2302c', accent:'#ef8920',
  grid:initialChartTheme.grid, muted:initialChartTheme.muted,
  panel:initialChartTheme.panel, fg:initialChartTheme.fg,
};
Chart.defaults.font.family = "Aleo, Georgia, serif";
Chart.defaults.plugins.tooltip.borderColor = '#286992';
Chart.defaults.plugins.tooltip.borderWidth = 1;

function applyChartTheme(theme) {
  const colors = CHART_THEMES[theme];
  Object.assign(C, colors);
  Chart.defaults.color = colors.muted;
  Chart.defaults.borderColor = colors.grid;
  Chart.defaults.plugins.tooltip.backgroundColor = colors.panel;
  Chart.defaults.plugins.tooltip.titleColor = colors.fg;
  Chart.defaults.plugins.tooltip.bodyColor = colors.fg;
  Object.values(Chart.instances || {}).forEach(chart => {
    chart.options.color = colors.muted;
    chart.options.borderColor = colors.grid;
    // Scale tick/grid and legend label colors are resolved per-instance at build time,
    // so updating Chart.defaults alone won't recolor them on a theme switch — set them here.
    Object.values(chart.options.scales || {}).forEach(scale => {
      if (!scale) return;
      scale.ticks = scale.ticks || {};
      scale.ticks.color = colors.muted;
      scale.grid = scale.grid || {};
      scale.grid.color = colors.grid;
    });
    const legend = chart.options.plugins && chart.options.plugins.legend;
    if (legend) {
      legend.labels = legend.labels || {};
      legend.labels.color = colors.muted;
    }
    const tooltip = chart.options.plugins && chart.options.plugins.tooltip;
    if (tooltip) {
      tooltip.backgroundColor = colors.panel;
      tooltip.titleColor = colors.fg;
      tooltip.bodyColor = colors.fg;
    }
    chart.update('none');
  });
}
function syncThemeButtons(theme) {
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
  });
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('argus-theme', theme); } catch {}
  syncThemeButtons(theme);
  applyChartTheme(theme);
}
document.querySelectorAll('[data-theme-choice]').forEach(button => {
  button.addEventListener('click', () => setTheme(button.dataset.themeChoice));
});
syncThemeButtons(currentTheme());
applyChartTheme(currentTheme());

const fmt = n => n>=1e9 ? (n/1e9).toFixed(2)+'B' : n>=1e6 ? (n/1e6).toFixed(2)+'M' : n>=1e3 ? (n/1e3).toFixed(1)+'k' : String(n);
const usd = n => '$'+(n<1 ? n.toFixed(3) : n.toFixed(2));
const dur = ms => { const m=Math.round(ms/60000); if(m<60) return m+'m'; const h=Math.floor(m/60); return h+'h'+(m%60)+'m'; };
const dt = ms => new Date(ms).toISOString().slice(0,16).replace('T',' ');
const BY_SOURCE = DATA.bySource || [];

// ---- stat cards ----
const u = DATA.totals.usage;
const cards = [
  ['Sessions', String(DATA.totals.sessions)],
  ['Messages', fmt(DATA.totals.messages)],
  ['Total tokens', fmt(DATA.totals.total)],
  ['Est. cost', usd(DATA.totals.cost)],
  ['Cache read', Math.round(100*u.cacheRead/Math.max(1,DATA.totals.total))+'% <small>'+fmt(u.cacheRead)+'</small>'],
  ['Output tokens', fmt(u.output)],
];
document.getElementById('cards').innerHTML = cards.map(([l,v]) =>
  '<div class="card"><div class="label">'+l+'</div><div class="value">'+v+'</div></div>').join('');

// ---- tokens per day (stacked) ----
const days = DATA.daily.map(d=>d.date);
new Chart(tokensChart, { type:'bar', data:{ labels:days, datasets:[
  {label:'cache read', data:DATA.daily.map(d=>d.cacheRead), backgroundColor:C.cacheRead, stack:'t'},
  {label:'cache write', data:DATA.daily.map(d=>d.cacheWrite), backgroundColor:C.cacheWrite, stack:'t'},
  {label:'input', data:DATA.daily.map(d=>d.input), backgroundColor:C.input, stack:'t'},
  {label:'output', data:DATA.daily.map(d=>d.output), backgroundColor:C.output, stack:'t'},
]}, options:{ responsive:true, plugins:{legend:{position:'bottom'}}, scales:{ x:{stacked:true,ticks:{maxRotation:90,minRotation:45}}, y:{stacked:true, ticks:{callback:fmt}} } }});

// ---- cost per day ----
new Chart(costChart, { type:'line', data:{ labels:days, datasets:[
  {label:'USD', data:DATA.daily.map(d=>d.cost), borderColor:C.accent, backgroundColor:'rgba(239,137,32,.16)', fill:true, tension:.25, pointRadius:2}
]}, options:{ responsive:true, plugins:{legend:{display:false}}, scales:{ x:{ticks:{maxRotation:90,minRotation:45}}, y:{ticks:{callback:v=>'$'+v}} } }});

// ---- source breakdown ----
new Chart(sourceChart, { type:'doughnut', data:{ labels:BY_SOURCE.map(s=>s.name), datasets:[
  {data:BY_SOURCE.map(s=>s.total), backgroundColor:[C.input,C.output,C.cacheRead,C.cacheWrite]}
]}, options:{ plugins:{legend:{position:'right'}, tooltip:{callbacks:{label:c=>c.label+': '+fmt(c.parsed)+' tok · '+usd(BY_SOURCE[c.dataIndex].cost)}}} }});
new Chart(sourceCostChart, { type:'bar', data:{ labels:BY_SOURCE.map(s=>s.name), datasets:[
  {label:'USD', data:BY_SOURCE.map(s=>s.cost), backgroundColor:C.accent}
]}, options:{ indexAxis:'y', plugins:{legend:{display:false}}, scales:{x:{ticks:{callback:v=>'$'+v}}} }});

// ---- top skills ----
const sk = DATA.bySkill.filter(s=>s.name!=='(none)').slice(0,12);
new Chart(skillChart, { type:'bar', data:{ labels:sk.map(s=>s.name), datasets:[
  {label:'tokens', data:sk.map(s=>s.total), backgroundColor:C.cacheWrite}
]}, options:{ indexAxis:'y', plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmt(c.parsed.x)+' tok · '+usd(sk[c.dataIndex].cost)+' · '+sk[c.dataIndex].messages+' msgs'}}}, scales:{x:{ticks:{callback:fmt}}} }});

// ---- model doughnut ----
new Chart(modelChart, { type:'doughnut', data:{ labels:DATA.byModel.map(m=>m.name), datasets:[
  {data:DATA.byModel.map(m=>m.total), backgroundColor:[C.input,C.output,C.cacheRead,C.cacheWrite,C.muted]}
]}, options:{ plugins:{legend:{position:'right'}, tooltip:{callbacks:{label:c=>c.label+': '+fmt(c.parsed)+' tok'}}} }});

// ---- by user (team mode) ----
if (DATA.byUser && DATA.byUser.length) {
  const us = DATA.byUser;
  new Chart(userChart, { type:'bar', data:{ labels:us.map(x=>x.name), datasets:[
    {label:'tokens', data:us.map(x=>x.total), backgroundColor:C.input}
  ]}, options:{ indexAxis:'y', plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmt(c.parsed.x)+' tok · '+usd(us[c.dataIndex].cost)+' · '+(us[c.dataIndex].meta?.sessions||0)+' sessions'}}}, scales:{x:{ticks:{callback:fmt}}} }});
  new Chart(userCostChart, { type:'bar', data:{ labels:us.map(x=>x.name), datasets:[
    {label:'USD', data:us.map(x=>x.cost), backgroundColor:C.accent}
  ]}, options:{ indexAxis:'y', plugins:{legend:{display:false}}, scales:{x:{ticks:{callback:v=>'$'+v}}} }});
}

// ---- projects ----
const pj = DATA.byProject.slice(0,15);
new Chart(projectChart, { type:'bar', data:{ labels:pj.map(p=>p.name), datasets:[
  {label:'tokens', data:pj.map(p=>p.total), backgroundColor:C.cacheRead}
]}, options:{ indexAxis:'y', plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmt(c.parsed.x)+' tok · '+usd(pj[c.dataIndex].cost)+' · '+(pj[c.dataIndex].meta?.sessions||0)+' sessions'}}}, scales:{x:{ticks:{callback:fmt}}} }});
new Chart(projectCostChart, { type:'bar', data:{ labels:pj.map(p=>p.name), datasets:[
  {label:'USD', data:pj.map(p=>p.cost), backgroundColor:C.accent}
]}, options:{ indexAxis:'y', plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>usd(c.parsed.x)+' · '+fmt(pj[c.dataIndex].total)+' tok'}}}, scales:{x:{ticks:{callback:v=>'$'+v}}} }});

// ---- mcp servers ----
const mcp = DATA.byMcpServer.slice(0,12);
new Chart(mcpChart, { type:'bar', data:{ labels:mcp.map(m=>m.server), datasets:[
  {label:'calls', data:mcp.map(m=>m.calls), backgroundColor:C.input}
]}, options:{ indexAxis:'y', plugins:{legend:{display:false}, tooltip:{callbacks:{afterLabel:c=>{const t=mcp[c.dataIndex].topTools.slice(0,4); return t.map(x=>x.tool+' ('+x.count+')').join('\\n');}}}} }});

// ---- heaviest tool results ----
const ht = DATA.heaviestToolResults.slice(0,12);
new Chart(toolChart, { type:'bar', data:{ labels:ht.map(t=>t.tool), datasets:[
  {label:'approx tokens', data:ht.map(t=>t.approxTokens), backgroundColor:C.output}
]}, options:{ indexAxis:'y', plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmt(c.parsed.x)+' tok · '+ht[c.dataIndex].count+' results'}}}, scales:{x:{ticks:{callback:fmt}}} }});

// ---- tool calls by category ----
const tc = DATA.byToolCategory || [];
const CATPAL = ['#ef8920','#5dbcdf','#e2302c','#286992','#f3d7ba','#f9ebdc','#fefaf5','#ef8920','#5dbcdf'];
new Chart(toolCatChart, { type:'doughnut', data:{ labels:tc.map(c=>c.label), datasets:[
  {data:tc.map(c=>c.calls), backgroundColor:CATPAL}
]}, options:{ plugins:{legend:{position:'right'}, tooltip:{callbacks:{label:c=>c.label+': '+fmt(c.parsed)+' calls · '+tc[c.dataIndex].tools+' tools'}}} }});

// ---- most-used tools (by calls) ----
const tr = (DATA.byTool||[]).slice(0,15);
new Chart(toolRankChart, { type:'bar', data:{ labels:tr.map(t=>t.display), datasets:[
  {label:'calls', data:tr.map(t=>t.calls), backgroundColor:C.input}
]}, options:{ indexAxis:'y', plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmt(c.parsed.x)+' calls · '+tr[c.dataIndex].sessions+' sessions · '+tr[c.dataIndex].category}}}, scales:{x:{ticks:{callback:fmt}}} }});

// ---- tools table ----
makeTable(document.getElementById('toolTable'),[
  {label:'Tool', sort:r=>r.display, cell:r=>esc(r.display)},
  {label:'Category', sort:r=>r.category, cell:r=>'<span class="pill">'+esc(r.category)+'</span>'},
  {label:'Calls', num:true, sort:r=>r.calls, cell:r=>fmt(r.calls)},
  {label:'Sessions', num:true, sort:r=>r.sessions, cell:r=>r.sessions},
  {label:'Result tokens', num:true, sort:r=>r.approxResultTokens, cell:r=>fmt(r.approxResultTokens)},
], DATA.byTool || []);

// ---- generic sortable table ----
function makeTable(el, cols, rows){
  let sortIdx=-1, sortDir=-1;
  const classes=c=>[c.num?'num':'',c.className||''].filter(Boolean).join(' ');
  function render(){
    const head='<thead><tr>'+cols.map((c,i)=>'<th class="'+classes(c)+'" data-i="'+i+'">'+c.label+(i===sortIdx?(sortDir<0?' ▾':' ▴'):'')+'</th>').join('')+'</tr></thead>';
    const sorted=rows.slice();
    if(sortIdx>=0){ const c=cols[sortIdx]; sorted.sort((a,b)=>{const va=c.sort(a),vb=c.sort(b); return (va<vb?-1:va>vb?1:0)*sortDir;}); }
    const body='<tbody>'+sorted.map(r=>'<tr>'+cols.map(c=>'<td class="'+classes(c)+'">'+c.cell(r)+'</td>').join('')+'</tr>').join('')+'</tbody>';
    el.innerHTML=head+body;
    el.querySelectorAll('th').forEach(th=>th.onclick=()=>{const i=+th.dataset.i; if(i===sortIdx)sortDir*=-1; else {sortIdx=i;sortDir=-1;} render();});
  }
  render();
}

// ---- by-user table (team mode) ----
if (DATA.byUser && DATA.byUser.length) {
  makeTable(document.getElementById('userTable'),[
    {label:'User', sort:r=>r.name, cell:r=>'<a href="?user='+encodeURIComponent(r.name)+'">'+esc(r.name)+'</a>'},
    {label:'Sessions', num:true, sort:r=>r.meta?.sessions||0, cell:r=>r.meta?.sessions||0},
    {label:'Msgs', num:true, sort:r=>r.messages, cell:r=>fmt(r.messages)},
    {label:'Tokens', num:true, sort:r=>r.total, cell:r=>fmt(r.total)},
    {label:'Cost', num:true, sort:r=>r.cost, cell:r=>usd(r.cost)},
  ], DATA.byUser);
}

// ---- projects table ----
makeTable(document.getElementById('projectTable'),[
  {label:'Project', sort:r=>r.name, cell:r=>esc(r.name)},
  {label:'Sessions', num:true, sort:r=>r.meta?.sessions||0, cell:r=>r.meta?.sessions||0},
  {label:'Msgs', num:true, sort:r=>r.messages, cell:r=>fmt(r.messages)},
  {label:'Tokens', num:true, sort:r=>r.total, cell:r=>fmt(r.total)},
  {label:'Cost', num:true, sort:r=>r.cost, cell:r=>usd(r.cost)},
], DATA.byProject);

// ---- source table ----
makeTable(document.getElementById('sourceTable'),[
  {label:'Source', sort:r=>r.name, cell:r=>esc(r.name)},
  {label:'Sessions', num:true, sort:r=>r.meta?.sessions||0, cell:r=>r.meta?.sessions||0},
  {label:'Msgs', num:true, sort:r=>r.messages, cell:r=>fmt(r.messages)},
  {label:'Tokens', num:true, sort:r=>r.total, cell:r=>fmt(r.total)},
  {label:'Cost', num:true, sort:r=>r.cost, cell:r=>usd(r.cost)},
], BY_SOURCE);

// ---- plugins table ----
makeTable(document.getElementById('pluginTable'),[
  {label:'Plugin', sort:r=>r.name, cell:r=>esc(r.name)+(r.marketplace?' <span class="muted">@'+esc(r.marketplace)+'</span>':'')},
  {label:'Status', sort:r=>(r.enabled?2:0)+(r.used?1:0), cell:r=> r.used?'<span class="pill on">used</span>': r.enabled?'<span class="pill warn">enabled · unused</span>':'<span class="pill">disabled</span>'},
  {label:'Skills used', sort:r=>r.skills.length, cell:r=>r.skills.map(skillPill).join('')||'<span class="muted">—</span>'},
  {label:'Msgs', num:true, sort:r=>r.skillMessages, cell:r=>fmt(r.skillMessages)},
  {label:'Tokens', num:true, sort:r=>r.skillTokens, cell:r=>fmt(r.skillTokens)},
  {label:'MCP calls', num:true, sort:r=>r.mcpCalls, cell:r=>r.mcpCalls||'<span class="muted">—</span>'},
  {label:'Cost', num:true, sort:r=>r.skillCost, cell:r=>r.skillCost?usd(r.skillCost):'<span class="muted">—</span>'},
], DATA.byPlugin);
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function skillPill(skill){return '<span class="pill skill" title="'+esc(skill)+'">'+esc(skill)+'</span>';}
function compactProject(project){
  const value=String(project||'');
  const match=value.match(/^(gemini\\/)([0-9a-f]{32,})$/i);
  return match ? match[1]+match[2].slice(0,8)+'…' : value;
}

// ---- sessions table ----
const sessionCols = [
  {label:'Started', className:'nowrap', sort:r=>r.start, cell:r=>dt(r.start)},
  {label:'Source', sort:r=>r.source||'', cell:r=>esc(r.source||'')},
  {label:'Project', className:'session-project', sort:r=>r.project, cell:r=>'<span class="truncate" title="'+esc(r.project)+'">'+esc(compactProject(r.project))+'</span>'},
  {label:'Dur', num:true, sort:r=>r.durationMs, cell:r=>dur(r.durationMs)},
  {label:'Msgs', num:true, sort:r=>r.messages, cell:r=>r.messages},
  {label:'Skills', sort:r=>r.topSkills.join(), cell:r=>r.topSkills.map(skillPill).join('')||'<span class="muted">—</span>'},
  {label:'Tokens', num:true, sort:r=>r.total, cell:r=>fmt(r.total)},
  {label:'Cost', num:true, sort:r=>r.cost, cell:r=>usd(r.cost)},
  {label:'Summary', sort:r=>r.summary, cell:r=>'<div class="summary">'+esc(r.summary)+'</div>'+(r.firstPrompt&&!r.summary.includes('"')?'<div class="prompt">'+esc(r.firstPrompt.slice(0,120))+'</div>':'')},
];
if (DATA.sessions.some(s=>s.user)) {
  sessionCols.splice(1, 0, {label:'User', sort:r=>r.user||'', cell:r=>esc(r.user||'')});
}
makeTable(document.getElementById('sessionTable'), sessionCols, DATA.sessions);

// ---- github-style activity heatmaps ----
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function renderHeatmap(el, key, fmtVal){
  if(!el) return;
  const daily = DATA.daily || [];
  if(!daily.length){ el.innerHTML = '<p class="muted">No activity in range.</p>'; return; }
  const map = new Map(daily.map(d=>[d.date, d[key]||0]));
  const parse = s=>{ const p=s.split('-').map(Number); return new Date(Date.UTC(p[0],p[1]-1,p[2])); };
  const start = parse(daily[0].date), end = parse(daily[daily.length-1].date);
  const gridStart = new Date(start); gridStart.setUTCDate(start.getUTCDate()-start.getUTCDay());
  // quartile thresholds over non-zero days, so a few heavy days don't wash out the rest
  const vals = daily.map(d=>d[key]||0).filter(v=>v>0).sort((a,b)=>a-b);
  const q = p => vals.length ? vals[Math.min(vals.length-1, Math.floor(p*vals.length))] : 0;
  const t1=q(.25), t2=q(.5), t3=q(.75);
  const level = v => v<=0?0 : v<=t1?1 : v<=t2?2 : v<=t3?3 : 4;
  const CELL=12, STRIDE=15, TOP=18, LEFT=30;
  const cells=[], months=[], cur=new Date(gridStart); let col=0, lastMonth=-1;
  while(cur<=end){
    for(let row=0; row<7; row++){
      const iso = cur.toISOString().slice(0,10);
      const inRange = cur>=start && cur<=end;
      const v = map.get(iso)||0;
      const x = LEFT+col*STRIDE, y = TOP+row*STRIDE;
      if(row===0){ const m=cur.getUTCMonth(); if(m!==lastMonth){ months.push('<text x="'+x+'" y="'+(TOP-6)+'">'+MONTHS[m]+'</text>'); lastMonth=m; } }
      if(inRange){
        cells.push('<rect class="cell hm-l'+level(v)+'" x="'+x+'" y="'+y+'" width="'+CELL+'" height="'+CELL+'" rx="2"><title>'+iso+' · '+fmtVal(v)+'</title></rect>');
      }
      cur.setUTCDate(cur.getUTCDate()+1);
    }
    col++;
  }
  const dows = [[1,'Mon'],[3,'Wed'],[5,'Fri']].map(([r,l])=>'<text x="0" y="'+(TOP+r*STRIDE+CELL-2)+'">'+l+'</text>').join('');
  const w = LEFT+col*STRIDE, h = TOP+7*STRIDE;
  el.innerHTML = '<svg class="heatmap" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'+months.join('')+dows+cells.join('')+'</svg>';
}
renderHeatmap(document.getElementById('tokensHeatmap'), 'total', v=>fmt(v)+' tokens');
renderHeatmap(document.getElementById('costHeatmap'), 'cost', v=>usd(v));

// ---- tab navigation ----
const TABS = ['activity','projects','tools'];
function showTab(name){
  if(!TABS.includes(name)) name = 'activity';
  document.querySelectorAll('.screen').forEach(s=>{ s.hidden = s.dataset.screen !== name; });
  document.querySelectorAll('.tab').forEach(t=>t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  // charts created while hidden have zero size; resize once their screen is visible
  Object.values(Chart.instances||{}).forEach(c=>{ try{ c.resize(); }catch{} });
  try{ history.replaceState(null,'','#'+name); }catch{}
}
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click', ()=>showTab(t.dataset.tab)));
showTab((location.hash||'').replace('#','') || 'activity');
</script>
</body>
</html>`;
}
