// Run data: where a QA run spent its time and tokens, and what it produced.
//
//   metrics.mjs --run <runDir> [--out <file>] [--transcripts <dir>]
//        → RUN/metrics.json (or --out). --transcripts backfills agent events from
//          Claude Code session transcripts when the run has no events.jsonl (runs
//          made before the recorder hook existed).
//   metrics.mjs history --project <dir> [--file <history.jsonl>]
//        → medians per phase over every finished run: the numbers for demo timings.
//
// Every minute between two recorded events belongs to the phase in effect and to one
// of four kinds, so a run left waiting overnight doesn't read as "slow":
//   agent        an agent was running: the recorder's interval for it (first to last
//                transcript line), else its timeline step's brief-to-record span. Overlapping
//                agents count once, and an agent's time counts wherever it ran, even inside a
//                gap that ends in a gate answer (seen live: triage's 94 s had landed in G3's wait).
//                A run with no intervals at all (an older run) falls back to "the gap
//                ended with an agent step".
//   work         the orchestrator and the plugin scripts: the rest
//   humanWait    a gate was open: a wait phase (AWAITING_*, ESCALATED, …) until its gate is
//                answered, or a gap that ends in a gate answer
//   interrupted  the session was gone (the gap ended in a resume/takeover), or nothing was
//                recorded for longer than IDLE_MS
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain, main, need, readJson, UsageError, writeJsonAtomic, writeTextAtomic } from './lib/common.mjs';
import { eventFromTranscript, readMeta, transcriptStats } from '../hooks/record.mjs';

export const WAIT_PHASES = ['AWAITING_PLAN_APPROVAL', 'AWAITING_ENGINEER', 'AWAITING_HUMAN_REVIEW', 'ESCALATED', 'BLOCKED_ENV', 'BLOCKED_NOT_INTEGRATED', 'STOPPED'];
export const IDLE_MS = 60 * 60 * 1000;
const KINDS = ['agentMs', 'workMs', 'humanWaitMs', 'interruptedMs'];
const zero = () => Object.fromEntries(KINDS.map((k) => [k, 0]));
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()) : []);
const parseLines = (file) => readLines(file).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

// Timeline entries and gate answers, oldest first, as { t, step, agent, gate, marker }.
function events(state) {
  const out = [];
  for (const e of state.timeline ?? []) {
    const t = Date.parse(e.finishedAt ?? e.at);
    if (!Number.isFinite(t)) continue;
    out.push({
      t, step: e.step, agent: e.agent ?? null, outcome: e.outcome ?? null,
      phase: e.step.startsWith('phase:') ? e.step.slice(6) : null,
      // resume/takeover written by preflight carry `at` and mark a new session picking the run up.
      resumeMarker: (e.step === 'resume' || e.step === 'takeover') && e.at !== undefined,
    });
  }
  for (const g of state.gates ?? []) {
    const t = Date.parse(g.at);
    if (Number.isFinite(t)) out.push({ t, step: `gate:${g.id}`, gate: g.id, decision: g.decision });
  }
  return out.sort((a, b) => a.t - b.t);
}

const span = (from, to) => {
  const s = Date.parse(from);
  const f = Date.parse(to);
  return Number.isFinite(s) && Number.isFinite(f) && f >= s ? { s, f } : null;
};

// When each agent ran. The recorder's events are exact; a timeline agent step that no event
// accounts for (by step, or an event of that agent ending inside its span) adds its
// brief-to-record span, which also holds the orchestrator's save and validate.
export function agentIntervals(state, agentEvents = []) {
  const out = agentEvents.flatMap((e) => {
    const t = span(e.startedAt, e.endedAt);
    return t ? [{ ...t, step: e.step ?? null, agent: e.agent }] : [];
  });
  const fromEvents = [...out];
  for (const t of state.timeline ?? []) {
    const own = t.agent && span(t.startedAt, t.finishedAt);
    if (!own) continue;
    const agent = String(t.agent).replace(/^qa-orchestrator:/, '');
    if (fromEvents.some((e) => e.step === t.step || (e.agent === agent && e.f > own.s && e.f <= own.f))) continue;
    out.push({ ...own, step: t.step, agent });
  }
  return out;
}

