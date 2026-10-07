// The Playwright runner (docs/design.md §5 step 6). Deterministic, not an agent:
// runs the plan's run set in the run worktree against the QA stack and derives
// runner-<n>.json from Playwright's own JSON report.
//
//   run-playwright.mjs --run <runDir> --project <projectDir> --attempt <n> [--files a,b]
//   run-playwright.mjs --run <runDir> --project <projectDir> --self-check <n> --files a,b
//   run-playwright.mjs --run <runDir> --project <projectDir> --drift-probe
//
// --drift-probe (while qa-feedback writes, every qa.driftProbeEvery-th run) runs only the tests the plan
// skipped as known drift and writes drift-probe.json; it never touches the verdict.
//
// --self-check is the test author's only way to run tests (guard H6): same
// worktree, URLs and outputs as a real attempt, written to runner-self-<n>.json,
// so the author never tests the main checkout or the Playwright default URL.
//
// Per attempt: runner-<n>.raw.json (Playwright JSON), playwright-report-<n>/ (HTML),
// test-results-<n>/ (traces, screenshots). Zero tests or a collection error is
// status "invalid", never "passed".
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { UsageError, inDir, isMain, loadConfig, need, readJson, realRunner, writeJsonAtomic } from './lib/common.mjs';

const ANSI = /\u001b\[[0-9;]*m/g;
const clean = (s) => String(s ?? '').replace(ANSI, '').trim();

export function playwrightCli(worktree) {
  const req = createRequire(path.join(worktree, 'package.json'));
  for (const id of ['@playwright/test/cli', 'playwright/cli']) {
    try { return req.resolve(id); } catch { /* try next */ }
  }
  throw new Error(`Playwright is not installed in ${worktree}. Run "preflight.mjs stack" first (it installs dependencies).`);
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Known-drift tests (plan entries with `tests`) stay out through one --grep-invert. Playwright
// matches it against "<project> <file> <describe…> <title>", so each alternative names its spec
// file and never drops a same-titled test in another spec (checked on Playwright 1.61.1).
export function driftGrep(entries, selected) {
  const hit = (entries ?? []).filter((d) => !d.wholeFile && d.tests?.length && selected.some((s) => s === d.file || inDir(d.file, s)));
  const pattern = hit.flatMap((d) => d.tests.map((t) => `(?:^|[ /])${escapeRe(path.posix.basename(d.file))} .*${escapeRe(t)}`)).join('|');
  return { pattern: pattern || null, skipped: hit };
}

export function buildCommand({ config, runDir, attempt, files, worktree, testedSha, cli, grepInvert = null, grep = null, raw = `runner-${attempt}.raw.json`, baseEnv = process.env }) {
  const out = (name) => path.join(runDir, `${name}-${attempt}`);
  return {
    cmd: process.execPath,
    args: [cli, 'test', '--config', config.qa.playwrightConfig, '--reporter=json,html',
      `--output=${out('test-results')}`, '--trace=retain-on-failure', '--retries=0',
      ...(grepInvert ? ['--grep-invert', grepInvert] : []), ...(grep ? ['--grep', grep] : []), ...files],
    cwd: worktree,
    env: {
      ...baseEnv,
      // Project-specific variables its specs read (e.g. a Vite app's VITE_API_URL).
      ...(config.qa.env ?? {}),
      CI: '1', // most Playwright configs set forbidOnly under CI, so a stray .only fails the run
      BASE_URL: config.qa.baseUrl,
      API_URL: config.qa.apiUrl,
      QA_TESTED_SHA: testedSha ?? '',
      PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(runDir, raw),
      PLAYWRIGHT_HTML_OUTPUT_DIR: out('playwright-report'),
      PLAYWRIGHT_HTML_OPEN: 'never',
    },
  };
}

function* allTests(suites, parents = []) {
  for (const suite of suites ?? []) {
    const trail = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) yield { spec, test: t, trail };
    }
    yield* allTests(suite.suites, trail);
  }
}

