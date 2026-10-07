// Tests for run-playwright.mjs and preflight.mjs with injected runners.
// Real integration (Docker, Playwright, GitHub) is verified in build steps 3–4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mustRun, realRunner } from '../lib/common.mjs';
import { buildCommand, driftGrep, probeDrift, probeDue, probeGrep, probeResults, runPlaywright, summarizeReport, toFilter } from '../run-playwright.mjs';
import { Breaker, backgroundJobBlock, cleanup, devBranchMatches, pidAlive, prune, readSha, release, resume, slugFrom, stack, start, status } from '../preflight.mjs';

const config = {
  jira: { projectKey: 'LN', cloudId: 'cloud-1', statuses: { ready: 'Ready for QA', inQa: 'In QA', review: 'QA Review' }, allowedTransitionIds: ['31', '41'] },
  git: { integrationBranch: 'demo/stage', devBranchKeyPattern: '(^|/){KEY}(-|$)', protectedBranches: ['main', 'stage', 'demo/stage'] },
  stack: { composeFile: 'docker-compose.qa.yml', project: 'myapp-qa', health: ['http://localhost:8080/health', 'http://localhost:3000/'], healthTimeoutSec: 30,
    shaCheck: { api: 'http://localhost:8080/health#sha', web: 'http://localhost:3000/#meta:app-sha' } },
  qa: { testDir: 'client/e2e', playwrightConfig: 'client/e2e/playwright.config.ts', baseUrl: 'http://localhost:3000', apiUrl: 'http://localhost:8080',
    conventionsDocs: ['client/e2e/cart.spec.ts', 'docs/missing-conventions.md'] },
};

// ── run-playwright ──────────────────────────────────────────────────────────
test('runner: command forces our outputs, no retries, traces on failure, never opens the report', () => {
  const c = buildCommand({ config, runDir: '/r', attempt: 2, files: ['client/e2e/a.spec.ts'], worktree: '/w', testedSha: 'abc', cli: '/w/node_modules/@playwright/test/cli.js', baseEnv: {} });
  assert.deepEqual(c.args.slice(1, 4), ['test', '--config', 'client/e2e/playwright.config.ts']);
  for (const a of ['--reporter=json,html', '--trace=retain-on-failure', '--retries=0', 'client/e2e/a.spec.ts']) assert.ok(c.args.includes(a), a);
  assert.ok(c.args.some((a) => a.startsWith('--output=') && a.includes('test-results-2')));
  assert.equal(c.env.PLAYWRIGHT_HTML_OPEN, 'never');
  assert.equal(c.env.BASE_URL, 'http://localhost:3000');
  assert.equal(c.env.API_URL, 'http://localhost:8080');
  assert.equal(c.env.CI, '1');
  assert.match(c.env.PLAYWRIGHT_JSON_OUTPUT_NAME, /runner-2\.raw\.json$/);
});

test('runner: qa.env passes project-specific variables; they cannot override the runner\'s own', () => {
  const withEnv = { ...config, qa: { ...config.qa, env: { VITE_API_URL: 'http://localhost:8080', BASE_URL: 'http://evil', PLAYWRIGHT_HTML_OPEN: 'always' } } };
  const c = buildCommand({ config: withEnv, runDir: '/r', attempt: 1, files: ['a'], worktree: '/w', cli: 'cli.js', baseEnv: {} });
  assert.equal(c.env.VITE_API_URL, 'http://localhost:8080');
  assert.equal(c.env.BASE_URL, 'http://localhost:3000');
  assert.equal(c.env.PLAYWRIGHT_HTML_OPEN, 'never');
});

const report = (tests, errors = []) => ({
  suites: [{ title: 'cart.spec.ts', file: 'cart.spec.ts', specs: [], suites: [{
    title: 'cart', specs: tests.map(([title, status, extra = {}]) => ({
      title, file: 'cart.spec.ts', line: 7,
      tests: [{ projectName: 'chromium', status, results: [{ status: status === 'unexpected' ? 'failed' : 'passed', ...extra }] }],
    })),
  }] }],
  errors,
});

test('runner: file filters are always forward-slash (backslash filters select 0 tests on Windows)', () => {
  assert.equal(toFilter('client\\e2e\\api\\'), 'client/e2e/api/');
  assert.equal(toFilter('client/e2e/home.spec.ts'), 'client/e2e/home.spec.ts');
});

test('runner: summary derived from the Playwright report, failures carry evidence paths', () => {
  const r = summarizeReport(report([
    ['sorts by wins', 'expected'],
    ['header says Rating', 'unexpected', { error: { message: '\u001b[31mExpected "Rating"\u001b[39m got "ELO"' },
      attachments: [{ name: 'trace', path: '/r/test-results-1/trace.zip' }, { name: 'screenshot', path: '/r/s.png' }] }],
    ['old', 'skipped'],
    ['retry', 'flaky'],
  ]), { exitCode: 1 });
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.counts, { passed: 1, failed: 1, flaky: 1, skipped: 1, total: 4 });
  assert.equal(r.failures[0].title, 'cart › header says Rating');
  assert.equal(r.failures[0].error, 'Expected "Rating" got "ELO"');
  assert.equal(r.failures[0].tracePath, '/r/test-results-1/trace.zip');
});

test('runner: zero tests, only skipped, collection errors or a crash are "invalid", never passed', () => {
  assert.equal(summarizeReport(report([]), { exitCode: 0 }).status, 'invalid');
  assert.equal(summarizeReport(report([['x', 'skipped']]), { exitCode: 0 }).status, 'invalid');
  assert.equal(summarizeReport(report([['x', 'expected']], [{ message: 'SyntaxError in a.spec.ts' }]), { exitCode: 1 }).status, 'invalid');
  assert.equal(summarizeReport(report([['x', 'expected']]), { exitCode: 1 }).status, 'invalid');
  assert.equal(summarizeReport(report([['x', 'expected']]), { exitCode: 0 }).status, 'completed');
});

