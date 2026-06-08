import type { Dashboard } from "./types.ts";

export interface RenderOptions {
  /** Chart.js source to inline. If omitted, falls back to a CDN script tag. */
  chartJs?: string;
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
<title>Argus — Claude Code and Codex usage</title>
${chartTag}
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --panel2:#1e222b; --line:#2a2f3a;
    --fg:#e6e9ef; --muted:#8b93a3; --accent:#d97757; --accent2:#6ea8fe;
    --green:#5fb878; --purple:#b18cf2; --yellow:#e6c84f;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:24px 32px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; }
  header h1 { margin:0; font-size:20px; letter-spacing:.3px; }
  header .sub { color:var(--muted); font-size:13px; }
  main { padding:24px 32px; max-width:1200px; margin:0 auto; }
  section { margin:0 0 36px; }
  section h2 { font-size:15px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 14px; font-weight:600; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .card .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  .card .value { font-size:24px; font-weight:600; margin-top:4px; }
  .card .value small { font-size:13px; color:var(--muted); font-weight:400; }
  .usersel { margin-left:auto; color:var(--muted); font-size:13px; }
  .usersel select { background:var(--panel2); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:3px 8px; font-size:13px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
  @media (max-width:880px){ .grid2{grid-template-columns:1fr;} }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; }
  .panel h3 { margin:0 0 12px; font-size:14px; }
  canvas { max-width:100%; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; cursor:pointer; user-select:none; white-space:nowrap; }
  th:hover { color:var(--fg); }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  tr:hover td { background:var(--panel2); }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11px; border:1px solid var(--line); color:var(--muted); margin:1px 3px 1px 0; }
  .pill.on { color:var(--green); border-color:#2f4a38; }
  .pill.warn { color:var(--yellow); border-color:#4a4423; }
  .pill.skill { color:var(--accent2); border-color:#2a3a52; }
  .muted { color:var(--muted); }
  .prompt { color:var(--muted); font-size:12px; }
  .summary { font-size:12.5px; }
  .scroll { overflow:auto; border:1px solid var(--line); border-radius:10px; }
  .note { color:var(--muted); font-size:12px; margin-top:8px; }
  code { background:var(--panel2); padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>Argus</h1>
  <span class="sub">Claude Code and Codex usage${scope} · ${esc(d.range.start)} → ${esc(d.range.end)} · generated ${esc(generated)}</span>
  ${userSelector}
</header>
<main>
  <section>
    <div class="cards" id="cards"></div>
    ${d.unpriced.length ? `<p class="note">Unpriced models (cost excluded): ${d.unpriced.map(esc).join(", ")}.</p>` : ""}
  </section>

  <section>
    <h2>Over time</h2>
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
    <h2>Attribution</h2>
    <div class="grid2">
      <div class="panel"><h3>Top skills by tokens</h3><canvas id="skillChart" height="260"></canvas>
        <p class="note">Token attribution is exact — usage and the active skill are recorded on the same message.</p></div>
      <div class="panel"><h3>Tokens by model</h3><canvas id="modelChart" height="260"></canvas></div>
    </div>
  </section>

  <section>
    <h2>Tools</h2>
    <div class="grid2">
      <div class="panel"><h3>Tool calls by category</h3><canvas id="toolCatChart" height="240"></canvas></div>
      <div class="panel"><h3>Most-used tools (by calls)</h3><canvas id="toolRankChart" height="240"></canvas></div>
    </div>
    <div class="scroll" style="margin-top:24px"><table id="toolTable"></table></div>
    <p class="note">Tools are categorized and MCP names split (<code>server · tool</code>) the same way as
      <a href="https://github.com/Arindam200/cc-lens" style="color:var(--accent2)">cc-lens</a>.</p>
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
    <h2>Projects</h2>
    <div class="grid2">
      <div class="panel"><h3>Tokens by project</h3><canvas id="projectChart" height="260"></canvas></div>
      <div class="panel"><h3>Est. cost by project</h3><canvas id="projectCostChart" height="260"></canvas></div>
    </div>
    <div class="scroll" style="margin-top:24px"><table id="projectTable"></table></div>
  </section>

  <section>
    <h2>Plugins</h2>
    <div class="scroll"><table id="pluginTable"></table></div>
    <p class="note">Rows marked <span class="pill warn">enabled · unused</span> are candidates to disable — every enabled plugin's skills/MCP tools add context overhead before you prompt.</p>
  </section>

  <section>
    <h2>Sessions (${d.sessions.length})</h2>
    <div class="scroll"><table id="sessionTable"></table></div>
  </section>
</main>

<script id="data" type="application/json">${data}</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
const C = { input:'#6ea8fe', output:'#d97757', cacheRead:'#5fb878', cacheWrite:'#b18cf2', accent:'#d97757', grid:'#2a2f3a', muted:'#8b93a3' };
Chart.defaults.color = C.muted;
Chart.defaults.borderColor = C.grid;
Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif";

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
  ['Cache read', fmt(u.cacheRead)+' <small>'+Math.round(100*u.cacheRead/Math.max(1,DATA.totals.total))+'%</small>'],
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
  {label:'USD', data:DATA.daily.map(d=>d.cost), borderColor:C.accent, backgroundColor:'rgba(217,119,87,.15)', fill:true, tension:.25, pointRadius:2}
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
const CATPAL = ['#6ea8fe','#d97757','#5fb878','#b18cf2','#e6c84f','#5fb8b8','#e67ec8','#9aa6b8','#c98cf2'];
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
  function render(){
    const head='<thead><tr>'+cols.map((c,i)=>'<th class="'+(c.num?'num':'')+'" data-i="'+i+'">'+c.label+(i===sortIdx?(sortDir<0?' ▾':' ▴'):'')+'</th>').join('')+'</tr></thead>';
    const sorted=rows.slice();
    if(sortIdx>=0){ const c=cols[sortIdx]; sorted.sort((a,b)=>{const va=c.sort(a),vb=c.sort(b); return (va<vb?-1:va>vb?1:0)*sortDir;}); }
    const body='<tbody>'+sorted.map(r=>'<tr>'+cols.map(c=>'<td class="'+(c.num?'num':'')+'">'+c.cell(r)+'</td>').join('')+'</tr>').join('')+'</tbody>';
    el.innerHTML=head+body;
    el.querySelectorAll('th').forEach(th=>th.onclick=()=>{const i=+th.dataset.i; if(i===sortIdx)sortDir*=-1; else {sortIdx=i;sortDir=-1;} render();});
  }
  render();
}

// ---- by-user table (team mode) ----
if (DATA.byUser && DATA.byUser.length) {
  makeTable(document.getElementById('userTable'),[
    {label:'User', sort:r=>r.name, cell:r=>'<a href="?user='+encodeURIComponent(r.name)+'" style="color:var(--accent2)">'+esc(r.name)+'</a>'},
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
  {label:'Skills used', sort:r=>r.skills.length, cell:r=>r.skills.map(s=>'<span class="pill skill">'+esc(s)+'</span>').join('')||'<span class="muted">—</span>'},
  {label:'Msgs', num:true, sort:r=>r.skillMessages, cell:r=>fmt(r.skillMessages)},
  {label:'Tokens', num:true, sort:r=>r.skillTokens, cell:r=>fmt(r.skillTokens)},
  {label:'MCP calls', num:true, sort:r=>r.mcpCalls, cell:r=>r.mcpCalls||'<span class="muted">—</span>'},
  {label:'Cost', num:true, sort:r=>r.skillCost, cell:r=>r.skillCost?usd(r.skillCost):'<span class="muted">—</span>'},
], DATA.byPlugin);
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

// ---- sessions table ----
const sessionCols = [
  {label:'Started', sort:r=>r.start, cell:r=>dt(r.start)},
  {label:'Source', sort:r=>r.source||'', cell:r=>esc(r.source||'')},
  {label:'Project', sort:r=>r.project, cell:r=>esc(r.project)},
  {label:'Dur', num:true, sort:r=>r.durationMs, cell:r=>dur(r.durationMs)},
  {label:'Msgs', num:true, sort:r=>r.messages, cell:r=>r.messages},
  {label:'Skills', sort:r=>r.topSkills.join(), cell:r=>r.topSkills.map(s=>'<span class="pill skill">'+esc(s)+'</span>').join('')||'<span class="muted">—</span>'},
  {label:'Tokens', num:true, sort:r=>r.total, cell:r=>fmt(r.total)},
  {label:'Cost', num:true, sort:r=>r.cost, cell:r=>usd(r.cost)},
  {label:'Summary', sort:r=>r.summary, cell:r=>'<div class="summary">'+esc(r.summary)+'</div>'+(r.firstPrompt&&!r.summary.includes('"')?'<div class="prompt">'+esc(r.firstPrompt.slice(0,120))+'</div>':'')},
];
if (DATA.sessions.some(s=>s.user)) {
  sessionCols.splice(1, 0, {label:'User', sort:r=>r.user||'', cell:r=>esc(r.user||'')});
}
makeTable(document.getElementById('sessionTable'), sessionCols, DATA.sessions);
</script>
</body>
</html>`;
}