function union(intervals) {
  const merged = [];
  for (const { s, f } of [...intervals].sort((a, b) => a.s - b.s)) {
    const last = merged.at(-1);
    if (last && s <= last.f) last.f = Math.max(last.f, f);
    else merged.push({ s, f });
  }
  return merged;
}

const overlap = (from, to, merged) => merged.reduce((ms, m) => ms + Math.max(0, Math.min(to, m.f) - Math.max(from, m.s)), 0);

export function splitTime(state, agentEvents = []) {
  const phases = {};
  const steps = [];
  const total = zero();
  const intervals = agentIntervals(state, agentEvents);
  const merged = union(intervals);
  // A timeline agent step's own interval: its step's, else the latest unclaimed one of that agent.
  const claimed = new Set();
  const intervalOf = (e) => {
    const agent = String(e.agent).replace(/^qa-orchestrator:/, '');
    const pick = intervals.find((i) => i.step === e.step && !claimed.has(i))
      ?? intervals.filter((i) => i.agent === agent && !i.step && !claimed.has(i) && i.f <= e.t).at(-1);
    if (pick) claimed.add(pick);
    return pick ?? null;
  };
  const add = (phase, kind, ms) => { (phases[phase] ??= zero())[kind] += ms; total[kind] += ms; };
  let phase = 'PREFLIGHT';
  let waiting = false;
  let prev = Date.parse(state.startedAt);
  for (const e of events(state)) {
    const ms = Number.isFinite(prev) ? Math.max(0, e.t - prev) : 0;
    const agentMs = Number.isFinite(prev) ? overlap(prev, e.t, merged) : 0;
    const rest = ms - agentMs;
    const own = e.agent ? intervalOf(e) : null;
    let kind;
    if (waiting || e.gate) kind = 'humanWaitMs';
    else if (e.resumeMarker || rest > IDLE_MS) kind = 'interruptedMs';
    else if (e.agent && !merged.length) kind = 'agentMs';
    else kind = 'workMs';
    add(phase, 'agentMs', agentMs);
    add(phase, kind, rest);
    if (!e.phase) {
      steps.push({
        // An agent step shows how long the agent ran; any other step its gap minus agent time.
        step: e.step, phase, agent: e.agent ?? null, ms: own ? own.f - own.s : e.agent && !merged.length ? ms : rest,
        kind: e.agent ? 'agent' : kind.replace(/Ms$/, ''), outcome: e.outcome ?? e.decision ?? null, at: new Date(e.t).toISOString(),
      });
    }
    // A wait phase waits until its gate is answered; what follows the answer is work again.
    if (e.gate) waiting = false;
    if (e.phase) { phase = e.phase; waiting = WAIT_PHASES.includes(phase); }
    prev = e.t;
  }
  for (const p of Object.values(phases)) p.activeMs = p.agentMs + p.workMs;
  total.activeMs = total.agentMs + total.workMs;
  return {
    phases, steps, total, finalPhase: phase, method: merged.length ? 'intervals' : 'gaps',
    endedAt: Number.isFinite(prev) ? new Date(prev).toISOString() : null,
  };
}

// Agent events for runs made before the recorder hook, from the Claude Code
// project folder (<dir>/<session>/subagents/agent-<id>.jsonl + .meta.json).
// A subagent belongs to the run when its prompt names the runId.
export function eventsFromTranscripts(dir, runId) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  for (const session of readdirSync(dir)) {
    const sub = path.join(dir, session, 'subagents');
    if (!existsSync(sub)) continue;
    for (const name of readdirSync(sub)) {
      if (!/^agent-.*\.jsonl$/.test(name)) continue;
      const file = path.join(sub, name);
      if (!String(readMeta(file).agentType ?? '').startsWith('qa-orchestrator:')) continue;
      const stats = transcriptStats(file);
      if (!stats?.prompt?.includes(runId)) continue;
      out.push(eventFromTranscript(file, { now: stats.endedAt, extra: { backfilled: true } }));
    }
  }
  return out.filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// SubagentStop can fire more than once for one agent (continued with SendMessage, a
// background agent stopping again), and each event re-sums the whole transcript.
// Keep the last event per agentId, in the position of the first.
export function latestPerAgent(agentEvents) {
  const last = new Map();
  for (const e of agentEvents) if (e.agentId) last.set(e.agentId, e);
  const seen = new Set();
  return agentEvents.flatMap((e) => {
    if (!e.agentId) return [e];
    if (seen.has(e.agentId)) return [];
    seen.add(e.agentId);
    return [last.get(e.agentId)];
  });
}