export function summarizeReport(report, { exitCode }) {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0 };
  const failures = [];
  for (const { spec, test, trail } of allTests(report.suites)) {
    counts.total += 1;
    if (test.status === 'expected') counts.passed += 1;
    else if (test.status === 'flaky') counts.flaky += 1;
    else if (test.status === 'skipped') counts.skipped += 1;
    else {
      counts.failed += 1;
      const last = test.results?.at(-1) ?? {};
      const attachment = (name) => last.attachments?.find((a) => a.name === name)?.path ?? null;
      failures.push({
        spec: spec.file, title: [...trail.slice(1), spec.title].join(' › '), project: test.projectName ?? null,
        line: spec.line ?? null,
        error: clean(last.error?.message ?? last.errors?.[0]?.message).slice(0, 2000),
        tracePath: attachment('trace'), screenshotPath: attachment('screenshot'), errorContextPath: attachment('error-context'),
      });
    }
  }
  const errors = (report.errors ?? []).map((e) => clean(e.message).slice(0, 1000));
  let status = 'completed';
  if (counts.total === 0 || counts.total === counts.skipped) status = 'invalid';
  else if (errors.length) status = 'invalid';
  else if (exitCode !== 0 && counts.failed === 0) status = 'invalid';
  return { status, counts, failures, errors };
}

// Playwright's positional filters only match forward-slash paths on Windows
// ("client\e2e\api\" selects 0 tests; verified in build step 3).
export const toFilter = (f) => String(f).replace(/\\/g, '/');

export function runPlaywright({ runner, config, plan, active, runDir, attempt, files }) {
  const selected = (files?.length ? files : plan?.runSet ?? []).map(toFilter);
  if (!selected?.length) throw new UsageError('nothing to run: empty run set');
  const cli = playwrightCli(active.worktree);
  const drift = driftGrep(plan?.knownDriftSkipped, selected);
  const command = buildCommand({ config, runDir, attempt, files: selected, worktree: active.worktree, testedSha: active.testedSha, cli, grepInvert: drift.pattern });
  const started = Date.now();
  const r = runner(command.cmd, command.args, { cwd: command.cwd, env: command.env });
  const rawPath = command.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  const report = existsSync(rawPath) ? JSON.parse(readFileSync(rawPath, 'utf8')) : { suites: [], errors: [{ message: `no JSON report produced; stderr: ${r.stderr.slice(0, 800)}` }] };
  const summary = summarizeReport(report, { exitCode: r.status });
  return {
    attempt, command: ['playwright', ...command.args.slice(1)].join(' '), cwd: command.cwd, exitCode: r.status,
    durationMs: Date.now() - started, testedSha: active.testedSha ?? null, files: selected,
    // Not run on purpose (qa.knownDrift); listed so a skipped spec is never mistaken for coverage.
    // A --files run leaves whole-file skips out by its own selection; its test-level skips still apply.
    knownDriftSkipped: files?.length ? drift.skipped : (plan?.knownDriftSkipped ?? []),
    reportDir: command.env.PLAYWRIGHT_HTML_OUTPUT_DIR, rawReport: rawPath, ...summary,
  };
}

// ── Known-drift probe (docs/design.md §5 step 8) ────────────────────────────
// A qa.knownDrift skip hides its tests until a person removes the entry, even after the drift
// healed (seen live: a skipped playthrough passed when it ran by mistake). So every
// qa.driftProbeEvery-th run, while the feedback agent writes, runs only the skipped tests once. The result
// never changes this run's verdict; memory turns it into a suggestion for the config.

