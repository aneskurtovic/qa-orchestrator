// Tests for run data, memory, briefs and the generated views: node --test scripts/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMetrics, historyRow, recordRun, splitTime, summarizeHistory } from '../metrics.mjs';
import { EXPIRE_AFTER_RUNS, cleanSpecs, driftKeys, emptyMemory, hintsFor, learn, lessons, loadMemory, suggestionsOf, updateFromRun, usedTable } from '../memory.mjs';
import { AGENTS, briefVars, render, writeBrief } from '../brief.mjs';
import { refreshViews } from '../lib/views.mjs';
import { release } from '../preflight.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = (min) => new Date(Date.UTC(2026, 8, 26, 8, 0) + min * 60000).toISOString();
const write = (file, data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };

// A finished run: planning with a critic round, a G2 wait, an interruption, authoring, one test run with failures.
function makeRun({ runId = 'r1', key = 'PROJ-9', triage = null, runners = [], critic = null, events = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-data-'));
  const project = path.join(root, 'webapp');
  const runDir = path.join(project, '.qa-runs', key, runId);
  write(path.join(project, '.qa', 'config.json'), {
    qa: { testDir: 'client/e2e', apiTestDir: 'client/e2e/api', knownDrift: [] },
    git: { integrationBranch: 'demo/stage' }, criticalAreas: { auth: ['server/Auth.cs'] }, stack: { project: 'myapp-qa', composeFile: 'c.yml' },
  });
  write(path.join(project, '.qa-runs', 'active.json'), { key, runId, runDir, worktree: path.join(project, '.qa-worktrees', runId), sessionId: 's' });
  write(path.join(runDir, 'state.json'), {
    schemaVersion: 1, runId, startedAt: T(0), ticket: { key, title: 'Cart sort' },
    tested: { branch: 'demo/stage', sha: 'abcdef1234567890' }, qa: { conventionsDocs: ['/wt/.agents/skills/e2e/SKILL.md'] },
    phase: 'AWAITING_HUMAN_REVIEW', plan: { hash: 'sha256:1', approvedHash: 'sha256:1' },
    gates: [{ id: 'G2', at: T(20), decision: 'approved' }],
    timeline: [
      { step: 'preflight', finishedAt: T(1) },
      { step: 'phase:PLANNING', at: T(2) },
      { step: 'suite-impact', agent: 'qa-suite-impact', finishedAt: T(6) },
      { step: 'merge-plan', finishedAt: T(7) },
      { step: 'critic-1', agent: 'qa-critic', finishedAt: T(10) },
      { step: 'phase:AWAITING_PLAN_APPROVAL', at: T(11) },
      { step: 'phase:MAINTAINING', at: T(21) },
      { step: 'resume', at: T(140), outcome: 'from session x' },
      { step: 'test-author', agent: 'qa-test-author', finishedAt: T(160) },
      { step: 'phase:EXECUTING', at: T(161) },
      { step: 'run-1', finishedAt: T(167), outcome: 'failures' },
      { step: 'phase:AWAITING_HUMAN_REVIEW', at: T(170) },
    ],
  });
  write(path.join(runDir, 'plan.json'), { planHash: 'sha256:1', changeSet: { update: [{ file: 'client/e2e/cart.spec.ts' }], add: [{ file: 'client/e2e/sort.spec.ts' }], delete: [] }, runSet: ['a'] });
  write(path.join(runDir, 'suite-baseline.json'), { files: { 'client/e2e/cart.spec.ts': {} } });
  write(path.join(runDir, 'feedback.json'), { recommendedVerdict: 'QA Failed', defects: [], findings: [] });
  if (triage) write(path.join(runDir, 'triage.json'), { failures: triage });
  runners.forEach((r, i) => write(path.join(runDir, `runner-${i + 1}.json`), r));
  if (critic) write(path.join(runDir, 'critic-1.json'), critic);
  if (events.length) write(path.join(runDir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return { root, project, runDir, runId, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const preExisting = { spec: 'client/e2e/a11y.spec.ts', test: 'live game', classification: 'pre-existing', causeCommit: '7f8a6bd', proposedTestChange: 'open the disclosure first', evidence: ['timeout'], confidence: 0.9, recommendedAction: 'report' };

// ── metrics ─────────────────────────────────────────────────────────────────
test('metrics: wall time splits into agent, orchestration, human wait and interruption, per phase', () => {
  const run = makeRun();
  const state = JSON.parse(readFileSync(path.join(run.runDir, 'state.json'), 'utf8'));
  const { phases, total } = splitTime(state);
  const min = (ms) => ms / 60000;
  assert.equal(min(phases.PLANNING.agentMs), 7, 'suite-impact 4m + critic 3m');
  assert.equal(min(phases.PLANNING.workMs), 2, 'merge-plan 1m + phase marker 1m');
  assert.equal(min(phases.AWAITING_PLAN_APPROVAL.humanWaitMs), 9, 'G2 was open 9m');
  assert.equal(min(phases.AWAITING_PLAN_APPROVAL.workMs), 1, 'after the answer it is work again (the phase change)');
  assert.equal(min(phases.MAINTAINING.interruptedMs), 119, 'the session was gone until the resume');
  assert.equal(min(phases.MAINTAINING.agentMs), 20);
  assert.equal(min(phases.EXECUTING.workMs), 9);
  assert.equal(min(total.activeMs), min(total.agentMs + total.workMs));
  assert.equal(min(total.agentMs + total.workMs + total.humanWaitMs + total.interruptedMs), 170, 'every minute is accounted for once');
  run.cleanup();
});

test('metrics: agent time comes from its interval: parallel agents count once, an agent inside a gate gap is not waiting', () => {
  const state = {
    startedAt: T(0),
    gates: [{ id: 'G2', at: T(18), decision: 'approved' }, { id: 'G3', at: T(33), decision: 'continue' }],
    timeline: [
      { step: 'preflight', finishedAt: T(1) },
      { step: 'phase:PLANNING', at: T(1) },
      // The two producers ran in parallel; each is recorded after its output was saved and validated.
      { step: 'suite-impact', agent: 'qa-suite-impact', startedAt: T(1), finishedAt: T(6) },
      { step: 'change-analyst', agent: 'qa-change-analyst', startedAt: T(1), finishedAt: T(7) },
      { step: 'merge-plan', finishedAt: T(8) },
      { step: 'phase:AWAITING_PLAN_APPROVAL', at: T(8) },
      { step: 'G2', finishedAt: T(19) },
      { step: 'phase:EXECUTING', at: T(20) },
      { step: 'run-1', finishedAt: T(26), outcome: 'failures' },
      { step: 'phase:TRIAGING', at: T(26) },
      // G3 was asked and answered before triage's step was recorded.
      { step: 'triage', agent: 'qa-triage', startedAt: T(26), finishedAt: T(34) },
      { step: 'phase:REPORTING', at: T(35) },
      { step: 'deliver', finishedAt: T(37) },
      { step: 'jira-report', finishedAt: T(38) },
      { step: 'phase:AWAITING_HUMAN_REVIEW', at: T(38) },
    ],
  };
  const agentEvents = [
    { agent: 'qa-suite-impact', step: 'suite-impact', startedAt: T(1), endedAt: T(5) },
    { agent: 'qa-change-analyst', step: 'change-analyst', startedAt: T(1), endedAt: T(6) },
    { agent: 'qa-triage', step: 'triage', startedAt: T(27), endedAt: T(30) },
  ];
  const { phases, steps, total, method } = splitTime(state, agentEvents);
  const min = (ms) => ms / 60000;
  const took = Object.fromEntries(steps.map((s) => [s.step, min(s.ms)]));
  assert.equal(method, 'intervals');
  assert.deepEqual([took['suite-impact'], took['change-analyst']], [4, 5], 'each producer keeps its own duration');
  assert.deepEqual([min(phases.PLANNING.agentMs), min(phases.PLANNING.workMs)], [5, 2], 'overlap counted once; save/validate and merge are work');
  assert.deepEqual([min(phases.AWAITING_PLAN_APPROVAL.humanWaitMs), min(phases.AWAITING_PLAN_APPROVAL.workMs)], [10, 2], 'the G2 step after the answer is work');
  assert.deepEqual([min(phases.TRIAGING.agentMs), min(phases.TRIAGING.humanWaitMs)], [3, 4], "triage's 3m is agent time, not G3's wait");
  assert.deepEqual([took.triage, took['gate:G3']], [3, 4], 'the G3 row shows its wait, not the whole gap');
  assert.deepEqual([took.deliver, took['jira-report']], [2, 1], 'REPORTING splits into push and Jira');
  assert.equal(min(total.agentMs + total.workMs + total.humanWaitMs + total.interruptedMs), 38, 'every minute is accounted for once');

  // Without the recorder's events, the timeline's brief-to-record spans stand in.
  const fromTimeline = splitTime(state, []);
  assert.equal(fromTimeline.method, 'intervals');
  assert.equal(min(fromTimeline.phases.PLANNING.agentMs), 6);
  // A run from before the brief index: no intervals at all, the old gap method.
  const old = splitTime({ ...state, timeline: state.timeline.map(({ startedAt, ...t }) => t) }, []);
  assert.equal(old.method, 'gaps');
  assert.equal(min(old.phases.PLANNING.agentMs), 6);
});

test('metrics: agents from the recorder, tests, triage, loop counts; history keeps one line per run', () => {
  const run = makeRun({
    triage: [preExisting, { ...preExisting, test: 'b', classification: 'defect' }],
    runners: [{ status: 'completed', counts: { passed: 3, failed: 2 }, durationMs: 1000, files: ['a'] }],
    critic: { verdict: 'revise', gaps: [{ ref: 'r', problem: 'p', fix: 'f', target: 'qa-suite-impact' }] },
    events: [
      { kind: 'agent', agent: 'qa-critic', durationMs: 60000, requestShape: 'foreground', tokens: { input: 1, cacheWrite: 10, cacheRead: 100, output: 5 } },
      { kind: 'agent', agent: 'qa-critic', durationMs: 30000, requestShape: 'background', tokens: { input: 1, cacheWrite: 0, cacheRead: 50, output: 5 } },
      { kind: 'deny', rule: 'H4', tool: 'Write', agent: 'qa-orchestrator:qa-test-author' },
    ],
  });
  const m = computeMetrics(run.runDir);
  assert.equal(m.agents.source, 'recorder');
  assert.deepEqual(m.agents.byAgent['qa-critic'], { dispatches: 2, durationMs: 90000, input: 2, cacheWrite: 10, cacheRead: 150, output: 10, total: 172 });
  assert.deepEqual(m.agents.requestShapes, { foreground: 1, background: 1 });
  assert.deepEqual(m.triage, { 'pre-existing': 1, defect: 1 });
  assert.deepEqual(m.tests.last, { passed: 3, failed: 2 });
  assert.deepEqual(m.loop.critic, [{ round: 1, verdict: 'revise', gaps: 1 }]);
  assert.equal(m.denials.length, 1);
  assert.equal(m.verdict, 'QA Failed');

  recordRun({ project: run.project, runDir: run.runDir });
  recordRun({ project: run.project, runDir: run.runDir });
  const lines = readFileSync(path.join(run.project, '.qa-runs', 'history.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'a second record of the same run replaces its line');
  const row = JSON.parse(lines[0]);
  assert.equal(row.tokens, 172);
  assert.equal(row.phasesActiveMs.PLANNING, 9 * 60000);
  const s = summarizeHistory([row, { ...row, runId: 'r2', activeMs: row.activeMs + 120000, phasesActiveMs: { PLANNING: 11 * 60000 } }]);
  assert.equal(s.runs, 2);
  assert.equal(s.medianActiveMinByPhase.PLANNING, 10);
  run.cleanup();
});

test('metrics: a second SubagentStop for the same agent replaces its first event instead of adding to it', () => {
  const ev = (agentId, output, agent = 'qa-triage') => ({ kind: 'agent', agent, agentId, durationMs: 1000, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output } });
  const run = makeRun({ events: [ev('a1', 10), ev('a2', 5, 'qa-critic'), ev('a1', 30)] });
  const m = computeMetrics(run.runDir);
  assert.equal(m.agents.totals.dispatches, 2);
  assert.equal(m.agents.byAgent['qa-triage'].output, 30, 'the later, cumulative event wins');
  assert.deepEqual(m.agents.events.map((e) => e.agentId), ['a1', 'a2'], 'kept in first-seen order');
  run.cleanup();
});

test('metrics: history says whether the run probed known drift; a probe that proved nothing is not one', () => {
  const run = makeRun();
  assert.equal(historyRow(computeMetrics(run.runDir)).driftProbed, false, 'no probe file');
  write(path.join(run.runDir, 'drift-probe.json'), { probed: false, why: 'Playwright wrote no report', entries: [] });
  assert.equal(historyRow(computeMetrics(run.runDir)).driftProbed, false);
  write(path.join(run.runDir, 'drift-probe.json'), { probed: true, entries: [{ file: 'client/e2e/a.spec.ts', status: 'passed', passed: ['t'], failed: [] }] });
  const m = computeMetrics(run.runDir);
  assert.equal(historyRow(m).driftProbed, true);
  assert.deepEqual(m.driftProbe.entries, [{ file: 'client/e2e/a.spec.ts', status: 'passed', passed: 1, failed: 0 }]);
  run.cleanup();
});

// ── memory ──────────────────────────────────────────────────────────────────
test('memory: learns cited, suggest-only lessons; a run counts once; repeats raise a knownDrift suggestion', () => {
  const run = makeRun({
    triage: [
      preExisting,
      { spec: 'client/e2e/x.spec.ts', test: 'env one', classification: 'env', evidence: ['connect ECONNREFUSED 127.0.0.1:5000'] },
      { spec: 'client/e2e/sort.spec.ts', test: 'new one', classification: 'test-bug', evidence: ['wrong selector'] },
      { spec: 'client/e2e/home.spec.ts', test: 'flaky one', classification: 'flaky-suspected', evidence: ['timeout'] },
    ],
    runners: [
      { files: ['client/e2e/home.spec.ts'], failures: [{ title: 'flaky one' }] },
      { files: ['client/e2e/home.spec.ts'], failures: [] },
    ],
    critic: { verdict: 'revise', gaps: [{ ref: 'code:App.tsx:10', problem: '/join does not exist', fix: 'use /checkout', target: 'qa-change-analyst' }] },
    events: [{ kind: 'deny', rule: 'H4', tool: 'Write', agent: 'qa-orchestrator:qa-test-author', reason: 'existed before this run; use Edit' }],
  });
  const found = lessons(run.runDir, {});
  assert.deepEqual(found.map((l) => l.type).sort(), ['author-lesson', 'critic-gap', 'env-issue', 'flaky', 'guard-denial', 'known-failure']);

  let { memory, added } = learn(emptyMemory(), 'r1', found);
  assert.equal(added, 6);
  ({ memory } = learn(memory, 'r1', found));
  const known = memory.entries.find((e) => e.type === 'known-failure');
  assert.equal(known.count, 1, 'the same run never counts twice');
  assert.equal(known.suggestion, null);
  ({ memory } = learn(memory, 'r2', found.filter((l) => l.type === 'known-failure')));
  assert.equal(memory.entries.find((e) => e.type === 'known-failure').count, 2);
  assert.match(suggestionsOf(memory)[0], /a11y\.spec\.ts.*qa\.knownDrift/);

  // Already in knownDrift → no suggestion.
  const inDrift = lessons(run.runDir, { qa: { knownDrift: [{ file: 'client/e2e/a11y.spec.ts' }] } });
  assert.deepEqual(suggestionsOf(learn(learn(emptyMemory(), 'a', inDrift).memory, 'b', inDrift).memory), []);
  // Added to knownDrift after the suggestion: the next update (a run that no longer sees it) drops the suggestion.
  const later = learn(memory, 'r3', [], { knownDrift: new Set(['client/e2e/a11y.spec.ts']) }).memory;
  assert.deepEqual(suggestionsOf(later), []);
  // Seen live: memory held the bare file name, the config the repo path; that is still the same spec.
  const bare = structuredClone(memory);
  for (const e of bare.entries) if (e.type === 'known-failure') e.file = 'a11y.spec.ts';
  assert.equal(suggestionsOf(learn(bare, 'r3', []).memory).length, 1, 'still suggested without knownDrift');
  assert.deepEqual(suggestionsOf(learn(bare, 'r3', [], { knownDrift: new Set(['client/e2e/a11y.spec.ts']) }).memory), []);
  // A test-level entry covers only its tests: another test failing in that spec is still suggested.
  const perTest = (title) => driftKeys({ qa: { knownDrift: [{ file: 'client/e2e/a11y.spec.ts', tests: [title] }] } });
  assert.deepEqual(suggestionsOf(learn(bare, 'r3', [], { knownDrift: perTest('live game') }).memory), []);
  assert.equal(suggestionsOf(learn(bare, 'r3', [], { knownDrift: perTest('cart keys') }).memory).length, 1);

  const triageHints = hintsFor(memory, 'qa-triage');
  assert.match(triageHints.text, /Unverified/);
  assert.match(triageHints.text, /7f8a6bd/);
  assert.ok(!triageHints.text.includes('/join does not exist'), 'critic gaps go to their target agent, not triage');
  assert.match(hintsFor(memory, 'qa-change-analyst').text, /\/join does not exist/);
  assert.match(hintsFor(memory, 'qa-test-author').text, /use Edit/);
  assert.deepEqual(hintsFor(memory, 'qa-intake'), { text: '', ids: [] });
  // G2 shows each hint, not a count.
  const table = usedTable(memory.entries.filter((e) => e.type === 'known-failure'));
  assert.match(table, /^\| id \| type \| subject \| summary \| seen \|/);
  assert.match(table, /\| Known failure \| client\/e2e\/a11y\.spec\.ts › .* \| 2x, last r2 \|$/m);
  assert.match(usedTable([]), /No memory hints/);
  run.cleanup();
});

// Seen live: the critic got 12 hints, all gaps from other tickets' specs, and none applied.
test('memory: a critic gap goes only to a run touching its files; a known failure in knownDrift is not handed out', () => {
  const run = makeRun({
    triage: [preExisting],
    critic: { verdict: 'revise', gaps: [{ ref: 'AC3', problem: 'the sort is untested', fix: 'add it', target: 'qa-suite-impact' }] },
  });
  write(path.join(run.runDir, 'dev-changes.diff'), '# PR #1\ndiff --git a/client/src/Cart.tsx b/client/src/Cart.tsx\n--- a/x\n+++ b/x\n');
  const gap = lessons(run.runDir, {}).find((l) => l.type === 'critic-gap');
  assert.deepEqual(gap.files, ['client/src/Cart.tsx', 'client/e2e/cart.spec.ts', 'client/e2e/sort.spec.ts']);
  const knownDrift = driftKeys({ qa: { knownDrift: [{ file: 'client/e2e/a11y.spec.ts' }] } });
  const { memory } = learn(emptyMemory(), 'r1', lessons(run.runDir, {}), { knownDrift });
  const ids = (agent, files) => hintsFor(memory, agent, { files }).ids.map((id) => memory.entries.find((e) => e.id === id).type);
  assert.deepEqual(ids('qa-critic', ['client/src/CreateGame.tsx']), [], 'another ticket\'s code: no gap');
  assert.deepEqual(ids('qa-critic', ['client/e2e/sort.spec.ts']), ['critic-gap'], 'the same spec again: the gap applies');
  assert.deepEqual(ids('qa-suite-impact', ['client/e2e/sort.spec.ts']), ['critic-gap'], 'the plan skips that known failure');
  // Entries learned before `files` was stored never go out again; they expire.
  const old = structuredClone(memory);
  for (const e of old.entries) delete e.files;
  assert.deepEqual(hintsFor(old, 'qa-critic', { files: ['client/e2e/sort.spec.ts'] }).ids, []);
  // Without files (memory.mjs show) every entry for the agent is listed.
  assert.equal(hintsFor(memory, 'qa-suite-impact').ids.length, 2);
  run.cleanup();
});

test('memory: entries not seen in the last runs expire', () => {
  const found = [{ key: 'k1', type: 'env-issue', agents: ['qa-triage'], subject: 's', summary: 'x' }];
  let { memory } = learn(emptyMemory(), 'r0', found);
  for (let i = 1; i < EXPIRE_AFTER_RUNS; i += 1) ({ memory } = learn(memory, `r${i}`, []));
  assert.equal(memory.entries.length, 1, `still inside the last ${EXPIRE_AFTER_RUNS} runs`);
  const last = learn(memory, 'r-last', []);
  assert.equal(last.memory.entries.length, 0);
  assert.equal(last.expired, 1);
});

test('memory: a known failure whose spec later runs clean is dropped; a guessed cause is not stored', () => {
  const run = makeRun({ triage: [preExisting, { ...preExisting, spec: 'client/e2e/game-keyboard.spec.ts', causeCommit: 'e4f7be5', confidence: 0.55 }] });
  const found = lessons(run.runDir);
  assert.match(found[0].summary, /cause 7f8a6bd/);
  assert.doesNotMatch(found[1].summary, /e4f7be5/, 'confidence 0.55 is a guess');
  const { memory } = learn(emptyMemory(), 'r1', found);
  // Playwright names the spec relative to its testDir; the runner's files are repo paths.
  write(path.join(run.runDir, 'runner-1.json'), { files: ['client/e2e/a11y.spec.ts', 'client/e2e/game-keyboard.spec.ts'], failures: [{ spec: 'game-keyboard.spec.ts' }] });
  assert.deepEqual(cleanSpecs(run.runDir), ['client/e2e/a11y.spec.ts']);
  const next = learn(memory, 'r2', [], { cleanSpecs: cleanSpecs(run.runDir) });
  assert.equal(next.resolved, 1);
  assert.deepEqual(next.memory.entries.map((e) => e.file), ['client/e2e/game-keyboard.spec.ts']);
  // A test-level drift entry left that test out: the spec ran clean, but the known failure didn't run.
  const knownDrift = driftKeys({ qa: { knownDrift: [{ file: 'client/e2e/a11y.spec.ts', tests: ['live game'] }] } });
  const kept = learn(memory, 'r2', [], { knownDrift, cleanSpecs: cleanSpecs(run.runDir) });
  assert.equal(kept.resolved, 0);
  assert.ok(kept.memory.entries.some((e) => e.file === 'client/e2e/a11y.spec.ts'));
  run.cleanup();
});

// Seen live: a test-level skip hid a playthrough that passed; the probe is how memory finds out.
test('memory: the drift probe resolves a healed known failure and suggests removing or narrowing the entry', () => {
  const run = makeRun({ triage: [preExisting] });
  const knownDrift = driftKeys({ qa: { knownDrift: [{ file: 'client/e2e/a11y.spec.ts', tests: ['live game'] }, { file: 'client/e2e/board.spec.ts' }] } });
  const { memory } = learn(emptyMemory(), 'r1', lessons(run.runDir), { knownDrift });
  assert.equal(memory.entries[0].inKnownDrift, true);
  rmSync(path.join(run.runDir, 'triage.json'));
  const probe = (entries) => write(path.join(run.runDir, 'drift-probe.json'), { probed: true, entries });
  probe([
    { file: 'client/e2e/a11y.spec.ts', wholeFile: false, status: 'passed', passed: ['live game'], failed: [] },
    { file: 'client/e2e/board.spec.ts', wholeFile: true, status: 'failed', passed: ['a', 'b'], failed: ['c'] },
  ]);
  const next = learn(memory, 'r2', lessons(run.runDir), { knownDrift });
  assert.equal(next.resolved, 1, 'the protected known failure is gone');
  const s = suggestionsOf(next.memory);
  assert.ok(s.some((x) => /a11y\.spec\.ts: every qa\.knownDrift test it skips passed in the drift probe of run r1 \(1\); consider removing/.test(x)), s.join('\n'));
  assert.ok(s.some((x) => /board\.spec\.ts: only 1 of its 3 tests still fail .*"tests": \["c"\]/.test(x)));
  assert.ok(!hintsFor(next.memory, 'qa-triage').text.includes('drift probe'), 'a suggestion for the human, not a hint for an agent');
  // A later probe that fails again withdraws the suggestion; an entry gone from the config drops it.
  probe([{ file: 'client/e2e/a11y.spec.ts', wholeFile: false, status: 'failed', passed: [], failed: ['live game'] }]);
  const relapse = learn(next.memory, 'r3', lessons(run.runDir), { knownDrift });
  assert.ok(!suggestionsOf(relapse.memory).some((x) => /a11y/.test(x)));
  const removed = learn(next.memory, 'r3', [], { knownDrift: driftKeys({ qa: { knownDrift: [{ file: 'client/e2e/board.spec.ts' }] } }) });
  assert.ok(!removed.memory.entries.some((e) => e.type === 'drift-probe' && /a11y/.test(e.file)));
  // A probe that didn't run teaches nothing.
  write(path.join(run.runDir, 'drift-probe.json'), { probed: false, why: 'not due', entries: [] });
  assert.ok(!lessons(run.runDir).some((l) => l.type === 'drift-probe'));
  run.cleanup();
});

// ── briefs ──────────────────────────────────────────────────────────────────
test('briefs: every template renders from the run files with no missing placeholder', () => {
  const run = makeRun({ runners: [{ status: 'completed', counts: {} }] });
  for (const agent of AGENTS) {
    const { vars } = briefVars({ runDir: run.runDir, project: run.project, agent, step: 's1', memory: emptyMemory(), pluginRoot });
    const text = render(readFileSync(path.join(pluginRoot, 'templates', 'briefs', `${agent}.md`), 'utf8'), vars);
    assert.match(text, new RegExp(`^# Brief: ${agent} · s1`));
    assert.ok(!text.includes('{{'), `${agent}: unrendered placeholder`);
  }
  assert.throws(() => render('{{nope}}', {}), /\{\{nope\}\} has no value/);
  // A fix dispatch carries its schema; a first dispatch relies on the example.
  const first = briefVars({ runDir: run.runDir, project: run.project, agent: 'qa-feedback', step: 'feedback', memory: emptyMemory(), pluginRoot }).vars.footer;
  assert.match(first, /shaped like the example/);
  assert.ok(!first.includes('"additionalProperties"'));
  for (const step of ['feedback-fix', 'feedback-fix-2']) {
    const fix = briefVars({ runDir: run.runDir, project: run.project, agent: 'qa-feedback', step, memory: emptyMemory(), pluginRoot }).vars.footer;
    assert.match(fix, /fix dispatch/);
    assert.ok(fix.includes('"required": ["suiteChanges"'), `${step}: the schema text is in the brief`);
    assert.doesNotMatch(fix, /previous handback, as saved/, 'nothing saved yet');
  }
  // Seen live: triage-fix couldn't see its first pass and dropped that pass's evidence. A fix brief
  // names the handback the recorder saved for the dispatch it fixes.
  write(path.join(run.runDir, 'outputs', 'triage.md'), '```json\n{}\n```');
  write(path.join(run.runDir, 'outputs', 'triage-fix.md'), '```json\n{}\n```');
  const footer = (step) => briefVars({ runDir: run.runDir, project: run.project, agent: 'qa-triage', step, memory: emptyMemory(), pluginRoot }).vars.footer;
  assert.ok(footer('triage-fix').includes(`as saved: \`${path.join(run.runDir, 'outputs', 'triage.md')}\``));
  assert.ok(footer('triage-fix-2').includes(`as saved: \`${path.join(run.runDir, 'outputs', 'triage-fix.md')}\``));
  assert.doesNotMatch(footer('triage'), /as saved/);
  run.cleanup();
});

test('briefs: the author gets the computed self-check and the Edit-only specs; triage gets the SHA, the runner and its hints', () => {
  const run = makeRun({ runners: [{ status: 'completed' }, { status: 'completed' }] });
  write(path.join(run.runDir, 'runner-self-1.json'), {});
  const earlier = makeRun({ triage: [preExisting] });
  const memory = learn(emptyMemory(), 'r0', lessons(earlier.runDir, {})).memory;
  earlier.cleanup();

  const author = writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-test-author', step: 'test-author', memory, pluginRoot, notes: 'Open gap: cover the Back button.' });
  const a = readFileSync(author.brief, 'utf8');
  assert.match(a, /--self-check 2 --files client\/e2e\/cart\.spec\.ts,client\/e2e\/sort\.spec\.ts/);
  assert.match(a, /Specs that existed at run start \(client\/e2e\/cart\.spec\.ts\)/);
  assert.match(a, /## Notes from the orchestrator\n\nOpen gap: cover the Back button\./);
  assert.match(author.prompt, /^Read your brief at ".*test-author\.md"/);

  const triage = writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-triage', step: 'triage', memory, pluginRoot });
  const t = readFileSync(triage.brief, 'utf8');
  assert.match(t, /abcdef1234567890/);
  assert.match(t, /runner-2\.json/);
  assert.match(t, /Hints from earlier QA runs/);
  // Every brief says the JSON must be the final message; agents with Bash also get their allowlist.
  assert.match(t, /final message must contain that block itself/);
  assert.match(t, /Bash \(checked by the guard\) allows only: git log\|show\|blame/);
  assert.equal(triage.memoryIds.length, 1);

  // The critic gets the diff; from round 2 on also the earlier rounds, never its own step's file.
  const first = readFileSync(writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-critic', step: 'critic-1', memory, pluginRoot }).brief, 'utf8');
  assert.match(first, /Dev diff: `.*dev-changes\.diff`/);
  // It reads the ticket itself, so it can catch a requirement intake missed (quality review Q5).
  assert.match(first, /Jira ticket dump[^\n]*`.*ticket\.json`/);
  // A revised intake starts from its previous output, so the AC ids stay stable.
  const intakeFirst = readFileSync(writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-intake', step: 'intake', memory, pluginRoot }).brief, 'utf8');
  assert.doesNotMatch(intakeFirst, /Your previous output/);
  write(path.join(run.runDir, 'intake.json'), { acceptanceCriteria: [] });
  const intakeRev = readFileSync(writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-intake', step: 'intake-rev1', memory, pluginRoot }).brief, 'utf8');
  assert.match(intakeRev, /Your previous output[^\n]*`.*intake\.json`/);
  assert.doesNotMatch(first, /Earlier critic rounds/);
  assert.doesNotMatch(first, /Bash \(checked by the guard\)/, 'the critic has no Bash');
  write(path.join(run.runDir, 'critic-1.json'), { verdict: 'revise', gaps: [] });
  write(path.join(run.runDir, 'critic-10.json'), { verdict: 'revise', gaps: [] });
  const later = readFileSync(writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-critic', step: 'critic-2', memory, pluginRoot }).brief, 'utf8');
  assert.match(later, /Earlier critic rounds[^\n]*critic-1\.json`, `[^`]*critic-10\.json`/);

  const index = JSON.parse(readFileSync(path.join(run.runDir, 'briefs', 'index.json'), 'utf8'));
  assert.deepEqual(index.map((b) => b.step), ['test-author', 'triage', 'critic-1', 'intake', 'intake-rev1', 'critic-2']);
  assert.throws(() => writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-nope', step: 'x', memory }), /unknown agent/);
  assert.throws(() => writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-triage', step: '../x', memory }), /plain name/);
  run.cleanup();
});

test('briefs: a re-test copies the previous verdict into this run folder, where the feedback agent may read it (H11)', () => {
  const run = makeRun({ runId: 'r2' });
  const prev = path.join(run.project, '.qa-runs', 'PROJ-9', 'r1', 'feedback.json');
  write(prev, { recommendedVerdict: 'QA Failed', acCoverage: [{ acId: 'AC1', result: 'defect' }] });
  const statePath = path.join(run.runDir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  write(statePath, { ...state, qa: { ...state.qa, retest: { previousPr: 7, previousRunId: 'r1' } } });

  const fb = writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-feedback', step: 'feedback', memory: emptyMemory(), pluginRoot });
  const copy = path.join(run.runDir, 'previous-feedback.json');
  assert.equal(readFileSync(copy, 'utf8'), readFileSync(prev, 'utf8'));
  const text = readFileSync(fb.brief, 'utf8');
  assert.ok(text.includes(copy), 'the brief points at the copy inside the run folder');
  assert.ok(!text.includes(prev), 'not at the sibling run folder');
  // Other agents don't get it, and nothing is copied for them.
  rmSync(copy);
  writeBrief({ runDir: run.runDir, project: run.project, agent: 'qa-triage', step: 'triage', memory: emptyMemory(), pluginRoot });
  assert.equal(existsSync(copy), false);
  run.cleanup();
});

// ── views and release ───────────────────────────────────────────────────────
test('views: progress.md, dashboard.html and metrics.json are rebuilt from the run files', () => {
  const run = makeRun({ triage: [preExisting], runners: [{ status: 'completed', counts: { passed: 1, failed: 1 }, durationMs: 5000 }] });
  assert.equal(refreshViews(run.runDir), true);
  const progress = readFileSync(path.join(run.runDir, 'progress.md'), 'utf8');
  assert.match(progress, /phase \*\*AWAITING_HUMAN_REVIEW\*\*/);
  assert.match(progress, /\*\*triage\*\*\n- pre-existing 1/);
  assert.match(progress, /waiting for a human 9m, interrupted 1h 59m/);
  const html = readFileSync(path.join(run.runDir, 'dashboard.html'), 'utf8');
  assert.ok(!html.includes('http-equiv="refresh"'), 'a finished run stops reloading');
  assert.ok(existsSync(path.join(run.runDir, 'metrics.json')));

  const state = JSON.parse(readFileSync(path.join(run.runDir, 'state.json'), 'utf8'));
  write(path.join(run.runDir, 'state.json'), { ...state, phase: 'EXECUTING' });
  refreshViews(run.runDir);
  assert.match(readFileSync(path.join(run.runDir, 'dashboard.html'), 'utf8'), /http-equiv="refresh"/);
  assert.equal(refreshViews(path.join(run.root, 'missing')), false, 'a broken view never throws');
  run.cleanup();
});

test('release: records the run in history.jsonl and its lessons in memory.json', () => {
  const run = makeRun({ triage: [preExisting] });
  write(path.join(run.runDir, 'briefs', 'index.json'), [{ step: 'triage', agent: 'qa-triage' }]);
  // The report embeds the same traces, so test-results goes; without its report it stays.
  write(path.join(run.runDir, 'test-results-1', 'trace.zip'), 'x');
  write(path.join(run.runDir, 'playwright-report-1', 'index.html'), 'x');
  write(path.join(run.runDir, 'test-results-self-1', 'trace.zip'), 'x');
  const out = release({ runner: () => ({ status: 0, stdout: '', stderr: '' }), project: run.project, runDir: run.runDir, teardown: false });
  assert.equal(out.ok, true);
  assert.deepEqual(out.tidy.removed, ['test-results-1']);
  assert.equal(existsSync(path.join(run.runDir, 'playwright-report-1', 'index.html')), true);
  assert.equal(existsSync(path.join(run.runDir, 'test-results-self-1')), true);
  assert.equal(typeof out.history.activeMin, 'number');
  assert.equal(out.memory.added, 1);
  assert.ok(existsSync(path.join(run.project, '.qa-runs', 'history.jsonl')));
  assert.ok(existsSync(path.join(run.project, '.qa-runs', 'MEMORY.md')));
  assert.equal(loadMemory(run.project).entries[0].lastSeen, 'r1');
  // Learning the same run again (a second release) changes nothing.
  assert.equal(updateFromRun({ project: run.project, runDir: run.runDir }).added, 0);
  run.cleanup();

  // A run stopped before any agent ran (no brief) leaves no history line and no memory.
  const stopped = makeRun();
  const skipped = release({ runner: () => ({ status: 0, stdout: '', stderr: '' }), project: stopped.project, runDir: stopped.runDir, forget: true });
  assert.equal(skipped.history.skipped, 'no agent ran');
  assert.equal(existsSync(path.join(stopped.project, '.qa-runs', 'history.jsonl')), false);
  stopped.cleanup();
});