test('runner: a full run reports the known-drift specs it left out; a targeted rerun does not', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-run-'));
  const worktree = path.join(root, 'wt');
  const pw = path.join(worktree, 'node_modules', '@playwright', 'test');
  mkdirSync(pw, { recursive: true });
  writeFileSync(path.join(worktree, 'package.json'), '{}');
  writeFileSync(path.join(pw, 'package.json'), '{"name":"@playwright/test"}');
  writeFileSync(path.join(pw, 'cli.js'), '');
  const skipped = [{ file: 'client/e2e/a11y.spec.ts', reason: 'drift', since: '7f8a6bd', wholeFile: true, tests: ['a', 'b'] }];
  const plan = { runSet: ['client/e2e/home.spec.ts'], knownDriftSkipped: skipped };
  const calls = [];
  const runner = (cmd, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; };
  const args = { runner, config, plan, active: { worktree, testedSha: 'abc' }, runDir: root };
  const full = runPlaywright({ ...args, attempt: 1 });
  assert.deepEqual(full.files, ['client/e2e/home.spec.ts']);
  assert.deepEqual(full.knownDriftSkipped, skipped);
  assert.ok(!calls[0].includes('client/e2e/a11y.spec.ts'));
  assert.ok(!calls[0].includes('--grep-invert'), 'a whole-file skip needs no grep');
  assert.deepEqual(runPlaywright({ ...args, attempt: 2, files: ['client/e2e/home.spec.ts'] }).knownDriftSkipped, []);
  rmSync(root, { recursive: true, force: true });
});

// Seen live: skipping a11y as a whole dropped two healthy tests with its drifting playthrough.
test('runner: test-level known drift runs the spec and leaves out only those tests, by file-scoped --grep-invert', () => {
  const entries = [{ file: 'client/e2e/a11y.spec.ts', wholeFile: false, tests: ['live game (full) a11y', 'b'] }, { file: 'client/e2e/x.spec.ts', wholeFile: true, tests: ['a'] }];
  const { pattern, skipped } = driftGrep(entries, ['client/e2e/a11y.spec.ts']);
  assert.equal(pattern, String.raw`(?:^|[ /])a11y\.spec\.ts .*live game \(full\) a11y|(?:^|[ /])a11y\.spec\.ts .*b`);
  assert.deepEqual(skipped, [entries[0]]);
  const re = new RegExp(pattern);
  assert.ok(re.test('chromium a11y.spec.ts live game (full) a11y'));
  assert.ok(!re.test('chromium cart.spec.ts live game (full) a11y'), 'the same title in another spec still runs');
  assert.equal(driftGrep(entries, ['client/e2e/']).skipped.length, 1, 'a run-set directory holds the spec');
  assert.deepEqual(driftGrep(entries, ['client/e2e/home.spec.ts']), { pattern: null, skipped: [] });
  const c = buildCommand({ config, runDir: '/r', attempt: 1, files: ['client/e2e/a11y.spec.ts'], worktree: '/w', cli: 'cli.js', grepInvert: pattern, baseEnv: {} });
  assert.deepEqual(c.args.slice(-3), ['--grep-invert', pattern, 'client/e2e/a11y.spec.ts']);
});

test('drift probe: due every Nth run, counted from the last run that probed; 0 never', () => {
  const rows = (...probed) => probed.map((p, i) => ({ runId: `r${i}`, driftProbed: p }));
  assert.equal(probeDue([], 5, 'now').due, true, 'no run probed yet');
  assert.equal(probeDue(rows(true, false, false), 5, 'now').due, false);
  assert.equal(probeDue(rows(true, false, false, false, false), 5, 'now').due, true, 'four runs since the probe');
  assert.equal(probeDue(rows(false, false), 5, 'now').due, true, 'a skipped probe waits for the next run');
  assert.equal(probeDue(rows(true), 1, 'now').due, true);
  assert.equal(probeDue([], 0, 'now').due, false);
  assert.equal(probeDue(rows(true, false, false, false, false), 5, 'r4').due, false, 'this run itself does not count');
});

test('drift probe: one --grep selects every skipped test, file-scoped; results per entry', () => {
  const entries = [
    { file: 'client/e2e/a11y.spec.ts', wholeFile: false, tests: ['live game (full) a11y'] },
    { file: 'client/e2e/layout.spec.ts', wholeFile: true, tests: ['geometry'] },
    { file: 'client/e2e/gone.spec.ts', wholeFile: false, tests: ['renamed since'] },
  ];
  const re = new RegExp(probeGrep(entries));
  assert.ok(re.test('chromium a11y.spec.ts live game (full) a11y'));
  assert.ok(!re.test('chromium a11y.spec.ts cart keys'), 'the healthy tests in that spec stay out');
  assert.ok(re.test('chromium layout.spec.ts board › geometry'), 'a whole-file entry selects its whole spec');
  const spec = (file, title, status) => ({ title, file, tests: [{ status }] });
  const results = probeResults({ suites: [{ specs: [
    spec('a11y.spec.ts', 'live game (full) a11y', 'expected'),
    spec('layout.spec.ts', 'geometry', 'unexpected'), spec('layout.spec.ts', 'corners', 'expected'),
  ] }] }, entries);
  assert.deepEqual(results.map((r) => [r.file, r.status, r.passed, r.failed]), [
    ['client/e2e/a11y.spec.ts', 'passed', ['live game (full) a11y'], []],
    ['client/e2e/layout.spec.ts', 'failed', ['corners'], ['geometry']],
    ['client/e2e/gone.spec.ts', 'no-tests', [], []],
  ]);
});