// .qa-runs/history.jsonl, one finished run per line; unreadable lines are skipped.
export function readHistory(project) {
  const file = path.join(project, '.qa-runs', 'history.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
}

// Due when no earlier run probed, or the last probe is at least `every - 1` runs back. History
// doesn't change during a run, so preflight start records the answer in state.json (`driftProbe`)
// and the playbook skips a probe that isn't due without launching it: the guard counts every
// runner call toward H7 (seen live: 4 launches counted for 3 test runs).
export function probeDue(history, every, runId) {
  if (!(Number(every) > 0)) return { due: false, why: 'qa.driftProbeEvery is 0 (never probe)' };
  const rows = history.filter((r) => r.runId !== runId);
  const last = rows.findLastIndex((r) => r.driftProbed);
  const since = last < 0 ? null : rows.length - 1 - last;
  if (since !== null && since < every - 1) return { due: false, why: `the last probe was ${since} run(s) ago; it runs every ${every} runs` };
  return { due: true, why: since === null ? 'no earlier run probed' : `the last probe was ${since} run(s) ago` };
}

// One positive --grep for every skipped test, each alternative scoped to its spec file (the same
// shape as driftGrep). A whole-file entry selects every test in its spec.
export function probeGrep(entries) {
  return (entries ?? []).flatMap((d) => {
    const file = escapeRe(path.posix.basename(d.file));
    return d.wholeFile ? [`(?:^|[ /])${file} `] : (d.tests ?? []).map((t) => `(?:^|[ /])${file} .*${escapeRe(t)}`);
  }).join('|');
}

// Per entry: passed (every test that ran passed), failed, or no-tests (nothing it names ran).
export function probeResults(report, entries) {
  const ran = [...allTests(report.suites)].map(({ spec, test }) => ({ file: toFilter(spec.file), title: spec.title, status: test.status }));
  const sameFile = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  return (entries ?? []).map((d) => {
    const mine = ran.filter((t) => sameFile(t.file, d.file) && (d.wholeFile || (d.tests ?? []).includes(t.title)) && t.status !== 'skipped');
    const passed = mine.filter((t) => t.status === 'expected').map((t) => t.title);
    const failed = mine.filter((t) => t.status !== 'expected').map((t) => t.title);
    const status = !mine.length ? 'no-tests' : failed.length ? 'failed' : 'passed';
    return { file: d.file, wholeFile: Boolean(d.wholeFile), reason: d.reason ?? null, status, passed, failed };
  });
}

// probed: false means "ask again next run": a probe that proves nothing must not count as one,
// or a dead stack or a crash would read as a relapse and push the next probe N runs out.
export function probeDrift({ runner, config, plan, active, runDir, history = [], firstRun = null }) {
  const entries = plan?.knownDriftSkipped ?? [];
  if (!entries.length) return { probed: false, why: 'this run skipped no known drift', entries: [] };
  if (firstRun?.status !== 'completed') return { probed: false, why: 'the run\'s own attempt 1 was not a completed run', entries: [] };
  const due = probeDue(history, config.qa.driftProbeEvery, active.runId);
  if (!due.due) return { probed: false, why: due.why, entries: [] };
  const files = [...new Set(entries.map((d) => toFilter(d.file)))];
  const command = buildCommand({ config, runDir, attempt: 'drift', files, worktree: active.worktree, testedSha: active.testedSha,
    cli: playwrightCli(active.worktree), grep: probeGrep(entries), raw: 'drift-probe.raw.json' });
  const started = Date.now();
  const r = runner(command.cmd, command.args, { cwd: command.cwd, env: command.env });
  const rawPath = command.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  const ran = { command: ['playwright', ...command.args.slice(1)].join(' '), exitCode: r.status, durationMs: Date.now() - started };
  if (!existsSync(rawPath)) return { probed: false, why: `Playwright wrote no report (exit ${r.status}): ${clean(r.stderr).slice(0, 300)}`, ...ran, entries: [] };
  const results = probeResults(JSON.parse(readFileSync(rawPath, 'utf8')), entries);
  if (results.every((e) => e.status === 'no-tests')) return { probed: false, why: 'the probe ran none of the skipped tests', ...ran, entries: results };
  return {
    probed: true, why: due.why, ...ran, testedSha: active.testedSha ?? null, reportDir: command.env.PLAYWRIGHT_HTML_OUTPUT_DIR,
    entries: results,
  };
}

if (isMain(import.meta.url)) {
  const { main } = await import('./lib/common.mjs');
  main(async (args) => {
    need(args, 'run', 'project');
    if (args.driftProbe) {
      const history = readHistory(args.project);
      const result = probeDrift({
        runner: realRunner, config: loadConfig(args.project), plan: readJson(path.join(args.run, 'plan.json'), null),
        active: readJson(path.join(args.project, '.qa-runs', 'active.json')), runDir: args.run, history,
        firstRun: readJson(path.join(args.run, 'runner-1.json'), null),
      });
      writeJsonAtomic(path.join(args.run, 'drift-probe.json'), result);
      return result;
    }
    const selfCheck = args.selfCheck !== undefined;
    if (selfCheck && typeof args.files !== 'string') throw new UsageError('--self-check needs --files');
    if (!selfCheck) need(args, 'attempt');
    const attempt = selfCheck ? `self-${Number(args.selfCheck)}` : Number(args.attempt);
    const result = runPlaywright({
      runner: realRunner,
      config: loadConfig(args.project),
      plan: readJson(path.join(args.run, 'plan.json'), null),
      active: readJson(path.join(args.project, '.qa-runs', 'active.json')),
      runDir: args.run,
      attempt,
      files: typeof args.files === 'string' ? args.files.split(',').filter(Boolean) : null,
    });
    writeJsonAtomic(path.join(args.run, `runner-${attempt}.json`), result);
    const { failures, ...short } = result;
    return { ...short, failures: failures.length };
  });
}
