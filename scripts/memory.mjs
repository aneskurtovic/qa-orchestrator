// QA memory: what earlier runs on this repo learned, handed to the next run's agents as hints.
//
//   memory.mjs update --project <dir> --run <runDir>   learn from a finished run (idempotent; release calls it)
//   memory.mjs show   --project <dir> [--agent <name>] the entries, or the hint block one agent gets
//   memory.mjs used   --run <runDir>                   the entries this run's briefs carried (shown at G2)
//   memory.mjs forget --project <dir> --id <id>        drop a wrong entry (only when the human asks)
//
// <project>/.qa-runs/memory.json (+ a readable MEMORY.md). It stays on this machine, like .qa-runs.
// Rules, because a stale hint can hide a real defect:
//   - deterministic: learned from the run's validated outputs, never written by a model
//   - suggest-only: every hint says it is unverified; it never decides a classification,
//     and it never edits .qa/config.json (it can only suggest adding, removing or narrowing a
//     qa.knownDrift entry; the last two come from the known-drift probe)
//   - cited: each entry names the runs it came from
//   - expiring: an entry not seen in the last EXPIRE_AFTER_RUNS runs is dropped
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isMain, main, need, readJson, UsageError, writeJsonAtomic, writeTextAtomic } from './lib/common.mjs';

export const EXPIRE_AFTER_RUNS = 6;
const KEEP_SEEN = 5;
const MAX_CRITIC_GAPS_PER_TARGET = 6;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const idOf = (...parts) => createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 8);

export const memoryFile = (project) => path.join(project, '.qa-runs', 'memory.json');
export const emptyMemory = () => ({ schemaVersion: 1, updatedAt: null, runs: [], entries: [] });
export const loadMemory = (project) => readJson(memoryFile(project), emptyMemory());

// Facts a finished run teaches, each { key, type, agents, subject, summary, detail?, suggestion? }.
export function lessons(runDir, config = {}) {
  const at = (f) => readJson(path.join(runDir, f), null);
  const out = [];
  const failures = at('triage.json')?.failures ?? [];
  const attempts = (existsSync(runDir) ? readdirSync(runDir) : [])
    .map((f) => /^runner-(\d+)\.json$/.exec(f)).filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => at(m[0]));
  const knownDrift = driftKeys(config);

  for (const f of failures) {
    const subject = `${f.spec} › ${f.test}`;
    if (f.classification === 'pre-existing') {
      out.push({
        key: idOf('known-failure', f.spec, f.test), type: 'known-failure', agents: ['qa-triage', 'qa-suite-impact', 'qa-feedback'], subject,
        // A guessed cause would be repeated to later runs as fact (seen live: 0.55 "unproven").
        summary: `failed for a reason outside the ticket${f.causeCommit && (f.confidence ?? 0) >= 0.7 ? `; cause ${f.causeCommit}` : ''}`,
        detail: f.proposedTestChange ? clip(f.proposedTestChange, 300) : null,
        file: f.spec, test: f.test, inKnownDrift: inDrift(knownDrift, f.spec, f.test),
      });
    } else if (f.classification === 'env') {
      out.push({ key: idOf('env-issue', f.spec, f.test), type: 'env-issue', agents: ['qa-triage'], subject, summary: clip(f.evidence?.[0], 220) });
    } else if (f.classification === 'test-bug') {
      out.push({ key: idOf('author-lesson', f.spec, f.test), type: 'author-lesson', agents: ['qa-test-author'], subject, summary: clip(f.evidence?.[0], 220) });
    } else if (f.classification === 'flaky-suspected') {
      // Flaky only when a later attempt ran the spec and the test passed there.
      const later = attempts.filter((a) => a && (a.files ?? []).some((x) => String(x).replace(/\\/g, '/').endsWith(f.spec)));
      const passedLater = later.length > 1 && !(later.at(-1).failures ?? []).some((x) => x.title === f.test || x.test === f.test);
      if (passedLater) out.push({ key: idOf('flaky', f.spec, f.test), type: 'flaky', agents: ['qa-triage', 'qa-feedback'], subject, summary: 'failed, then passed on a controlled rerun' });
    }
  }
  const critics = (existsSync(runDir) ? readdirSync(runDir) : []).filter((f) => /^critic-\d+\.json$/.test(f));
  // A gap is about its ticket. `files` (what the run touched) lets a later run that touches the
  // same code get it, and keeps it from every other one (seen live: 12 hints about other tickets).
  const files = critics.length ? runFiles(runDir) : [];
  for (const f of critics) {
    for (const g of at(f)?.gaps ?? []) {
      out.push({
        key: idOf('critic-gap', g.target, g.ref, clip(g.problem, 80)), type: 'critic-gap', agents: [g.target, 'qa-critic'],
        subject: g.target, summary: clip(g.problem, 240), detail: clip(g.fix, 200), files,
      });
    }
  }
  for (const e of readEvents(runDir)) {
    if (e.kind !== 'deny' || !e.agent) continue;
    const agent = String(e.agent).replace(/^qa-orchestrator:/, '');
    out.push({ key: idOf('guard-denial', agent, e.rule, e.tool), type: 'guard-denial', agents: [agent], subject: `${e.rule} on ${e.tool}`, summary: clip(e.call ? `${e.reason} Denied: ${e.call}` : e.reason, 320) });
  }
  // The known-drift probe: a suggestion for the human about the config, never a hint for an agent.
  // A later probe of the same spec replaces it (same key), so a relapse withdraws the suggestion.
  const runId = at('state.json')?.runId ?? path.basename(runDir);
  for (const p of at('drift-probe.json')?.probed ? at('drift-probe.json').entries : []) {
    const suggestion = p.status === 'passed'
      ? `${p.file}: every qa.knownDrift test it skips passed in the drift probe of run ${runId} (${p.passed.length}); consider removing the entry from .qa/config.json.`
      : p.status === 'failed' && p.wholeFile && p.passed.length
        ? `${p.file}: only ${p.failed.length} of its ${p.passed.length + p.failed.length} tests still fail in the drift probe of run ${runId}; consider narrowing its qa.knownDrift entry to "tests": ${JSON.stringify(p.failed)}.`
        : null;
    out.push({
      key: idOf('drift-probe', p.file), type: 'drift-probe', agents: [], subject: p.file,
      summary: p.status === 'no-tests' ? 'the probe ran none of the tests the entry names' : `probe ${p.status}: ${p.passed.length} passed, ${p.failed.length} failed`,
      file: p.file, healed: p.status === 'passed' ? p.passed : [], suggestion,
    });
  }
  return out;
}