test('drift probe: runs only when due and something was skipped, in its own output names', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-run-'));
  const worktree = path.join(root, 'wt');
  const pw = path.join(worktree, 'node_modules', '@playwright', 'test');
  mkdirSync(pw, { recursive: true });
  writeFileSync(path.join(worktree, 'package.json'), '{}');
  writeFileSync(path.join(pw, 'package.json'), '{"name":"@playwright/test"}');
  writeFileSync(path.join(pw, 'cli.js'), '');
  const calls = [];
  let report = null;
  const runner = (cmd, args, opts) => {
    calls.push({ args, env: opts.env });
    if (report) writeFileSync(opts.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report));
    return { status: report ? 0 : 1, stdout: '', stderr: report ? '' : 'browser crashed' };
  };
  const plan = { knownDriftSkipped: [{ file: 'client/e2e/a11y.spec.ts', wholeFile: false, tests: ['playthrough'] }] };
  const args = { runner, config: { ...config, qa: { ...config.qa, driftProbeEvery: 5 } }, active: { runId: 'now', worktree, testedSha: 'abc' }, runDir: root, firstRun: { status: 'completed' } };
  assert.deepEqual(probeDrift({ ...args, plan: { knownDriftSkipped: [] } }), { probed: false, why: 'this run skipped no known drift', entries: [] });
  assert.equal(probeDrift({ ...args, plan, history: [{ runId: 'r0', driftProbed: true }] }).probed, false);
  assert.equal(probeDrift({ ...args, plan, firstRun: { status: 'invalid' } }).probed, false, 'an invalid run vouches for nothing');
  assert.equal(calls.length, 0);
  // A probe that proves nothing (no report, or none of its tests ran) doesn't count as one.
  const crashed = probeDrift({ ...args, plan });
  assert.deepEqual([crashed.probed, crashed.why], [false, 'Playwright wrote no report (exit 1): browser crashed']);
  assert.ok(calls[0].args.includes('--grep') && calls[0].args.at(-1) === 'client/e2e/a11y.spec.ts');
  assert.ok(calls[0].args.some((a) => a.includes('test-results-drift')));
  assert.match(calls[0].env.PLAYWRIGHT_JSON_OUTPUT_NAME, /drift-probe\.raw\.json$/, 'never a runner-<n> file');
  report = { suites: [{ specs: [{ title: 'other', file: 'a11y.spec.ts', tests: [{ status: 'expected' }] }] }] };
  assert.equal(probeDrift({ ...args, plan }).probed, false);
  report = { suites: [{ specs: [{ title: 'playthrough', file: 'a11y.spec.ts', tests: [{ status: 'expected' }] }] }] };
  const out = probeDrift({ ...args, plan });
  assert.equal(out.probed, true);
  assert.deepEqual(out.entries.map((e) => [e.status, e.passed]), [['passed', ['playthrough']]]);
  rmSync(root, { recursive: true, force: true });
});

// ── preflight helpers ───────────────────────────────────────────────────────
test('preflight: dev branches are matched by ticket key; slug comes from the dev branch', () => {
  const p = config.git.devBranchKeyPattern;
  assert.ok(devBranchMatches(p, 'PROJ-1', 'feature/PROJ-1-cart-sort'));
  assert.ok(devBranchMatches(p, 'PROJ-1', 'PROJ-1'));
  assert.ok(!devBranchMatches(p, 'PROJ-1', 'feature/PROJ-12-other'));
  assert.ok(!devBranchMatches(p, 'PROJ-1', 'feature/xPROJ-1-x'));
  assert.equal(slugFrom('feature/PROJ-1-Cart_Sort', 'PROJ-1'), 'cart-sort');
  assert.equal(slugFrom('PROJ-1', 'PROJ-1'), 'qa');
});

// A project repo with a bare "origin" holding demo/stage.
function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-pre-'));
  const origin = path.join(root, 'origin.git');
  const dir = path.join(root, 'webapp');
  const git = (cwd, ...a) => mustRun(realRunner, 'git', ['-C', cwd, ...a]);
  mkdirSync(dir);
  mustRun(realRunner, 'git', ['init', '-q', '--bare', origin]);
  git(dir, 'init', '-q', '-b', 'demo/stage');
  git(dir, 'config', 'user.name', 'QA Test');
  git(dir, 'config', 'user.email', 'qa@example.test');
  mkdirSync(path.join(dir, 'client', 'e2e'), { recursive: true });
  mkdirSync(path.join(dir, '.qa'));
  writeFileSync(path.join(dir, 'client/e2e/cart.spec.ts'), 'expect(h).toBe("ELO"); expect(r).toBeTruthy();');
  writeFileSync(path.join(dir, '.qa/config.json'), JSON.stringify(config));
  writeFileSync(path.join(dir, '.gitignore'), '.qa-runs/\n.qa-worktrees/\nnode_modules/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'PROJ-1 merged');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', 'origin', 'demo/stage');
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  return { root, dir, head, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const ghRunner = (prs) => (cmd, args, opts) => {
  if (cmd === 'gh' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(prs), stderr: '' };
  if (cmd === 'gh' && args[1] === 'diff') return { status: 0, stdout: `diff --git a/x b/x\n+change for #${args[2]}\n`, stderr: '' };
  return realRunner(cmd, args, opts);
};

test('preflight start: finds merged dev work, cuts qa/<KEY>-<slug> at the tested SHA, switches the guard on', () => {
  const p = project();
  const prs = [
    { number: 131, headRefName: 'feature/PROJ-1-cart-sort', mergeCommit: { oid: p.head }, title: 'Cart sort', url: 'u' },
    { number: 140, headRefName: 'feature/PROJ-12-unrelated', mergeCommit: { oid: p.head }, title: 'x', url: 'u' },
  ];
  const out = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-1', sessionId: 'sess-A' });
  assert.equal(out.qaBranch, 'qa/PROJ-1-cart-sort');
  assert.equal(out.testedSha, p.head);
  assert.deepEqual(out.devChanges.map((d) => d.pr), [131]);
  const active = JSON.parse(readFileSync(path.join(p.dir, '.qa-runs', 'active.json'), 'utf8'));
  assert.equal(active.sessionId, 'sess-A');
  assert.equal(mustRun(realRunner, 'git', ['-C', out.worktree, 'rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'qa/PROJ-1-cart-sort');
  const baseline = JSON.parse(readFileSync(path.join(out.runDir, 'suite-baseline.json'), 'utf8'));
  assert.equal(baseline.files['client/e2e/cart.spec.ts'].expects, 2);
  assert.match(readFileSync(path.join(out.runDir, 'dev-changes.diff'), 'utf8'), /change for #131/);
  assert.equal(JSON.parse(readFileSync(path.join(out.runDir, 'state.json'), 'utf8')).tested.sha, p.head);
  // Conventions docs resolve inside the worktree; a missing one is only a warning.
  assert.deepEqual(out.conventionsDocs, [path.join(out.worktree, 'client/e2e/cart.spec.ts')]);
  assert.deepEqual(out.warnings, ['qa.conventionsDocs: docs/missing-conventions.md not found at the tested commit']);

  // A second run while this one holds the lock is refused.
  assert.throws(() => start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-2', sessionId: 'sess-B' }), /already in progress/);
  assert.equal(status({ project: p.dir, key: 'PROJ-1' }).latest.phase, 'PREFLIGHT');

  // Release keeps the run "closed" so the guard still protects the G4 decisions…
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, teardown: false });
  assert.equal(existsSync(path.join(p.dir, '.qa-runs', '.lock')), false);
  assert.equal(JSON.parse(readFileSync(path.join(p.dir, '.qa-runs', 'active.json'), 'utf8')).closed, true);
  // …and --forget switches it off completely.
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, forget: true });
  assert.equal(existsSync(path.join(p.dir, '.qa-runs', 'active.json')), false);
  p.cleanup();
});

test('preflight start: no merged dev PR for the key → BLOCKED_NOT_INTEGRATED and the lock is released', () => {
  const p = project();
  assert.throws(() => start({ runner: ghRunner([{ number: 9, headRefName: 'feature/PROJ-7-x', mergeCommit: { oid: p.head } }]), project: p.dir, key: 'PROJ-1', sessionId: 's' }),
    (err) => err instanceof Breaker && err.phase === 'BLOCKED_NOT_INTEGRATED');
  assert.equal(existsSync(path.join(p.dir, '.qa-runs', '.lock')), false);
  assert.throws(() => start({ runner: ghRunner([]), project: p.dir, key: 'PROJ-1', sessionId: undefined }), /CLAUDE_CODE_SESSION_ID/);
  p.cleanup();
});

test('preflight start: an incomplete .qa/config.json is refused before the lock, naming what is missing', () => {
  const p = project();
  writeFileSync(path.join(p.dir, '.qa/config.json'), JSON.stringify({ ...config, jira: { projectKey: 'LN', allowedTransitionIds: ['<id>'] } }));
  assert.throws(() => start({ runner: ghRunner([]), project: p.dir, key: 'PROJ-1', sessionId: 's', noDevCheck: true }),
    (err) => /jira\.cloudId is missing/.test(err.message) && /jira\.statuses\.inQa is missing/.test(err.message)
      && /allowedTransitionIds must be Jira transition ids/.test(err.message) && /qa-orchestrator:setup/.test(err.message));
  assert.equal(existsSync(path.join(p.dir, '.qa-runs', '.lock')), false);
  p.cleanup();
});

test('preflight: a background job is refused unless the repo sets worktree.bgIsolation to "none"', () => {
  const p = project();
  const home = path.join(p.root, 'home');
  const settings = (file, value) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ worktree: { bgIsolation: value } }));
  };
  const job = { CLAUDE_JOB_DIR: path.join(p.root, 'job') };
  assert.equal(backgroundJobBlock({ project: p.dir, env: {}, home }), null, 'an interactive session is never refused');
  const err = backgroundJobBlock({ project: p.dir, env: job, home });
  assert.ok(err instanceof Breaker && err.phase === 'BLOCKED_BACKGROUND');
  assert.match(err.message, /interactive session/);
  assert.match(err.message, /"bgIsolation": "none"/);
  settings(path.join(home, '.claude', 'settings.json'), 'none');
  assert.equal(backgroundJobBlock({ project: p.dir, env: job, home }), null, 'user settings allow it');
  // The more specific file wins: a project value overrides the user's.
  settings(path.join(p.dir, '.claude', 'settings.json'), 'worktree');
  assert.ok(backgroundJobBlock({ project: p.dir, env: job, home }));
  settings(path.join(p.dir, '.claude', 'settings.local.json'), 'none');
  assert.equal(backgroundJobBlock({ project: p.dir, env: job, home }), null);
  p.cleanup();
});