export function agentTotals(agentEvents) {
  const byAgent = {};
  const totals = { dispatches: 0, durationMs: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };
  for (const e of agentEvents) {
    const a = (byAgent[e.agent] ??= { dispatches: 0, durationMs: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 });
    const tk = e.tokens ?? {};
    const sum = (tk.input ?? 0) + (tk.cacheWrite ?? 0) + (tk.cacheRead ?? 0) + (tk.output ?? 0);
    for (const target of [a, totals]) {
      target.dispatches += 1;
      target.durationMs += e.durationMs ?? 0;
      target.input += tk.input ?? 0;
      target.cacheWrite += tk.cacheWrite ?? 0;
      target.cacheRead += tk.cacheRead ?? 0;
      target.output += tk.output ?? 0;
      target.total += sum;
    }
  }
  return { byAgent, totals };
}

function runnerFiles(runDir, prefix) {
  if (!existsSync(runDir)) return [];
  const re = new RegExp(`^${prefix}(\\d+)\\.json$`);
  return readdirSync(runDir).map((f) => [f, re.exec(f)]).filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([f, m]) => {
      const r = readJson(path.join(runDir, f), null);
      return r && { n: Number(m[1]), status: r.status ?? null, counts: r.counts ?? null, durationMs: r.durationMs ?? null, files: r.files?.length ?? null };
    }).filter(Boolean);
}

function critics(runDir) {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir).filter((f) => /^critic-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => { const c = readJson(path.join(runDir, f), null); return c && { round: Number(f.match(/\d+/)[0]), verdict: c.verdict, gaps: c.gaps?.length ?? 0 }; })
    .filter(Boolean);
}

function counters(runDir) {
  const out = { criticRounds: 0, producerDispatches: 0, testLaunches: 0 };
  for (const { kind } of parseLines(path.join(runDir, 'counters.log'))) if (kind in out) out[kind] += 1;
  return out;
}

export function computeMetrics(runDir, { transcripts } = {}) {
  const state = readJson(path.join(runDir, 'state.json'));
  const recorded = parseLines(path.join(runDir, 'events.jsonl'));
  let agentEvents = latestPerAgent(recorded.filter((e) => e.kind === 'agent'));
  let agentSource = agentEvents.length ? 'recorder' : 'none';
  if (!agentEvents.length && transcripts) {
    agentEvents = eventsFromTranscripts(transcripts, state.runId);
    if (agentEvents.length) agentSource = 'transcripts';
  }
  const time = splitTime(state, agentEvents);
  const triage = readJson(path.join(runDir, 'triage.json'), null);
  const classes = {};
  for (const f of triage?.failures ?? state.triage ?? []) classes[f.classification] = (classes[f.classification] ?? 0) + 1;
  const attempts = runnerFiles(runDir, 'runner-');
  const feedback = readJson(path.join(runDir, 'feedback.json'), null);
  return {
    schemaVersion: 1,
    runId: state.runId,
    key: state.ticket?.key ?? null,
    title: state.ticket?.title ?? null,
    retest: Boolean(state.retest ?? state.qa?.retest),
    tested: state.tested ?? null,
    startedAt: state.startedAt ?? null,
    endedAt: time.endedAt,
    phase: state.phase ?? time.finalPhase,
    verdict: feedback?.recommendedVerdict ?? null,
    qaPr: state.publication?.qaPr ?? null,
    time: { method: time.method, total: time.total, phases: time.phases },
    steps: time.steps,
    agents: {
      source: agentSource,
      ...agentTotals(agentEvents),
      // foreground | background: a background dispatch in a headless run can be orphaned.
      requestShapes: agentEvents.reduce((acc, e) => ({ ...acc, [e.requestShape ?? 'unknown']: (acc[e.requestShape ?? 'unknown'] ?? 0) + 1 }), {}),
      events: agentEvents,
    },
    denials: recorded.filter((e) => e.kind === 'deny').map(({ at, rule, tool, agent }) => ({ at, rule, tool, agent })),
    tests: { attempts, selfChecks: runnerFiles(runDir, 'runner-self-'), last: attempts.at(-1)?.counts ?? null },
    // The known-drift probe after the report (run-playwright.mjs --drift-probe); not in `tests`.
    driftProbe: driftProbeSummary(readJson(path.join(runDir, 'drift-probe.json'), null)),
    triage: classes,
    loop: { ...counters(runDir), critic: critics(runDir) },
    gates: (state.gates ?? []).map(({ id, decision, at }) => ({ id, decision, at })),
  };
}

