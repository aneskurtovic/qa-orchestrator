// After the author (docs/design.md §5 step 5), and again after every later author dispatch
// (send-back, repair, fix): what actually changed in the QA suite compared with the run-start
// baseline, checked against the approved plan.
//
//   test-diff.mjs --run <runDir> --project <projectDir>
//
// Writes test-diff.json and qa-tests.patch. Exit 0 when clean, exit 3 when
// anything is flagged; flags go to the human at G3:
//   assertions-decreased    an updated file has fewer expect() calls than before
//   tests-removed           an updated file lost a test that existed at run start (e.g. the
//                           author rewrote a spec and dropped its existing tests). A test
//                           an approved update item names (its `test`) may be renamed or removed.
//   weakening-marker-added  skip / only / fixme appeared
//   out-of-plan             a file changed that the approved plan doesn't list
//   outside-test-dir        something outside the QA test dir changed
//   planned-change-missing  the plan says update/add but the file didn't change
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { inDir, isMain, loadConfig, mustRun, namesTest, need, posix, readJson, realRunner, writeJsonAtomic } from './lib/common.mjs';
import { snapshotSuite } from './lib/suite.mjs';

// Titles in `before` with no counterpart in `after` (a multiset difference: a title may repeat
// across describe blocks).
export function missingTitles(before, after) {
  const left = new Map();
  for (const t of after) left.set(t, (left.get(t) ?? 0) + 1);
  return before.filter((t) => {
    const n = left.get(t) ?? 0;
    if (n) left.set(t, n - 1);
    return !n;
  });
}

// The baseline title each planned name refers to (exact first, then a "describe › title" trail).
// A name that matches nothing is kept as is, so it simply removes nothing.
function resolveTitles(names, titles) {
  return names.map((n) => titles.find((t) => t === n) ?? titles.find((t) => namesTest(n, t)) ?? n);
}

export function diffSuite({ baseline, current, plan, outsideChanges }) {
  // What the plan allows per file. An "add" to a file that already exists means appending tests,
  // which shows up as "updated", so both are accepted there.
  const planned = new Map();
  const allow = (file, action) => {
    const f = posix(file);
    if (!planned.has(f)) planned.set(f, new Set());
    planned.get(f).add(action);
  };
  for (const u of plan.changeSet.update) allow(u.file, 'updated');
  // Tests an approved update names may be renamed or rewritten (e.g. "shows ELO" → "shows Rating").
  const plannedTests = new Map();
  for (const u of plan.changeSet.update) {
    if (!u.test) continue;
    const f = posix(u.file);
    plannedTests.set(f, [...(plannedTests.get(f) ?? []), u.test]);
  }
  for (const a of plan.changeSet.add) { allow(a.file, 'added'); if (baseline.files[posix(a.file)]) allow(a.file, 'updated'); }
  for (const d of plan.changeSet.delete) allow(d.file, 'deleted');

  const files = [];
  for (const file of new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])) {
    const before = baseline.files[file];
    const after = current.files[file];
    let action = 'unchanged';
    if (before && !after) action = 'deleted';
    else if (!before && after) action = 'added';
    else if (before.sha !== after.sha) action = 'updated';
    const flags = [];
    const expected = planned.get(file);
    if (action !== 'unchanged' && !expected?.has(action)) flags.push('out-of-plan');
    if (expected && action === 'unchanged') flags.push('planned-change-missing');
    if (action === 'updated' && after.expects < before.expects) flags.push('assertions-decreased');
    if (after && after.markers > (before?.markers ?? 0)) flags.push('weakening-marker-added');
    // Baselines from before titles were recorded have no `tests`; nothing to compare then. Each
    // planned name stands for one baseline title it names, so a repeated title is still counted.
    const testsRemoved = action === 'updated' && before.tests && after.tests
      ? missingTitles(missingTitles(before.tests, resolveTitles(plannedTests.get(file) ?? [], before.tests)), after.tests) : [];
    if (testsRemoved.length) flags.push('tests-removed');
    if (action !== 'unchanged' || flags.length) {
      files.push({
        file, action, planned: expected ? [...expected] : null, expectsBefore: before?.expects ?? null, expectsAfter: after?.expects ?? null,
        ...(testsRemoved.length ? { testsRemoved } : {}), flags,
      });
    }
  }
  // Planned files that exist neither before nor after (e.g. an add the author never wrote).
  for (const [file, actions] of planned) {
    if (!baseline.files[file] && !current.files[file]) {
      files.push({ file, action: 'missing', planned: [...actions], expectsBefore: null, expectsAfter: null, flags: ['planned-change-missing'] });
    }
  }
  const outside = outsideChanges.map((file) => ({ file, flags: ['outside-test-dir'] }));
  const flagged = [...files, ...outside].filter((f) => f.flags.length);
  return { ok: flagged.length === 0, files: files.sort((a, b) => a.file.localeCompare(b.file)), outsideTestDir: outside, flagged: flagged.length };
}

// Paths changed in the worktree outside the QA test dir (tracked or untracked).
export function outsideChanges(runner, worktree, testDir) {
  const out = mustRun(runner, 'git', ['-C', worktree, 'status', '--porcelain', '--untracked-files=all']);
  return out.split('\n').filter(Boolean).map((l) => posix(l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')))
    .filter((f) => !inDir(f, testDir));
}

if (isMain(import.meta.url)) {
  const { main } = await import('./lib/common.mjs');
  main(async (args) => {
    need(args, 'run', 'project');
    const config = loadConfig(args.project);
    const active = readJson(path.join(args.project, '.qa-runs', 'active.json'));
    const testDir = config.qa.testDir;
    const result = diffSuite({
      baseline: readJson(path.join(args.run, 'suite-baseline.json')),
      current: snapshotSuite(active.worktree, testDir),
      plan: readJson(path.join(args.run, 'plan.json')),
      outsideChanges: outsideChanges(realRunner, active.worktree, testDir),
    });
    writeJsonAtomic(path.join(args.run, 'test-diff.json'), result);
    // Patch of the QA dir, including new files (intent-to-add makes them visible to git diff).
    realRunner('git', ['-C', active.worktree, 'add', '--intent-to-add', '--', testDir]);
    const patch = realRunner('git', ['-C', active.worktree, 'diff', '--', testDir]).stdout;
    writeFileSync(path.join(args.run, 'qa-tests.patch'), patch);
    if (!result.ok) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(3);
    }
    return { ok: true, files: result.files.length };
  });
}