test('preflight CLI: start in a background job exits 3 BLOCKED_BACKGROUND and creates nothing', () => {
  const p = project();
  const script = path.join(import.meta.dirname, '..', 'preflight.mjs');
  const r = spawnSync(process.execPath, [script, 'start', '--project', p.dir, '--key', 'PROJ-1'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_JOB_DIR: path.join(p.root, 'job'), CLAUDE_CODE_SESSION_ID: 's', USERPROFILE: p.root, HOME: p.root },
  });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(JSON.parse(r.stdout).phase, 'BLOCKED_BACKGROUND');
  assert.equal(existsSync(path.join(p.dir, '.qa-runs')), false);
  assert.equal(existsSync(path.join(p.dir, '.qa-worktrees')), false);
  p.cleanup();
});

test('preflight start --no-dev-check: smoke run of the QA setup without a merged dev PR', () => {
  const p = project();
  const calls = [];
  const runner = (cmd, args, opts) => { calls.push(cmd); return ghRunner([])(cmd, args, opts); };
  const out = start({ runner, project: p.dir, key: 'PROJ-0', sessionId: 's', noDevCheck: true });
  assert.match(out.qaBranch, /^qa\/PROJ-0-smoke-[0-9a-f]{4}$/);
  assert.equal(out.testedSha, p.head);
  assert.deepEqual(out.devChanges, []);
  assert.ok(!calls.includes('gh'), 'no GitHub lookup in smoke mode');
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, forget: true });
  p.cleanup();
});

test('preflight start: records whether the known-drift probe is due, so a run that is not launches nothing', () => {
  const p = project();
  const historyFile = path.join(p.dir, '.qa-runs', 'history.jsonl');
  const first = start({ runner: ghRunner([]), project: p.dir, key: 'PROJ-0', sessionId: 's', noDevCheck: true });
  assert.equal(first.driftProbe.due, true, 'no earlier run probed');
  assert.deepEqual(JSON.parse(readFileSync(path.join(first.runDir, 'state.json'), 'utf8')).driftProbe, first.driftProbe);
  release({ runner: realRunner, project: p.dir, runDir: first.runDir, forget: true });
  // Seen live: the run right after a probed one isn't due.
  writeFileSync(historyFile, `${JSON.stringify({ runId: 'r0', driftProbed: true })}\n`);
  const next = start({ runner: ghRunner([]), project: p.dir, key: 'PROJ-0', sessionId: 's', noDevCheck: true });
  assert.equal(next.driftProbe.due, false);
  assert.match(next.driftProbe.why, /0 run\(s\) ago/);
  release({ runner: realRunner, project: p.dir, runDir: next.runDir, forget: true });
  p.cleanup();
});