export function historyRow(m) {
  return {
    runId: m.runId, key: m.key, startedAt: m.startedAt, endedAt: m.endedAt, phase: m.phase, verdict: m.verdict,
    retest: m.retest, qaPr: m.qaPr?.number ?? null,
    activeMs: m.time.total.activeMs, agentMs: m.time.total.agentMs, humanWaitMs: m.time.total.humanWaitMs,
    interruptedMs: m.time.total.interruptedMs,
    phasesActiveMs: Object.fromEntries(Object.entries(m.time.phases).map(([p, v]) => [p, v.activeMs])),
    tokens: m.agents.totals.total, outputTokens: m.agents.totals.output, agentDispatches: m.agents.totals.dispatches,
    criticRounds: m.loop.criticRounds, testLaunches: m.loop.testLaunches, tests: m.tests.last, triage: m.triage,
    // The next run's probe is due by counting runs since the last one that probed.
    driftProbed: Boolean(m.driftProbe?.probed),
  };
}

const driftProbeSummary = (p) => (p ? {
  probed: Boolean(p.probed), why: p.why ?? null, durationMs: p.durationMs ?? null,
  entries: (p.entries ?? []).map(({ file, status, passed, failed }) => ({ file, status, passed: passed.length, failed: failed.length })),
} : null);

// history.jsonl keeps one line per run; a later write for the same run replaces it.
export function upsertHistory(file, row) {
  const rows = parseLines(file).filter((r) => r.runId !== row.runId);
  rows.push(row);
  rows.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return rows;
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export function summarizeHistory(rows) {
  const phases = [...new Set(rows.flatMap((r) => Object.keys(r.phasesActiveMs ?? {})))];
  const min = (ms) => (ms === null ? null : Math.round(ms / 6000) / 10);
  return {
    runs: rows.length,
    medianActiveMin: min(median(rows.map((r) => r.activeMs))),
    medianHumanWaitMin: min(median(rows.map((r) => r.humanWaitMs))),
    medianTokens: median(rows.map((r) => r.tokens).filter((t) => t > 0)),
    medianActiveMinByPhase: Object.fromEntries(phases.map((p) => [p, min(median(rows.map((r) => r.phasesActiveMs?.[p])))])),
    verdicts: rows.reduce((acc, r) => ({ ...acc, [r.verdict ?? 'none']: (acc[r.verdict ?? 'none'] ?? 0) + 1 }), {}),
  };
}

// Called on release: metrics.json + the run's line in <project>/.qa-runs/history.jsonl.
export function recordRun({ project, runDir }) {
  const m = computeMetrics(runDir);
  writeJsonAtomic(path.join(runDir, 'metrics.json'), m);
  const file = path.join(project, '.qa-runs', 'history.jsonl');
  const rows = upsertHistory(file, historyRow(m));
  writeTextAtomic(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return m;
}

if (isMain(import.meta.url)) {
  main(async (args) => {
    if (args._[0] === 'history') {
      need(args, 'project');
      const rows = parseLines(args.file ?? path.join(args.project, '.qa-runs', 'history.jsonl'));
      return { ...summarizeHistory(rows), rows };
    }
    if (args._.length) throw new UsageError('usage: metrics.mjs --run <dir> [--out <file>] [--transcripts <dir>] | metrics.mjs history --project <dir>');
    need(args, 'run');
    const m = computeMetrics(args.run, { transcripts: args.transcripts });
    writeJsonAtomic(args.out ?? path.join(args.run, 'metrics.json'), m);
    const min = (ms) => Math.round(ms / 6000) / 10;
    return {
      ok: true, runId: m.runId, key: m.key, verdict: m.verdict, agentSource: m.agents.source,
      minutes: Object.fromEntries(Object.entries(m.time.total).map(([k, v]) => [k.replace(/Ms$/, ''), min(v)])),
      activeMinutesByPhase: Object.fromEntries(Object.entries(m.time.phases).map(([p, v]) => [p, min(v.activeMs)])),
      tokens: m.agents.totals,
    };
  });
}
