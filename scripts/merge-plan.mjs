// Fan-in (docs/design.md §5 step 3): merges the ticket-driven suite-impact proposal and
// the code-driven change-analyst proposal with the routing rules into plan.json.
//
//   merge-plan.mjs --run <runDir> --project <projectDir>
//
// Deterministic: the same inputs always give the same plan and planHash. Any
// change to the plan changes the hash and so invalidates an earlier G2 approval.
import path from 'node:path';
import { canonical, inDir, isMain, loadConfig, main, namesTest, need, posix, readJson, sha256, writeJsonAtomic } from './lib/common.mjs';

const uniq = (xs) => [...new Set(xs)];

export function routeSuites(config, intake, analyst) {
  const routes = config.routes ?? {};
  const suites = config.suites ?? {};
  const changeType = intake.changeType;
  let names;
  if (changeType === 'mixed') {
    // A change that spans areas runs every area's suites: more coverage, no guessing.
    names = Object.values(routes).filter(Array.isArray).flat();
  } else {
    names = Array.isArray(routes[changeType]) ? routes[changeType] : (routes.unknown ?? []);
  }
  names = [...names, ...(analyst.regressionRisks ?? []).flatMap((r) => r.suggestedSuites ?? [])];
  if (analyst.touchesCriticalArea) names = [...names, ...Object.keys(suites)];
  const known = uniq(names).filter((n) => suites[n]);
  // Without suites the whole test dir runs, so a suggested suite name is nothing to warn about.
  const unknown = Object.keys(suites).length ? uniq(names).filter((n) => !suites[n]) : [];
  return { suites: known, unknownSuites: unknown };
}