// The repo files a run is about: the dev diff's files and the plan's change set.
export function runFiles(runDir) {
  const diffFile = path.join(runDir, 'dev-changes.diff');
  const diff = existsSync(diffFile) ? readFileSync(diffFile, 'utf8') : '';
  const fromDiff = [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
  const cs = readJson(path.join(runDir, 'plan.json'), null)?.changeSet ?? {};
  const fromPlan = [...(cs.update ?? []), ...(cs.add ?? []), ...(cs.delete ?? [])].map((i) => i.file);
  return [...new Set([...fromDiff, ...fromPlan].filter(Boolean).map((f) => String(f).replace(/\\/g, '/')))];
}

// Specs the first full test run ran without a failure. A known failure in one of them was fixed,
// and its hint would mislead (seen live: a spec passed and was still listed as failing).
export function cleanSpecs(runDir) {
  const first = readJson(path.join(runDir, 'runner-1.json'), null);
  const posix = (f) => String(f).replace(/\\/g, '/');
  const failing = (first?.failures ?? []).map((f) => posix(f.spec));
  return (first?.files ?? []).map(posix).filter((f) => !failing.some((x) => sameSpec(x, f)));
}

// Playwright reports a spec relative to its testDir, the plan relative to the repo.
const sameSpec = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
// The knownDrift keys: a spec, or `<spec> › <title>` for an entry that skips only some tests.
export const driftKeys = (config) => new Set((config.qa?.knownDrift ?? [])
  .flatMap((d) => (d.tests?.length ? d.tests.map((t) => `${d.file} › ${t}`) : [d.file])));
// Triage may name a spec by its bare file name, the config by its repo path (seen live: a spec
// was still suggested for qa.knownDrift while it was in it), and a test with its describe titles.
const inDrift = (knownDrift, file, test = '') => [...knownDrift].some((k) => {
  const i = String(k).indexOf(' › ');
  const [spec, title] = i < 0 ? [String(k), null] : [k.slice(0, i), k.slice(i + 3)];
  return sameSpec(String(file).replace(/\\/g, '/'), spec) && (title === null || test === title || String(test).endsWith(` › ${title}`));
});

function readEvents(runDir) {
  const file = path.join(runDir, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
}

export function learn(memory, runId, found, { knownDrift, cleanSpecs: clean = [] } = {}) {
  const next = structuredClone(memory);
  const byKey = new Map(next.entries.map((e) => [e.key, e]));
  const seenHere = new Set();
  let added = 0;
  let updated = 0;
  if (!next.runs.includes(runId)) next.runs.push(runId);
  for (const l of found) {
    if (seenHere.has(l.key)) continue;
    seenHere.add(l.key);
    const e = byKey.get(l.key);
    if (!e) {
      byKey.set(l.key, { id: l.key, ...l, seenIn: [runId], count: 1, firstSeen: runId, lastSeen: runId });
      added += 1;
    } else if (!e.seenIn.includes(runId)) {
      Object.assign(e, { ...l, id: e.id, seenIn: [...e.seenIn, runId].slice(-KEEP_SEEN), count: e.count + 1, firstSeen: e.firstSeen, lastSeen: runId });
      updated += 1;
    }
  }
  // Suggestions are derived, never applied. A spec added to knownDrift since it was
  // learned stops being suggested (it no longer runs, so it's never seen again).
  const testOf = (e) => e.test ?? String(e.subject).split(' › ').slice(1).join(' › ');
  for (const e of byKey.values()) {
    if (e.type !== 'known-failure') continue;
    // Entries learned before `test` was stored carry it in the subject, after the spec.
    if (knownDrift) e.inKnownDrift = inDrift(knownDrift, e.file, testOf(e));
    e.suggestion = e.count >= 2 && !e.inKnownDrift
      ? `${e.file} failed outside its ticket in ${e.count} runs: consider adding it to qa.knownDrift in .qa/config.json until it is fixed.`
      : null;
  }
  // Tests the drift probe of this run saw pass: their known failure is fixed, knownDrift or not.
  const healed = found.filter((l) => l.type === 'drift-probe' && l.healed?.length);
  let resolved = 0;
  for (const [key, e] of byKey) {
    // A test left out by a test-level knownDrift entry didn't run, even though its spec ran clean.
    const cleanHere = !e.inKnownDrift && clean.some((f) => sameSpec(String(e.file), f));
    const probedPass = healed.some((h) => sameSpec(String(e.file), h.file) && h.healed.some((t) => t === testOf(e) || testOf(e).endsWith(` › ${t}`)));
    if (e.type === 'known-failure' && !seenHere.has(key) && (cleanHere || probedPass)) {
      byKey.delete(key);
      resolved += 1;
    }
    // A probe suggestion is withdrawn once its spec is no longer in qa.knownDrift.
    if (e.type === 'drift-probe' && knownDrift && ![...knownDrift].some((k) => sameSpec(String(e.file), String(k).split(' › ')[0]))) {
      byKey.delete(key);
    }
  }
  const recent = new Set(next.runs.slice(-EXPIRE_AFTER_RUNS));
  let entries = [...byKey.values()].filter((e) => recent.has(e.lastSeen));
  const expired = byKey.size - entries.length;
  // Critic gaps are ticket-specific; keep only the latest few per target agent.
  const perTarget = {};
  entries = entries.slice().reverse().filter((e) => {
    if (e.type !== 'critic-gap') return true;
    perTarget[e.subject] = (perTarget[e.subject] ?? 0) + 1;
    return perTarget[e.subject] <= MAX_CRITIC_GAPS_PER_TARGET;
  }).reverse();
  next.entries = entries;
  return { memory: next, added, updated, expired, resolved };
}

const LABEL = {
  'known-failure': 'Known failure', 'env-issue': 'Environment issue', 'author-lesson': 'Authoring mistake',
  flaky: 'Flaky test', 'critic-gap': 'Critic finding', 'guard-denial': 'Guard denial', 'drift-probe': 'Known-drift probe',
};

// The hint block one agent's brief carries, and the ids it contains. With `files` (the run's,
// from runFiles), a critic gap goes only to a run that touches a file its run touched, and a known
// failure the config already skips (qa.knownDrift) is left out: the plan doesn't run that test.
export function hintsFor(memory, agent, { files } = {}) {
  const touches = (e) => (e.files ?? []).some((f) => files.includes(f));
  const entries = memory.entries.filter((e) => e.agents.includes(agent)
    && (!files || ((e.type !== 'critic-gap' || touches(e)) && !(e.type === 'known-failure' && e.inKnownDrift))));
  if (!entries.length) return { text: '', ids: [] };
  const lines = [
    '## Hints from earlier QA runs on this repo (memory)',
    '',
    'Unverified. Check each hint against this run\'s own evidence before you rely on it. A hint never decides a',
    'classification or a plan item by itself; if the evidence disagrees, the evidence wins and you say so.',
    '',
    ...entries.map((e) => `- [${e.id}] ${LABEL[e.type] ?? e.type}: ${e.subject}: ${e.summary}${e.detail ? ` (fix then: ${e.detail})` : ''} (seen ${e.count}x, last in ${e.lastSeen})`),
  ];
  return { text: lines.join('\n'), ids: entries.map((e) => e.id) };
}

// The G2 table of the hints this run's agents were given, printed as is (it once showed only counts).
export function usedTable(entries) {
  if (!entries.length) return 'No memory hints were given to this run\'s agents.';
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  return [
    '| id | type | subject | summary | seen |',
    '|---|---|---|---|---|',
    ...entries.map((e) => `| \`${e.id}\` | ${LABEL[e.type] ?? e.type} | ${cell(e.subject)} | ${cell(e.summary)} | ${e.count}x, last ${e.lastSeen} |`),
  ].join('\n');
}

// One line per suggestion (several failing tests in one spec share it).
export const suggestionsOf = (memory) => [...new Set(memory.entries.map((e) => e.suggestion).filter(Boolean))];

export function renderMemory(memory) {
  const lines = [
    '# QA memory',
    '',
    `Learned from ${memory.runs.length} runs; updated ${memory.updatedAt ?? 'never'}. Written by \`memory.mjs\`, not by hand.`,
    `Entries expire when not seen in the last ${EXPIRE_AFTER_RUNS} runs. Drop a wrong one with \`memory.mjs forget --id <id>\`.`,
    '',
  ];
  const suggestions = suggestionsOf(memory);
  if (suggestions.length) lines.push('## Suggestions (for a human)', '', ...suggestions.map((s) => `- ${s}`), '');
  for (const type of Object.keys(LABEL)) {
    const es = memory.entries.filter((e) => e.type === type);
    if (!es.length) continue;
    lines.push(`## ${LABEL[type]}s`, '', ...es.map((e) => `- \`${e.id}\` **${e.subject}**: ${e.summary}. Seen ${e.count}x (${e.seenIn.join(', ')}). For: ${e.agents.join(', ')}.`), '');
  }
  return lines.join('\n');
}

export function save(project, memory) {
  const m = { ...memory, updatedAt: new Date().toISOString() };
  writeJsonAtomic(memoryFile(project), m);
  writeTextAtomic(path.join(project, '.qa-runs', 'MEMORY.md'), renderMemory(m));
  return m;
}

export function updateFromRun({ project, runDir }) {
  const state = readJson(path.join(runDir, 'state.json'));
  const config = readJson(path.join(project, '.qa', 'config.json'), {});
  const knownDrift = driftKeys(config);
  const result = learn(loadMemory(project), state.runId, lessons(runDir, config), { knownDrift, cleanSpecs: cleanSpecs(runDir) });
  const saved = save(project, result.memory);
  return { added: result.added, updated: result.updated, expired: result.expired, resolved: result.resolved, entries: saved.entries.length, suggestions: suggestionsOf(saved) };
}

if (isMain(import.meta.url)) {
  main(async (args) => {
    const cmd = args._[0];
    if (cmd === 'update') { need(args, 'project', 'run'); return { ok: true, ...updateFromRun({ project: args.project, runDir: args.run }) }; }
    if (cmd === 'show') {
      need(args, 'project');
      const m = loadMemory(args.project);
      return args.agent ? hintsFor(m, args.agent) : m;
    }
    if (cmd === 'used') {
      need(args, 'run');
      const index = readJson(path.join(args.run, 'briefs', 'index.json'), []);
      const project = path.resolve(args.run, '..', '..', '..');
      const ids = new Set(index.flatMap((b) => b.memoryIds ?? []));
      const entries = loadMemory(project).entries.filter((e) => ids.has(e.id));
      return { ok: true, entries, table: usedTable(entries) };
    }
    if (cmd === 'forget') {
      need(args, 'project', 'id');
      const m = loadMemory(args.project);
      const entries = m.entries.filter((e) => e.id !== args.id);
      if (entries.length === m.entries.length) throw new UsageError(`no memory entry ${args.id}`);
      save(args.project, { ...m, entries });
      return { ok: true, forgot: args.id };
    }
    throw new UsageError('usage: memory.mjs update|show|used|forget --project <dir> …');
  });
}
