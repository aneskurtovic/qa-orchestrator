// Generated views of a QA run: RUN/progress.md (for the terminal and
// `Get-Content -Wait`) and RUN/dashboard.html (open it in a browser; it reloads
// itself while the run is live). Both are rebuilt from the run files after every
// state.mjs write, so they never depend on the model remembering to update them.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, writeTextAtomic } from './common.mjs';
import { computeMetrics } from '../metrics.mjs';

export const FLOW = ['PREFLIGHT', 'UNDERSTANDING', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'MAINTAINING', 'EXECUTING', 'TRIAGING', 'FEEDBACK', 'REPORTING', 'AWAITING_HUMAN_REVIEW'];
const FINAL = ['AWAITING_HUMAN_REVIEW', 'STOPPED', 'BLOCKED_ENV', 'BLOCKED_NOT_INTEGRATED', 'AWAITING_ENGINEER'];

export const fmtMs = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const fmtTokens = (n) => (!n ? '0' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const count = (xs, key) => xs.reduce((acc, x) => ({ ...acc, [x[key]]: (acc[x[key]] ?? 0) + 1 }), {});
const pairs = (obj) => Object.entries(obj).map(([k, v]) => `${k} ${v}`).join(', ');
const fileCount = (items) => new Set((items ?? []).map((i) => i.file)).size;

// What each saved step output says, in a few facts. Deterministic: read from the JSON, not summarized by a model.
export function digests(runDir) {
  const at = (f) => readJson(path.join(runDir, f), null);
  const out = [];
  const intake = at('intake.json');
  if (intake) {
    const acs = intake.acceptanceCriteria ?? [];
    out.push({ step: 'intake', lines: [
      `${acs.length} acceptance criteria (${acs.filter((a) => a.testable).length} testable), change type ${intake.changeType}`,
      `${intake.ambiguities?.length ?? 0} blocking questions, ${intake.assumptions?.length ?? 0} assumptions, confidence ${intake.confidence}`,
    ] });
  }
  const si = at('suite-impact.json');
  if (si) {
    const cs = si.changeSet ?? {};
    out.push({ step: 'suite-impact', lines: [
      `files: update ${fileCount(cs.update)}, add ${fileCount(cs.add)}, delete ${fileCount(cs.delete)}`,
      `AC dispositions: ${pairs(count(si.acCoverage ?? [], 'disposition')) || 'none'}`,
    ] });
  }
  const ca = at('change-analyst.json');
  if (ca) {
    out.push({ step: 'change-analyst', lines: [
      `${ca.changedBehaviours?.length ?? 0} changed behaviours, ${ca.additionalScenarios?.length ?? 0} extra scenarios`,
      `risk ${ca.riskLevel}${ca.touchesCriticalArea ? ', touches a critical area' : ''}`,
    ] });
  }
  const files = existsSync(runDir) ? readdirSync(runDir) : [];
  for (const f of files.filter((x) => /^critic-\d+\.json$/.test(x)).sort()) {
    const c = at(f);
    if (c) out.push({ step: f.replace('.json', ''), lines: [`${c.verdict}, ${c.gaps?.length ?? 0} gaps${c.gaps?.length ? ` (${pairs(count(c.gaps, 'target'))})` : ''}`] });
  }
  const plan = at('plan.json');
  if (plan) {
    const cs = plan.changeSet ?? {};
    out.push({ step: 'plan', lines: [
      `files: update ${fileCount(cs.update)}, add ${fileCount(cs.add)} (${fileCount((cs.add ?? []).filter((a) => a.intoExisting))} into existing specs), delete ${fileCount(cs.delete)}; run set ${plan.runSet?.length ?? 0} entries`,
      `${plan.limitations?.length ?? 0} limitations, ${plan.knownDriftSkipped?.length ?? 0} known-drift specs skipped; hash ${String(plan.planHash).slice(7, 19)}`,
    ] });
  }
  const author = at('test-author.json');
  if (author) {
    const sc = author.selfCheck ?? {};
    out.push({ step: 'test-author', lines: [
      `${author.filesChanged?.length ?? 0} files (${pairs(count(author.filesChanged ?? [], 'action'))})`,
      `self-check: ${sc.passed ?? '?'} passed, ${sc.failed ?? '?'} failed`,
    ] });
  }
  const td = at('test-diff.json');
  if (td) out.push({ step: 'test-diff', lines: [td.flagged ? `${td.flagged} flagged → G3` : 'clean'] });
  for (const f of files.filter((x) => /^runner-\d+\.json$/.test(x)).sort()) {
    const r = at(f);
    if (r) out.push({ step: f.replace('.json', '').replace('runner', 'run'), lines: [`${r.status}: ${pairs(r.counts ?? {})}, ${Math.round((r.durationMs ?? 0) / 1000)}s`] });
  }
  const triage = at('triage.json');
  if (triage) out.push({ step: 'triage', lines: [pairs(count(triage.failures ?? [], 'classification')) || 'no failures'] });
  const fb = at('feedback.json');
  if (fb) out.push({ step: 'feedback', lines: [`recommended **${fb.recommendedVerdict}**, ${fb.defects?.length ?? 0} defects, ${fb.findings?.length ?? 0} findings`] });
  return out;
}

function stepper(phase) {
  const i = FLOW.indexOf(phase);
  return FLOW.map((p, j) => (i === -1 ? p : j < i ? `✓ ${p}` : j === i ? `▶ **${p}**` : p)).join(' → ')
    + (i === -1 ? ` · now **${phase}**` : '');
}

export function renderProgress(state, m, dig) {
  const t = m.time.total;
  const a = m.agents.totals;
  const sha = state.tested?.sha ? `${state.tested.branch} @ ${state.tested.sha.slice(0, 7)}` : 'not yet';
  const lines = [
    `# QA ${m.key ?? ''} ${m.title ? `· ${m.title}` : ''}`,
    '',
    `Run \`${m.runId}\` · phase **${m.phase}** · tested ${sha} · updated ${new Date().toISOString()}`,
    '',
    stepper(m.phase),
    '',
    `- **Time:** active ${fmtMs(t.activeMs)} (agents ${fmtMs(t.agentMs)}, orchestration ${fmtMs(t.workMs)}), waiting for a human ${fmtMs(t.humanWaitMs)}, interrupted ${fmtMs(t.interruptedMs)}`,
    `- **Agents:** ${a.dispatches} dispatches, ${fmtTokens(a.total)} tokens (${fmtTokens(a.output)} output)${Object.keys(m.agents.requestShapes).length ? `, ${pairs(m.agents.requestShapes)}` : ''}`,
    `- **Loop:** ${m.loop.criticRounds} critic rounds, ${m.loop.testLaunches} test launches${m.denials.length ? `, ${m.denials.length} guard denials` : ''}`,
    m.verdict ? `- **Recommended verdict:** ${m.verdict}${m.qaPr ? ` · QA PR #${m.qaPr.number}` : ''}` : null,
    '',
    '## What each step produced',
    '',
    ...dig.flatMap((d) => [`**${d.step}**`, ...d.lines.map((l) => `- ${l}`), '']),
    '## Time by phase',
    '',
    '| Phase | Active | Agents | Waiting | Interrupted |',
    '|---|---|---|---|---|',
    ...Object.entries(m.time.phases).map(([p, v]) => `| ${p} | ${fmtMs(v.activeMs)} | ${fmtMs(v.agentMs)} | ${fmtMs(v.humanWaitMs)} | ${fmtMs(v.interruptedMs)} |`),
    '',
    '## Steps',
    '',
    '| At (UTC) | Phase | Step | Took | Kind | Outcome |',
    '|---|---|---|---|---|---|',
    ...m.steps.slice(-40).map((s) => `| ${s.at.slice(5, 16).replace('T', ' ')} | ${s.phase} | ${s.step}${s.agent ? ` (${s.agent})` : ''} | ${fmtMs(s.ms)} | ${s.kind} | ${s.outcome ?? ''} |`),
    '',
  ];
  if (m.agents.events.length) {
    lines.push('## Agents', '', '| Agent | Dispatches | Time | Tokens | Output |', '|---|---|---|---|---|');
    for (const [name, v] of Object.entries(m.agents.byAgent)) lines.push(`| ${name} | ${v.dispatches} | ${fmtMs(v.durationMs)} | ${fmtTokens(v.total)} | ${fmtTokens(v.output)} |`);
    lines.push('');
  }
  if (m.gates.length) {
    lines.push('## Gates', '', ...m.gates.map((g) => `- ${g.at.slice(5, 16).replace('T', ' ')} **${g.id}**: ${g.decision}`), '');
  }
  lines.push(`Dashboard: \`${path.join('RUN', 'dashboard.html')}\` (open in a browser).`, '');
  return lines.filter((l) => l !== null).join('\n');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderDashboard(state, m, dig) {
  const live = !FINAL.includes(m.phase);
  const t = m.time.total;
  const a = m.agents.totals;
  const phaseRows = Object.entries(m.time.phases).filter(([, v]) => v.activeMs + v.humanWaitMs + v.interruptedMs > 0);
  const maxPhase = Math.max(1, ...phaseRows.map(([, v]) => v.activeMs));
  const maxAgent = Math.max(1, ...Object.values(m.agents.byAgent).map((v) => v.total));
  const idx = FLOW.indexOf(m.phase);
  const tiles = [
    ['Phase', m.phase],
    ['Active time', fmtMs(t.activeMs)],
    ['Waiting for a human', fmtMs(t.humanWaitMs)],
    ['Interrupted', fmtMs(t.interruptedMs)],
    ['Agent dispatches', String(a.dispatches)],
    ['Tokens (output)', `${fmtTokens(a.total)} (${fmtTokens(a.output)})`],
    ['Critic rounds', String(m.loop.criticRounds)],
    ['Test launches', String(m.loop.testLaunches)],
  ];
  const last = m.tests.last;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${live ? '<meta http-equiv="refresh" content="15">' : ''}
<title>QA ${esc(m.key)} run</title>
<style>
:root { --bg:#f7f7f5; --panel:#ffffff; --ink:#1c1c1a; --muted:#6b6b66; --line:#e3e3de; --accent:#2f6fdb; --ok:#2e8540; --warn:#b7791f; --bad:#c53030; --wait:#8a8a84; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --panel:#1e1e1c; --ink:#ecece8; --muted:#a3a39c; --line:#33332f; --accent:#6f9ef0; --ok:#5cb870; --warn:#e0a84a; --bad:#f07070; --wait:#77776f; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:1100px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:28px 0 10px; }
.sub { color:var(--muted); font-size:13px; }
.flow { display:flex; flex-wrap:wrap; gap:6px; margin:16px 0; }
.flow span { padding:3px 9px; border-radius:999px; border:1px solid var(--line); font-size:12px; color:var(--muted); }
.flow .done { color:var(--ok); border-color:var(--ok); } .flow .now { color:#fff; background:var(--accent); border-color:var(--accent); }
.tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
.tile { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
.tile b { display:block; font-size:18px; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; } .tile b.long { font-size:14px; } .tile small { color:var(--muted); }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:13px; font-variant-numeric:tabular-nums; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); white-space:nowrap; } th { color:var(--muted); font-weight:500; }
.bar { height:8px; border-radius:4px; background:var(--accent); min-width:2px; } .bar.wait { background:var(--wait); }
.k-agent { color:var(--accent); } .k-humanWait { color:var(--warn); } .k-interrupted { color:var(--bad); } .k-work { color:var(--muted); }
.grid2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:12px; }
.dig b { display:block; margin-top:8px; } .dig ul { margin:2px 0 0; padding-left:18px; }
</style>
</head>
<body><main>
<h1>QA ${esc(m.key)} · ${esc(m.title)}</h1>
<div class="sub">Run ${esc(m.runId)} · tested ${esc(state.tested?.branch)} @ ${esc(state.tested?.sha?.slice(0, 7))} · updated ${esc(new Date().toISOString().slice(0, 19).replace('T', ' '))} UTC${live ? ' · refreshes every 15 s' : ''}${m.verdict ? ` · recommended <b>${esc(m.verdict)}</b>` : ''}${m.qaPr ? ` · <a href="${esc(m.qaPr.url)}">QA PR #${esc(m.qaPr.number)}</a>` : ''}</div>
<div class="flow">${FLOW.map((p, j) => `<span class="${idx === -1 ? '' : j < idx ? 'done' : j === idx ? 'now' : ''}">${esc(p)}</span>`).join('')}${idx === -1 ? `<span class="now">${esc(m.phase)}</span>` : ''}</div>
<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><small>${esc(k)}</small><b${String(v).length > 14 ? ' class="long"' : ''}>${esc(v)}</b></div>`).join('')}</div>
<div class="grid2">
<div><h2>Active time by phase</h2><div class="panel"><table><tr><th>Phase</th><th>Active</th><th></th><th>Waiting / away</th></tr>
${phaseRows.map(([p, v]) => `<tr><td>${esc(p)}</td><td>${fmtMs(v.activeMs)}</td><td style="width:40%"><div class="bar" style="width:${Math.round((100 * v.activeMs) / maxPhase)}%"></div></td><td>${fmtMs(v.humanWaitMs + v.interruptedMs)}</td></tr>`).join('\n')}
</table></div></div>
<div><h2>Agents</h2><div class="panel"><table><tr><th>Agent</th><th>Runs</th><th>Time</th><th>Tokens</th><th></th></tr>
${Object.entries(m.agents.byAgent).map(([n, v]) => `<tr><td>${esc(n)}</td><td>${v.dispatches}</td><td>${fmtMs(v.durationMs)}</td><td>${fmtTokens(v.total)}</td><td style="width:30%"><div class="bar" style="width:${Math.round((100 * v.total) / maxAgent)}%"></div></td></tr>`).join('\n') || '<tr><td colspan="5">No agent data yet.</td></tr>'}
</table></div></div>
</div>
<h2>What each step produced</h2>
<div class="panel dig">${dig.map((d) => `<b>${esc(d.step)}</b><ul>${d.lines.map((l) => `<li>${esc(l).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`).join('')}</ul>`).join('') || 'Nothing yet.'}</div>
${last ? `<h2>Last test run</h2><div class="panel">${esc(pairs(last))}</div>` : ''}
<h2>Steps</h2>
<div class="panel"><table><tr><th>At (UTC)</th><th>Phase</th><th>Step</th><th>Took</th><th>Kind</th><th>Outcome</th></tr>
${m.steps.slice().reverse().map((s) => `<tr><td>${esc(s.at.slice(5, 16).replace('T', ' '))}</td><td>${esc(s.phase)}</td><td>${esc(s.step)}</td><td>${fmtMs(s.ms)}</td><td class="k-${esc(s.kind)}">${esc(s.kind)}</td><td>${esc(s.outcome)}</td></tr>`).join('\n')}
</table></div>
${m.gates.length ? `<h2>Gates</h2><div class="panel"><table><tr><th>At (UTC)</th><th>Gate</th><th>Decision</th></tr>${m.gates.map((g) => `<tr><td>${esc(g.at.slice(5, 16).replace('T', ' '))}</td><td>${esc(g.id)}</td><td>${esc(g.decision)}</td></tr>`).join('')}</table></div>` : ''}
</main></body>
</html>
`;
}

// Rebuild metrics.json, progress.md and dashboard.html. Never throws: a view is not worth failing a step over.
export function refreshViews(runDir) {
  try {
    const state = readJson(path.join(runDir, 'state.json'));
    const m = computeMetrics(runDir);
    const dig = digests(runDir);
    writeJsonAtomic(path.join(runDir, 'metrics.json'), m);
    writeTextAtomic(path.join(runDir, 'progress.md'), renderProgress(state, m, dig));
    writeTextAtomic(path.join(runDir, 'dashboard.html'), renderDashboard(state, m, dig));
    return true;
  } catch {
    return false;
  }
}