// baselineTests: spec → its test titles at run start (suite-baseline.json).
export function mergePlan({ config, intake, suiteImpact, changeAnalyst, baselineFiles = [], baselineTests = {} }) {
  const testDir = config.qa.testDir;
  const byFile = new Map();

  const update = suiteImpact.changeSet.update.map((u) => ({ ...u, file: posix(u.file), source: 'ticket' }));
  const del = suiteImpact.changeSet.delete.map((d) => ({ ...d, file: posix(d.file), source: 'ticket' }));
  // Every ticket-driven add is kept; several may target the same file (e.g. AC1 and AC4 in one spec).
  const add = suiteImpact.changeSet.add.map((a) => ({ ...a, file: posix(a.file), source: 'ticket' }));
  // Code-driven scenarios become their own items (source "code"), one per file, so the human sees
  // at G2 exactly which tests came from reading the code rather than the ticket.
  for (const s of changeAnalyst.additionalScenarios) {
    const file = posix(s.file);
    const scenario = { title: s.title, steps: s.steps, expected: s.expected, codeRef: s.codeRef };
    if (!byFile.has(file)) {
      const item = { file, kind: s.kind, codeRef: s.codeRef, scenarios: [], source: 'code' };
      byFile.set(file, item);
      add.push(item);
    }
    byFile.get(file).scenarios.push(scenario);
  }

  // New tests in a spec that existed at run start: still an add (new tests, nothing existing
  // changes), but G2 and the counts must not present it as a new file (seen live).
  const existingFiles = new Set(baselineFiles.map(posix));
  for (const a of add) if (existingFiles.has(a.file)) a.intoExisting = true;

  const conflicts = del.filter((d) => update.some((u) => u.file === d.file) || add.some((a) => a.file === d.file)).map((d) => d.file);
  const outside = [...update, ...add, ...del].filter((i) => !inDir(i.file, testDir)).map((i) => i.file);

  const route = routeSuites(config, intake, changeAnalyst);
  // A project without `suites` runs its whole QA test dir every time: simple to set up, slower to run.
  const noSuites = !Object.keys(config.suites ?? {}).length;
  const suiteFiles = noSuites ? [`${posix(testDir).replace(/\/$/, '')}/`] : route.suites.flatMap((n) => config.suites[n]).map(posix);
  const deleted = new Set(del.map((d) => d.file));
  const candidates = uniq([
    ...suiteImpact.impactedExisting.map(posix), ...suiteFiles, ...update.map((u) => u.file), ...add.map((a) => a.file),
  ]).filter((f) => !deleted.has(f));
  // Specs with known, not yet fixed drift (qa.knownDrift) stay out of the run set, since each costs
  // a long timeout per run (seen live: a spec waited out 360 s). A whole-spec entry lapses when this
  // run changes the spec. A test-level entry keeps skipping its tests unless an update item names
  // one (seen live: an update to one test made a spec's 4-minute playthrough run twice).
  const changed = new Set([...update, ...add].map((i) => i.file));
  const updatedTests = (file) => update.filter((u) => u.file === file && u.test).map((u) => u.test);
  const drift = (config.qa.knownDrift ?? []).map((d) => ({ file: posix(d.file), reason: d.reason ?? null, since: d.since ?? null, tests: d.tests ?? [] }))
    .flatMap((d) => {
      if (!d.tests.length) return changed.has(d.file) ? [] : [d];
      const tests = d.tests.filter((t) => !updatedTests(d.file).some((n) => namesTest(n, t)));
      return tests.length ? [{ ...d, tests }] : [];
    });
  // An entry with `tests` skips only those tests (the runner passes them to --grep-invert). One
  // without skips the whole spec, and the plan names every test that drops with it (seen live:
  // one skip also dropped two healthy tests of the same spec).
  const runs = (f) => candidates.some((c) => c === f || inDir(f, c));
  const knownDriftSkipped = drift.filter((d) => (d.tests.length ? runs(d.file) : candidates.includes(d.file))).map((d) => (d.tests.length
    ? { ...d, wholeFile: false }
    : { ...d, wholeFile: true, tests: baselineTests[d.file] ?? [] }));
  const runSet = candidates.filter((f) => !knownDriftSkipped.some((d) => d.wholeFile && d.file === f)).sort();

  // `why` carries a manual AC's procedure: dropping it made the critic ask for it again (seen live).
  const acCoverage = suiteImpact.acCoverage.map((c) => ({ acId: c.acId, disposition: c.disposition, ref: c.ref ?? null, ...(c.why ? { why: c.why } : {}) }));
  const limitations = [];
  const capabilities = config.qa.capabilities ?? [];
  if (!['mixed', 'unknown'].includes(intake.changeType) && capabilities.length && !capabilities.includes(intake.changeType)) {
    limitations.push(`change type "${intake.changeType}" is not covered by this repo's QA suite (capabilities: ${capabilities.join(', ')})`);
  }
  if (route.unknownSuites.length) limitations.push(`unknown suites ignored: ${route.unknownSuites.join(', ')}`);
  for (const ac of intake.acceptanceCriteria.filter((a) => !a.testable)) limitations.push(`${ac.id} is not automatable: manual check required`);
  for (const d of knownDriftSkipped) {
    const why = d.reason ? ` (${d.reason})` : '';
    const titles = d.tests.map((t) => `"${t}"`).join(', ');
    limitations.push(d.wholeFile
      ? `known drift, not run: ${d.file}${why}${d.tests.length ? `; all ${d.tests.length} of its tests drop: ${titles}` : ''}`
      : `known drift, not run: ${d.tests.length} test(s) in ${d.file}${why}: ${titles}; its other tests run`);
    const missing = d.wholeFile || !baselineTests[d.file] ? [] : d.tests.filter((t) => !baselineTests[d.file].includes(t));
    if (missing.length) limitations.push(`known drift ${d.file}: no test titled ${missing.map((t) => `"${t}"`).join(', ')}, so nothing is skipped for it`);
  }
  // A directory entry (e.g. "client/e2e/api/") can't exclude one spec; Playwright runs it anyway.
  // (An entry with `tests` works there too: --grep-invert matches the file name.)
  for (const d of drift.filter((x) => !x.tests.length)) {
    const dir = runSet.find((f) => f !== d.file && inDir(d.file, f));
    if (dir) limitations.push(`known drift ${d.file} still runs: it is inside the run-set directory ${dir}`);
  }

  const body = { changeSet: { update, add, delete: del }, runSet, knownDriftSkipped, acCoverage, limitations, route: { changeType: intake.changeType, suites: route.suites } };
  // Coverage must be backed by the change set: an AC claimed as new/update needs an item citing it.
  const unbacked = acCoverage
    .filter((c) => (c.disposition === 'new' && !add.some((a) => a.acId === c.acId))
      || (c.disposition === 'update' && !update.some((u) => u.acId === c.acId)))
    .map((c) => `${c.acId} is marked "${c.disposition}" but no ${c.disposition === 'new' ? 'add' : 'update'} item cites it`);
  const problems = [
    ...unbacked,
    ...conflicts.map((f) => `${f} is both deleted and changed`),
    ...outside.map((f) => `${f} is outside the QA test dir ${testDir}`),
    ...(runSet.length ? [] : ['the run set is empty: nothing would be tested']),
  ];
  return { planHash: sha256(canonical(body)), ...body, problems };
}

if (isMain(import.meta.url)) {
  main(async (args) => {
    need(args, 'run', 'project');
    const baseline = readJson(path.join(args.run, 'suite-baseline.json'), { files: {} }).files ?? {};
    const plan = mergePlan({
      config: loadConfig(args.project),
      intake: readJson(path.join(args.run, 'intake.json')),
      suiteImpact: readJson(path.join(args.run, 'suite-impact.json')),
      changeAnalyst: readJson(path.join(args.run, 'change-analyst.json')),
      baselineFiles: Object.keys(baseline),
      baselineTests: Object.fromEntries(Object.entries(baseline).map(([f, v]) => [f, v.tests ?? []])),
    });
    if (plan.problems.length) {
      process.stderr.write(`plan has problems:\n- ${plan.problems.join('\n- ')}\n`);
      process.exit(1);
    }
    const { problems, ...out } = plan;
    writeJsonAtomic(path.join(args.run, 'plan.json'), out);
    const files = (items) => new Set(items.map((i) => i.file)).size;
    return {
      planHash: out.planHash,
      updateFiles: files(out.changeSet.update), addFiles: files(out.changeSet.add),
      addIntoExistingFiles: files(out.changeSet.add.filter((a) => a.intoExisting)),
      addFromCode: out.changeSet.add.filter((a) => a.source === 'code').length,
      deleteFiles: files(out.changeSet.delete), run: out.runSet.length, limitations: out.limitations,
    };
  });
}