test('preflight cleanup: removes a worktree holding a dangling workspace link, prunes, deletes an unpushed branch', () => {
  const p = project();
  const out = start({ runner: ghRunner([]), project: p.dir, key: 'PROJ-0', sessionId: 's', noDevCheck: true });
  // Reproduce the dry-run failure: node_modules/<pkg> → the worktree's own client/, which is then gone.
  const target = path.join(out.worktree, 'client-pkg');
  mkdirSync(target);
  mkdirSync(path.join(out.worktree, 'node_modules'), { recursive: true });
  symlinkSync(target, path.join(out.worktree, 'node_modules', 'webapp'), 'junction');
  rmSync(target, { recursive: true, force: true });

  assert.throws(() => cleanup({ runner: realRunner, project: p.dir, runDir: out.runDir }), /release it first/);
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, forget: true });
  const r = cleanup({ runner: realRunner, project: p.dir, runDir: out.runDir, deleteBranch: true });
  assert.equal(r.branchDeleted, true);
  assert.equal(existsSync(out.worktree), false);
  assert.equal(mustRun(realRunner, 'git', ['-C', p.dir, 'worktree', 'list']).trim().split('\n').length, 1);
  assert.notEqual(realRunner('git', ['-C', p.dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${out.qaBranch}`]).status, 0);
  p.cleanup();
});

test('preflight cleanup: a pushed qa branch (backing a QA PR) is never deleted', () => {
  const p = project();
  const out = start({ runner: ghRunner([]), project: p.dir, key: 'PROJ-0', sessionId: 's', noDevCheck: true });
  mustRun(realRunner, 'git', ['-C', out.worktree, 'push', '-q', 'origin', out.qaBranch]);
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, forget: true });
  assert.throws(() => cleanup({ runner: realRunner, project: p.dir, runDir: out.runDir, deleteBranch: true }), /exists on origin/);
  p.cleanup();
});

test('preflight resume --takeover: an interrupted run (usage limit mid-step) is recoverable, finished runs are not', () => {
  const p = project();
  const prs = [{ number: 132, headRefName: 'feature/PROJ-4-cart-sort', mergeCommit: { oid: p.head }, title: 't', url: 'u' }];
  const out = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-4', sessionId: 'dead-session' });
  const stateFile = path.join(out.runDir, 'state.json');
  const setPhase = (phase) => writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), phase }));
  setPhase('UNDERSTANDING'); // cut off mid-step; the lock still names the dead session

  assert.throws(() => resume({ project: p.dir, key: 'PROJ-4', sessionId: 'new' }), /--takeover/);
  const r = resume({ project: p.dir, key: 'PROJ-4', sessionId: 'new', takeover: true });
  assert.equal(r.previousSession, 'dead-session');
  assert.equal(r.phase, 'UNDERSTANDING');
  assert.equal(JSON.parse(readFileSync(path.join(p.dir, '.qa-runs', 'active.json'), 'utf8')).sessionId, 'new');
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).timeline.at(-1).step, 'takeover');

  setPhase('AWAITING_HUMAN_REVIEW');
  assert.throws(() => resume({ project: p.dir, key: 'PROJ-4', sessionId: 'newer', takeover: true }), /finished/);
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, forget: true });
  p.cleanup();
});

test('preflight: a run whose Claude process is gone resumes at its phase without --takeover, with its finished outputs', () => {
  const p = project();
  const prs = [{ number: 136, headRefName: 'feature/PROJ-5-join-invite-links', mergeCommit: { oid: p.head }, title: 't', url: 'u' }];
  const out = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-5', sessionId: 'old', ownerPid: 4242 });
  const stateFile = path.join(out.runDir, 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  // Cut off in PLANNING (usage limit): both fan-out outputs saved, the critic not yet run.
  state.phase = 'PLANNING';
  state.timeline.push({ step: 'phase:PLANNING' }, { step: 'suite-impact', outcome: 'ok' }, { step: 'change-analyst', outcome: 'ok' }, { step: 'merge-plan', outcome: 'ok' });
  writeFileSync(stateFile, JSON.stringify(state));
  for (const f of ['intake.json', 'suite-impact.json', 'change-analyst.json', 'plan.json', 'runner-self-1.raw.json']) writeFileSync(path.join(out.runDir, f), '{}');

  const aliveOwner = (pid) => pid === 4242;
  assert.equal(status({ project: p.dir, key: 'PROJ-5', alive: aliveOwner }).lock.ownerAlive, true);
  assert.throws(() => resume({ project: p.dir, key: 'PROJ-5', sessionId: 'new', ownerPid: 5555, alive: aliveOwner }), /--takeover/);
  // A live process may host other sessions: the same pid in a new session still needs --takeover.
  assert.throws(() => resume({ project: p.dir, key: 'PROJ-5', sessionId: 'new', ownerPid: 4242, alive: aliveOwner }), /--takeover/);

  const deadOwner = () => false;
  assert.equal(status({ project: p.dir, key: 'PROJ-5', alive: deadOwner }).lock.ownerAlive, false);
  const r = resume({ project: p.dir, key: 'PROJ-5', sessionId: 'new', ownerPid: 5555, alive: deadOwner });
  assert.equal(r.phase, 'PLANNING');
  assert.equal(r.ownerGone, true);
  assert.equal(r.takeover, true);
  assert.deepEqual(r.outputs, ['change-analyst.json', 'intake.json', 'plan.json', 'suite-impact.json']);
  assert.deepEqual(r.stepsInPhase.map((s) => s.step), ['suite-impact', 'change-analyst', 'merge-plan']);
  assert.equal(JSON.parse(readFileSync(path.join(p.dir, '.qa-runs', '.lock'), 'utf8')).claudePid, 5555);
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, forget: true });
  p.cleanup();
});

test('pidAlive: this process is alive, an exited one is not, a missing pid is unknown', () => {
  assert.equal(pidAlive(process.pid), true);
  const exited = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.equal(pidAlive(exited), false);
  assert.equal(pidAlive(null), null);
});

// ── Re-test: a ticket comes back to QA after a failed verdict ──────────────
const git = (cwd, ...a) => mustRun(realRunner, 'git', ['-C', cwd, ...a]);
const QA = 'qa/PROJ-5-join-invite-links';

// origin has demo/stage plus a QA branch with one QA test; demo/stage then gets a dev fix.
function retestProject({ qaFile = 'client/e2e/checkout.spec.ts', qaContent = 'expect(code).toBe("ABC123");', devFile = 'client/src/lib/roomCode.ts', devContent = 'export const fixed = true;' } = {}) {
  const p = project();
  git(p.dir, 'checkout', '-q', '-b', QA);
  mkdirSync(path.dirname(path.join(p.dir, qaFile)), { recursive: true });
  writeFileSync(path.join(p.dir, qaFile), qaContent);
  git(p.dir, 'add', '-A');
  git(p.dir, 'commit', '-q', '-m', 'test(qa): PROJ-5');
  git(p.dir, 'push', '-q', 'origin', QA);
  git(p.dir, 'checkout', '-q', 'demo/stage');
  mkdirSync(path.dirname(path.join(p.dir, devFile)), { recursive: true });
  writeFileSync(path.join(p.dir, devFile), devContent);
  git(p.dir, 'add', '-A');
  git(p.dir, 'commit', '-q', '-m', 'fix(join): PROJ-5 invite links');
  git(p.dir, 'push', '-q', 'origin', 'demo/stage');
  return { ...p, fixSha: git(p.dir, 'rev-parse', 'HEAD').trim() };
}

// Dev PRs as gh lists them (newest first): the fix PR uses a DIFFERENT branch name than the original.
const retestRunner = ({ fixSha, openPrs = [{ number: 136, url: 'https://github.com/o/r/pull/136', isDraft: true, headRefName: QA }] }) => (cmd, args, opts) => {
  if (cmd === 'gh' && args[1] === 'list' && args.includes('merged')) {
    return { status: 0, stdout: JSON.stringify([
      { number: 137, headRefName: 'feature/PROJ-5-fix-invite-links', mergeCommit: { oid: fixSha }, title: 'fix', url: 'u' },
      { number: 135, headRefName: 'feature/PROJ-5-join-invite-links', mergeCommit: { oid: fixSha }, title: 'feat', url: 'u' },
    ]), stderr: '' };
  }
  if (cmd === 'gh' && args[1] === 'list' && args.includes('open')) return { status: 0, stdout: JSON.stringify(openPrs), stderr: '' };
  if (cmd === 'gh' && args[1] === 'diff') return { status: 0, stdout: '+fix\n', stderr: '' };
  return realRunner(cmd, args, opts);
};

test('re-test: the open QA branch is reused, the dev fix merged in, earlier QA tests become "existing"', () => {
  const p = retestProject();
  // Earlier runs: the delivered one (on the QA branch) and a later abandoned one (another branch).
  const mkRun = (id, branch, phase) => {
    mkdirSync(path.join(p.dir, '.qa-runs', 'PROJ-5', id), { recursive: true });
    writeFileSync(path.join(p.dir, '.qa-runs', 'PROJ-5', id, 'state.json'), JSON.stringify({ phase, qa: { branch } }));
  };
  mkRun('20260925-0820-aaaa', QA, 'AWAITING_HUMAN_REVIEW');
  mkRun('20260925-1501-bbbb', 'qa/PROJ-5-fix-invite-links', 'STOPPED');
  const out = start({ runner: retestRunner(p), project: p.dir, key: 'PROJ-5', sessionId: 's' });
  assert.equal(out.qaBranch, QA);
  assert.equal(out.retest.previousPr, 136);
  assert.equal(out.retest.previousRunId, '20260925-0820-aaaa', 'compares against the delivered run, not the abandoned one');
  assert.ok(existsSync(path.join(out.worktree, 'client/e2e/checkout.spec.ts')), 'earlier QA test present');
  assert.equal(realRunner('git', ['-C', out.worktree, 'merge-base', '--is-ancestor', p.fixSha, 'HEAD']).status, 0, 'dev fix merged in');
  const baseline = JSON.parse(readFileSync(path.join(out.runDir, 'suite-baseline.json'), 'utf8'));
  assert.ok(baseline.files['client/e2e/checkout.spec.ts'], 'baseline counts the earlier QA test');
  assert.equal(out.unchanged, null, 'the delivered run recorded no tested commit, so nothing to compare');
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, forget: true });
  p.cleanup();

  // The delivered run tested this very commit: nothing new (seen live: a re-test before the fix merged).
  const same = retestProject();
  const head = git(same.dir, 'ls-remote', 'origin', 'refs/heads/demo/stage').split(/\s/)[0];
  mkdirSync(path.join(same.dir, '.qa-runs', 'PROJ-5', '20260925-0820-aaaa'), { recursive: true });
  writeFileSync(path.join(same.dir, '.qa-runs', 'PROJ-5', '20260925-0820-aaaa', 'state.json'), JSON.stringify({ phase: 'AWAITING_HUMAN_REVIEW', qa: { branch: QA }, tested: { sha: head } }));
  const again = start({ runner: retestRunner(same), project: same.dir, key: 'PROJ-5', sessionId: 's' });
  assert.deepEqual(again.unchanged, { previousRunId: '20260925-0820-aaaa', testedSha: head });
  release({ runner: realRunner, project: same.dir, runDir: again.runDir, forget: true });
  same.cleanup();
});

test('re-test: the previous run\'s worktree is freed when it loses nothing; local work stops the run', () => {
  // Release keeps the delivered run's worktree for review, and it holds the QA branch.
  const leftover = (p) => {
    const dir = path.join(p.dir, '.qa-worktrees', '20260929-1704-e29f');
    git(p.dir, 'worktree', 'add', '-q', dir, QA);
    return dir;
  };
  const clean = retestProject();
  const old = leftover(clean);
  const out = start({ runner: retestRunner(clean), project: clean.dir, key: 'PROJ-5', sessionId: 's' });
  assert.equal(out.freedWorktree.runId, '20260929-1704-e29f');
  assert.equal(existsSync(old), false);
  assert.equal(git(out.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), QA);
  release({ runner: realRunner, project: clean.dir, runDir: out.runDir, forget: true });
  clean.cleanup();

  const dirty = retestProject();
  writeFileSync(path.join(leftover(dirty), 'client/e2e/checkout.spec.ts'), 'reviewer edit');
  assert.throws(() => start({ runner: retestRunner(dirty), project: dirty.dir, key: 'PROJ-5', sessionId: 's' }), /uncommitted changes/);
  assert.equal(existsSync(path.join(dirty.dir, '.qa-runs', '.lock')), false, 'lock released');
  dirty.cleanup();

  const ahead = retestProject();
  const aheadDir = leftover(ahead);
  writeFileSync(path.join(aheadDir, 'client/e2e/extra.spec.ts'), 'x');
  git(aheadDir, 'add', '-A');
  git(aheadDir, 'commit', '-q', '-m', 'local only');
  assert.throws(() => start({ runner: retestRunner(ahead), project: ahead.dir, key: 'PROJ-5', sessionId: 's' }), /1 commit\(s\) not on origin/);
  assert.ok(existsSync(aheadDir), 'unpushed work is kept');
  ahead.cleanup();
});

test('re-test: a QA branch that touches product code is refused; worktree and lock are cleaned up', () => {
  const p = retestProject({ qaFile: 'client/src/sneaky.ts', qaContent: 'export const x = 1;' });
  assert.throws(() => start({ runner: retestRunner(p), project: p.dir, key: 'PROJ-5', sessionId: 's' }),
    (err) => err instanceof Breaker && /outside client\/e2e: client\/src\/sneaky\.ts/.test(err.message));
  assert.equal(existsSync(path.join(p.dir, '.qa-runs', '.lock')), false);
  assert.equal(git(p.dir, 'worktree', 'list').trim().split('\n').length, 1);
  assert.equal(existsSync(path.join(p.dir, '.qa-runs', 'PROJ-5', 'latest')), false, 'a failed start never becomes "latest"');
  assert.deepEqual(readdirSync(path.join(p.dir, '.qa-runs', 'PROJ-5')), [], 'nor leaves a run folder behind');
  p.cleanup();
});

test('re-test: a merge conflict stops with the conflicting file; nothing is left checked out', () => {
  const p = retestProject({ qaFile: 'client/e2e/cart.spec.ts', qaContent: 'expect(h).toBe("QA version");', devFile: 'client/e2e/cart.spec.ts', devContent: 'expect(h).toBe("dev version");' });
  assert.throws(() => start({ runner: retestRunner(p), project: p.dir, key: 'PROJ-5', sessionId: 's' }),
    (err) => err instanceof Breaker && /conflicts with .* in: client\/e2e\/cart\.spec\.ts/.test(err.message));
  assert.equal(git(p.dir, 'worktree', 'list').trim().split('\n').length, 1);
  assert.equal(existsSync(path.join(p.dir, '.qa-runs', '.lock')), false);
  assert.match(git(p.dir, 'ls-remote', '--heads', 'origin', QA), /qa\/PROJ-5/, 'the QA branch is untouched');
  p.cleanup();
});

test('re-test: a QA branch whose PR was merged or closed is never reused (next is "-2")', () => {
  const p = retestProject();
  const out = start({ runner: retestRunner({ ...p, openPrs: [] }), project: p.dir, key: 'PROJ-5', sessionId: 's' });
  assert.equal(out.qaBranch, `${QA}-2`);
  assert.equal(out.retest, null);
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, forget: true });
  p.cleanup();
});

test('preflight resume: a new session takes over a run waiting at a gate', () => {
  const p = project();
  const prs = [{ number: 131, headRefName: 'feature/PROJ-1-cart-sort', mergeCommit: { oid: p.head }, title: 't', url: 'u' }];
  const out = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-1', sessionId: 'old-session' });
  assert.throws(() => resume({ project: p.dir, key: 'PROJ-1', sessionId: 'new' }), /no resumable run/);
  const stateFile = path.join(out.runDir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), phase: 'AWAITING_PLAN_APPROVAL' }));
  // Still locked by the old session → plain resume refuses and points at --takeover.
  assert.throws(() => resume({ project: p.dir, key: 'PROJ-1', sessionId: 'new-session' }), /--takeover/);
  // A gate wait the playbook released (lock freed) resumes without takeover.
  release({ runner: realRunner, project: p.dir, runDir: out.runDir, forget: true });
  const r = resume({ project: p.dir, key: 'PROJ-1', sessionId: 'new-session' });
  assert.equal(r.resumed, out.runId);
  assert.equal(JSON.parse(readFileSync(path.join(p.dir, '.qa-runs', 'active.json'), 'utf8')).sessionId, 'new-session');
  assert.ok(existsSync(out.worktree), 'a run released at a gate keeps its worktree');
  release({ runner: realRunner, project: p.dir, runDir: out.runDir });
  p.cleanup();
});

test('preflight release: a finished run is tidied; prune does it for runs already on disk', () => {
  const p = project();
  const prs = [{ number: 131, headRefName: 'feature/PROJ-1-cart-sort', mergeCommit: { oid: p.head }, title: 't', url: 'u' }];
  const finish = (out, phase) => {
    const file = path.join(out.runDir, 'state.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), phase }));
    mkdirSync(path.join(out.worktree, 'node_modules', 'x'), { recursive: true });
    mkdirSync(path.join(out.worktree, 'client', 'node_modules', 'y'), { recursive: true });
  };
  // The QA stack mounts files from the worktree, so `docker compose ps -q` decides too.
  const docker = (containers) => (cmd, args, opts) => (cmd === 'docker' ? { status: 0, stdout: containers, stderr: '' } : realRunner(cmd, args, opts));
  // Delivered, but the stack was kept running: the worktree stays, without node_modules.
  const kept = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-1', sessionId: 's' });
  git(kept.worktree, 'push', '-q', 'origin', kept.qaBranch);
  finish(kept, 'AWAITING_HUMAN_REVIEW');
  const r0 = release({ runner: docker('abc123\n'), project: p.dir, runDir: kept.runDir });
  assert.match(r0.tidy.worktree.why, /QA stack is up/);
  assert.equal(existsSync(path.join(kept.worktree, 'node_modules')), false);
  // Delivered and the stack is down: every commit is on origin, so the whole worktree goes.
  const r1 = prune({ runner: docker(''), project: p.dir });
  assert.deepEqual(r1.tidied.map((t) => t.worktree), [{ removed: kept.worktree }]);
  assert.equal(existsSync(kept.worktree), false);
  assert.equal(existsSync(`${kept.worktree}.removing`), false);
  assert.equal(git(p.dir, 'worktree', 'list').trim().split('\n').length, 1);
  assert.equal(r1.tidied[0].branchDeleted, undefined, 'a pushed QA branch backs a QA PR and stays');
  const hasBranch = (b) => realRunner('git', ['-C', p.dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).status === 0;
  assert.ok(hasBranch(kept.qaBranch));

  // Stopped before delivery with a commit only this branch has: never pushed, so the files stay,
  // without node_modules.
  const stopped = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-2', sessionId: 's', noDevCheck: true });
  writeFileSync(path.join(stopped.worktree, 'client/e2e/local.spec.ts'), '// local\n');
  git(stopped.worktree, 'add', '-A');
  git(stopped.worktree, 'commit', '-q', '-m', 'local only');
  finish(stopped, 'STOPPED');
  const r2 = release({ runner: realRunner, project: p.dir, runDir: stopped.runDir, forget: true });
  assert.deepEqual(r2.tidy.worktree, { kept: stopped.worktree, why: 'a QA branch that was never pushed', nodeModulesRemoved: 2 });
  assert.ok(existsSync(path.join(stopped.worktree, 'client/e2e/local.spec.ts')));
  assert.equal(existsSync(path.join(stopped.worktree, 'node_modules')), false);
  assert.equal(existsSync(path.join(stopped.worktree, 'client', 'node_modules')), false);
  assert.ok(hasBranch(stopped.qaBranch), 'a branch with undelivered work stays');

  // A run that changed no QA test: the branch was never pushed, but every commit on it is on
  // origin, so the worktree goes, and the empty branch with it.
  const empty = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-5', sessionId: 's', noDevCheck: true });
  finish(empty, 'AWAITING_HUMAN_REVIEW');
  const r3 = release({ runner: docker(''), project: p.dir, runDir: empty.runDir, forget: true });
  assert.deepEqual(r3.tidy.worktree, { removed: empty.worktree });
  assert.equal(existsSync(empty.worktree), false);
  assert.equal(r3.tidy.branchDeleted, empty.qaBranch);
  assert.equal(hasBranch(empty.qaBranch), false);

  // BLOCKED_ENV with the Docker daemon down: docker can't list containers, and says why,
  // so no stack mounts the worktree. Any other docker failure still counts as "up".
  const dockerFails = (stderr) => (cmd, args, opts) => (cmd === 'docker' ? { status: 1, stdout: '', stderr } : realRunner(cmd, args, opts));
  const busy = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-6', sessionId: 's', noDevCheck: true });
  finish(busy, 'BLOCKED_ENV');
  const r4 = release({ runner: dockerFails('permission denied while trying to connect'), project: p.dir, runDir: busy.runDir, forget: true });
  assert.match(r4.tidy.worktree.why, /QA stack is up/);
  assert.ok(hasBranch(busy.qaBranch));
  const down = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-7', sessionId: 's', noDevCheck: true });
  finish(down, 'BLOCKED_ENV');
  const daemon = 'unable to get image \'x\': failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine';
  const r5 = release({ runner: dockerFails(daemon), project: p.dir, runDir: down.runDir, forget: true });
  assert.deepEqual(r5.tidy.worktree, { removed: down.worktree });
  assert.equal(hasBranch(down.qaBranch), false, 'the retry can start on the same branch name');

  // prune: a run folder without state.json goes; nothing runs while a run holds the lock.
  const orphan = path.join(p.dir, '.qa-runs', 'PROJ-3', '20260929-2025-190f');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(path.join(orphan, 'dev-changes.json'), '{}');
  const pruned = prune({ runner: docker(''), project: p.dir });
  assert.deepEqual(pruned.orphansRemoved, ['PROJ-3/20260929-2025-190f']);
  assert.equal(existsSync(orphan), false);
  const holding = start({ runner: ghRunner(prs), project: p.dir, key: 'PROJ-4', sessionId: 's', noDevCheck: true });
  assert.throws(() => prune({ runner: realRunner, project: p.dir }), /holds the lock/);
  release({ runner: realRunner, project: p.dir, runDir: holding.runDir, forget: true });
  p.cleanup();
});

// ── preflight stack ────────────────────────────────────────────────────────
function stackFixture(testedSha) {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-stack-'));
  const dir = path.join(root, 'proj');
  const worktree = path.join(dir, '.qa-worktrees', 'r1');
  mkdirSync(path.join(dir, '.qa'), { recursive: true });
  mkdirSync(path.join(dir, '.qa-runs'), { recursive: true });
  mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
  writeFileSync(path.join(dir, '.qa/config.json'), JSON.stringify(config));
  writeFileSync(path.join(dir, '.qa-runs/active.json'), JSON.stringify({ runDir: path.join(dir, '.qa-runs', 'r1'), worktree, testedSha }));
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const fakeFetch = (apiSha, webSha, { down = [] } = {}) => async (url) => {
  if (down.includes(url)) throw new Error('ECONNREFUSED');
  const body = url.includes('8080') ? JSON.stringify({ status: 'healthy', sha: apiSha }) : `<html><head><meta name="app-sha" content="${webSha}"></head></html>`;
  return { ok: true, text: async () => body };
};

test('preflight stack: builds with GIT_SHA, waits for health, proves the running app is the tested commit', async () => {
  const sha = 'a'.repeat(40);
  const f = stackFixture(sha);
  const calls = [];
  const runner = (cmd, args, opts) => { calls.push({ cmd, args, env: opts?.env }); return { status: 0, stdout: '', stderr: '' }; };
  const ok = await stack({ runner, fetchFn: fakeFetch(sha, sha.slice(0, 12)), project: f.dir, env: {}, sleep: async () => {} });
  assert.equal(ok.ok, true);
  const up = calls.find((c) => c.cmd === 'docker');
  assert.deepEqual(up.args.slice(0, 3), ['compose', '-p', 'myapp-qa']);
  assert.equal(up.env.GIT_SHA, sha);

  await assert.rejects(stack({ runner, fetchFn: fakeFetch('b'.repeat(40), sha), project: f.dir, env: {}, sleep: async () => {} }),
    (err) => err instanceof Breaker && /not the tested commit/.test(err.message));

  let t = 0;
  await assert.rejects(stack({ runner, fetchFn: fakeFetch(sha, sha, { down: ['http://localhost:3000/'] }), project: f.dir, env: { QA_STACK_ATTACH_ONLY: '1' }, sleep: async () => {}, now: () => (t += 5000) }),
    (err) => err instanceof Breaker && err.phase === 'BLOCKED_ENV' && /3000/.test(err.message));
  f.cleanup();
});

test('preflight stack: readSha reads a JSON field or a meta tag', async () => {
  const fetchFn = fakeFetch('abc1234', 'def5678');
  assert.equal(await readSha(fetchFn, 'http://localhost:8080/health#sha'), 'abc1234');
  assert.equal(await readSha(fetchFn, 'http://localhost:3000/#meta:app-sha'), 'def5678');
});
