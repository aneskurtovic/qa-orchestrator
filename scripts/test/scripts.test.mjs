// Tests for the deterministic scripts: node --test scripts/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { realRunner, mustRun, testTitles } from '../lib/common.mjs';
import { snapshotSuite } from '../lib/suite.mjs';
import { applyCommand, initialState } from '../state.mjs';
import { loadSchema, validateOutput } from '../validate.mjs';
import { validate } from '../lib/schema.mjs';
import { AGENTS } from '../brief.mjs';
import { mergePlan } from '../merge-plan.mjs';
import { diffSuite, missingTitles } from '../test-diff.mjs';
import { restoreSpec } from '../restore-spec.mjs';
import { applyDeletes } from '../apply-deletes.mjs';
import { cleanPass, deliverTests, hasChanges, marker, preApproved } from '../deliver-tests.mjs';
import { configProblems, withDefaults } from '../lib/config.mjs';
import { checkConfig } from '../check-config.mjs';

const config = {
  qa: { testDir: 'client/e2e', protectedFiles: ['client/e2e/playwright.config.ts'], capabilities: ['ui', 'api'] },
  git: { integrationBranch: 'demo/stage', protectedBranches: ['main', 'stage', 'demo/stage'] },
  suites: {
    smoke: ['client/e2e/home.spec.ts', 'client/e2e/promo.spec.ts'],
    ui: ['client/e2e/home.spec.ts'],
    a11y: ['client/e2e/a11y.spec.ts'],
    cart: ['client/e2e/cart.spec.ts'],
    api: ['client/e2e/api/'],
  },
  routes: { ui: ['smoke', 'ui', 'a11y'], api: ['smoke', 'api'], unknown: ['smoke'] },
};

const intake = {
  acceptanceCriteria: [
    { id: 'AC1', text: 'sort persists in URL', testable: true },
    { id: 'AC2', text: 'ELO renamed Rating', testable: true },
    { id: 'AC3', text: 'invalid sortBy → 400', testable: true },
  ],
  changeType: 'ui', affectedAreas: ['client/src/pages/CartPage.tsx'], ambiguities: [], confidence: 0.9,
};
const scen = [{ title: 't', steps: ['s'], expected: 'e' }];
const suiteImpact = {
  acCoverage: [{ acId: 'AC1', disposition: 'new' }, { acId: 'AC2', disposition: 'update' }, { acId: 'AC3', disposition: 'new' }],
  changeSet: {
    update: [{ file: 'client/e2e/cart.spec.ts', test: 'shows ELO', acId: 'AC2', why: 'renamed', intendedChange: 'expect Rating' }],
    add: [
      { file: 'client/e2e/cart-sort.spec.ts', kind: 'ui', acId: 'AC1', scenarios: scen },
      { file: 'client/e2e/api/cart.api.spec.ts', kind: 'api', acId: 'AC3', scenarios: scen },
    ],
    delete: [],
  },
  impactedExisting: ['client/e2e/cart.spec.ts'],
};
const changeAnalyst = {
  changedBehaviours: [{ file: 'server/Webapp.Api/Endpoints/CartEndpoints.cs', behaviour: 'limit parsing refactored' }],
  additionalScenarios: [{ kind: 'api', file: 'client/e2e/api/cart-limit.api.spec.ts', title: 'limit clamps', steps: ['GET ?limit=0'], expected: 'clamped to 1', codeRef: 'CartEndpoints.cs:78' }],
  regressionRisks: [{ area: 'cart', suggestedSuites: ['cart'] }],
  riskLevel: 'medium', touchesCriticalArea: false, criticalPaths: [],
};

// ── state.mjs ───────────────────────────────────────────────────────────────
test('state: G2 approval binds to the plan hash on disk; reserved fields are protected', () => {
  let s = initialState({ runId: 'r1', sessionId: 's1', key: 'PROJ-1', now: 't0' });
  s = applyCommand(s, 'phase', { _: ['phase', 'AWAITING_PLAN_APPROVAL'] }, { now: 't1' });
  assert.equal(s.phase, 'AWAITING_PLAN_APPROVAL');
  s = applyCommand(s, 'gate', { _: ['gate'], id: 'G2', decision: 'approved' }, { planJson: { planHash: 'sha256:x' }, now: 't2' });
  assert.equal(s.plan.approvedHash, 'sha256:x');
  assert.equal(s.gates[0].planHash, 'sha256:x');
  assert.throws(() => applyCommand(s, 'set', { _: ['set', 'plan.approvedHash', '"sha256:y"'] }), /managed by its own command/);
  assert.throws(() => applyCommand(s, 'phase', { _: ['phase', 'DONE'] }), /unknown phase/);
  assert.throws(() => applyCommand(s, 'gate', { _: ['gate'], id: 'G2', decision: 'approved' }, { planJson: null }), /planHash/);
  const t = applyCommand(s, 'set', { _: ['set', 'route', '{"changeType":"ui"}'] });
  assert.equal(t.route.changeType, 'ui');
  // An agent step's start is its brief's time; no timestamp from the model needed.
  const briefs = [{ step: 'intake', at: 't3' }, { step: 'critic-1', at: 't4' }];
  const u = applyCommand(s, 'timeline', { _: ['timeline'], step: 'critic-1', agent: 'qa-critic' }, { briefs, now: 't5' });
  assert.deepEqual([u.timeline.at(-1).startedAt, u.timeline.at(-1).finishedAt], ['t4', 't5']);
  // "Approve, and deliver if the run passes clean" is recorded on the G2 approval only.
  const pre = applyCommand(s, 'gate', { _: ['gate'], id: 'G2', decision: 'approved', deliverOnClean: true }, { planJson: { planHash: 'sha256:x' }, now: 't6' });
  assert.equal(pre.gates.at(-1).deliverOnClean, true);
  assert.throws(() => applyCommand(s, 'gate', { _: ['gate'], id: 'DELIVER', decision: 'approved', deliverOnClean: true }, { now: 't7' }), /only with a G2 approval/);
});

// ── validate.mjs ────────────────────────────────────────────────────────────
test('validate: fenced JSON is extracted; schema and cross-file errors are reported', () => {
  const ctx = { config, intake };
  const text = `Here you go\n\`\`\`json\n${JSON.stringify(intake)}\n\`\`\`\nDone.`;
  assert.equal(validateOutput('qa-intake', text, ctx).ok, true);
  assert.match(validateOutput('qa-intake', 'no json here', ctx).errors[0], /no ```json block/);
  const bad = validateOutput('qa-intake', JSON.stringify({ ...intake, confidence: 2, extra: 1 }), ctx);
  assert.ok(bad.errors.some((e) => /above 1/.test(e)) && bad.errors.some((e) => /unexpected "extra"/.test(e)));

  assert.equal(validateOutput('qa-suite-impact', JSON.stringify(suiteImpact), ctx).ok, true);
  const missingAc = { ...suiteImpact, acCoverage: suiteImpact.acCoverage.slice(0, 2) };
  assert.ok(validateOutput('qa-suite-impact', JSON.stringify(missingAc), ctx).errors.some((e) => /AC3 has no disposition/.test(e)));
  const outside = structuredClone(suiteImpact);
  outside.changeSet.add[0].file = 'client/src/pages/X.tsx';
  assert.ok(validateOutput('qa-suite-impact', JSON.stringify(outside), ctx).errors.some((e) => /outside the QA test dir/.test(e)));
  const unknownAc = structuredClone(suiteImpact);
  unknownAc.changeSet.update[0].acId = 'AC9';
  assert.ok(validateOutput('qa-suite-impact', JSON.stringify(unknownAc), ctx).errors.some((e) => /unknown acceptance criterion AC9/.test(e)));
  assert.equal(validateOutput('qa-change-analyst', JSON.stringify(changeAnalyst), ctx).ok, true);
  // Seen live: spec paths as suite names were dropped by the merge, and the QA PR said so wrongly.
  const pathAsSuite = { ...changeAnalyst, regressionRisks: [{ area: 'cart', suggestedSuites: ['client/e2e/cart.spec.ts'] }] };
  assert.ok(validateOutput('qa-change-analyst', JSON.stringify(pathAsSuite), ctx).errors.some((e) => /"client\/e2e\/cart\.spec\.ts" is not a configured suite/.test(e)));
  assert.equal(validateOutput('qa-suite-impact', JSON.stringify(suiteImpact), ctx).digest,
    'AC dispositions: new 2, update 1; update 1 files, add 2, delete 0');
});

test('validate --step: reads the handback the recorder saved, writes clean JSON only when valid; exit 3 when none was saved', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-val-'));
  const project = path.join(root, 'p');
  const run = path.join(project, '.qa-runs', 'PROJ-1', 'r1');
  mkdirSync(path.join(project, '.qa'), { recursive: true });
  mkdirSync(path.join(run, 'outputs'), { recursive: true });
  writeFileSync(path.join(project, '.qa', 'config.json'), JSON.stringify(config));
  const script = path.resolve(import.meta.dirname, '..', 'validate.mjs');
  const validateCli = (step, file = path.join(run, 'intake.json')) => spawnSync(process.execPath, [script, 'qa-intake', file, '--run', run, '--project', project, '--step', step], { encoding: 'utf8' });

  writeFileSync(path.join(run, 'outputs', 'intake.md'), `Handing back.\n\`\`\`json\n${JSON.stringify(intake)}\n\`\`\`\n`);
  const ok = validateCli('intake');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(run, 'intake.json'), 'utf8')), intake);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, digest: '3 ACs, change type ui, confidence 0.9, 0 ambiguities, 0 assumptions' });

  writeFileSync(path.join(run, 'outputs', 'intake-fix.md'), 'Ran out of turns before the JSON.');
  const bad = validateCli('intake-fix', path.join(run, 'intake-2.json'));
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).errors[0], /no ```json block/);
  assert.equal(existsSync(path.join(run, 'intake-2.json')), false, 'an invalid output is not written');

  const none = validateCli('critic-1', path.join(run, 'critic-1.json'));
  assert.equal(none.status, 3);
  assert.equal(JSON.parse(none.stdout).missing, true);
  rmSync(root, { recursive: true, force: true });
});

test('validate: a critic gap goes to intake, suite-impact or the change analyst, nowhere else', () => {
  const critic = (target) => JSON.stringify({ verdict: 'revise', gaps: [{ ref: 'ticket', problem: 'the reset bullet is no AC', fix: 'add an AC', target }] });
  const ctx = { config, intake };
  for (const target of ['qa-intake', 'qa-suite-impact', 'qa-change-analyst']) {
    const r = validateOutput('qa-critic', critic(target), ctx);
    assert.equal(r.ok, true, `${target}: ${JSON.stringify(r.errors)}`);
  }
  assert.equal(validateOutput('qa-critic', critic('qa-intake'), ctx).digest, 'revise, 1 gaps (qa-intake 1)');
  assert.equal(validateOutput('qa-critic', critic('qa-test-author'), ctx).ok, false);
});

test('validate: a defect must be a failed test triage called a defect; code-only remarks are findings', () => {
  const feedback = (over) => JSON.stringify({
    suiteChanges: { updated: [], added: [], deleted: [] }, acCoverage: [], results: { passed: 5, failed: 1, total: 6 },
    defects: [], findings: [], recommendedVerdict: 'QA Passed', qaPrMarkdown: 'x', jiraMarkdown: 'x', ...over,
  });
  const triage = { failures: [{ spec: 'client/e2e/cart.spec.ts', test: 'AC5 empty state at 50+', classification: 'defect' }] };
  const ctx = { config, intake, triage };
  // Seen live: an untested i18n remark was reported as a defect and alone made the verdict QA Failed.
  const untested = validateOutput('qa-feedback', feedback({ defects: [{ test: 'none: found in the diff', evidence: 'hardcoded English' }], recommendedVerdict: 'QA Failed' }), ctx);
  assert.ok(untested.errors.some((e) => /not a failed test that triage classified/.test(e)));
  const noBasis = validateOutput('qa-feedback', feedback({ recommendedVerdict: 'QA Failed', findings: [{ type: 'code-observation', detail: 'hardcoded English' }] }), ctx);
  assert.ok(noBasis.errors.some((e) => /QA Failed needs a defect/.test(e)));
  const ok = validateOutput('qa-feedback', feedback({ defects: [{ test: 'AC5 empty state at 50+', evidence: 'expected text' }], recommendedVerdict: 'QA Failed' }), ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.digest, 'recommends QA Failed; 1 defects, findings: none');
  // A flaky-suspected failure that failed its rerun is a defect in the final classification (state.json).
  const rerun = { failures: [{ spec: 'client/e2e/join.spec.ts', test: 'join by code', classification: 'flaky-suspected' }],
    final: [{ spec: 'client/e2e/join.spec.ts', classification: 'defect' }] };
  const fromFinal = validateOutput('qa-feedback', feedback({ defects: [{ test: 'join.spec.ts: join by code', evidence: 'failed twice' }], recommendedVerdict: 'QA Failed' }), { config, intake, triage: rerun });
  assert.equal(fromFinal.ok, true, JSON.stringify(fromFinal.errors));
  // A change-analyst observation must reach the report (seen live: shown at G2, missing in Jira).
  const analyst = { observations: [{ file: 'client/src/pages/CartPage.tsx', line: 341, note: 'English string' }] };
  const lost = validateOutput('qa-feedback', feedback({}), { config, intake, triage, changeAnalyst: analyst });
  assert.ok(lost.errors.some((e) => /observations\[0\] \(.*CartPage\.tsx:341\) needs a code-observation finding whose detail names CartPage\.tsx/.test(e)));
  // Seen live: each fix surfaced the next layer. Schema and semantic errors now come in one pass, and a
  // wrong type says what the right one holds.
  const layered = validateOutput('qa-feedback', feedback({ suiteChanges: [], ticket: 'PROJ-8', acCoverage: [{ acId: 'AC1', before: '-', after: '-', result: 'passed' }] }), { config, intake, triage, changeAnalyst: analyst });
  for (const re of [/suiteChanges: expected object with "updated", "added", "deleted", got array/, /result: must be one of .* \(got "passed"\)/,
    /unexpected "ticket" \(allowed: suiteChanges,/, /needs a code-observation finding/]) {
    assert.ok(layered.errors.some((e) => re.test(e)), `${re} in ${JSON.stringify(layered.errors)}`);
  }
  // Semantic checks on output of the wrong shape report what they can and never throw.
  assert.equal(validateOutput('qa-feedback', JSON.stringify({ defects: 'none', findings: {} }), { config, intake, triage, changeAnalyst: analyst }).ok, false);
  assert.equal(validateOutput('qa-suite-impact', JSON.stringify({ changeSet: [] }), { config, intake }).ok, false);
  const kept = validateOutput('qa-feedback', feedback({ recommendedVerdict: 'needs-human-judgment', findings: [{ type: 'code-observation', detail: 'CartPage.tsx:341 is still English; no test checks it' }] }), { config, intake, triage, changeAnalyst: analyst });
  assert.equal(kept.ok, true, JSON.stringify(kept.errors));
});

// Seen live: qa-feedback had no example, its brief said "shaped like the example in your instructions",
// and it guessed the shape: 5 dispatches before it validated.
test('agents: every agent file ends with a JSON example that passes its schema', () => {
  const agentsDir = path.resolve(import.meta.dirname, '..', '..', 'agents');
  for (const agent of AGENTS) {
    const text = readFileSync(path.join(agentsDir, `${agent}.md`), 'utf8');
    const contract = text.slice(text.search(/^Return exactly/m));
    const start = contract.search(/^\{/m);
    assert.ok(start > 0, `${agent}: no JSON example after "Return exactly…"`);
    const example = JSON.parse(contract.slice(start));
    assert.deepEqual(validate(loadSchema(agent), example), [], `${agent}: its example fails its schema`);
  }
});

// ── merge-plan.mjs ──────────────────────────────────────────────────────────
test('merge-plan: ticket + code proposals merge into one deterministic plan', () => {
  const plan = mergePlan({ config, intake, suiteImpact, changeAnalyst });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.changeSet.update.length, 1);
  assert.equal(plan.changeSet.add.length, 3);
  assert.equal(plan.changeSet.add.filter((a) => a.source === 'code').length, 1);
  assert.ok(plan.runSet.includes('client/e2e/home.spec.ts'), 'route suite ui → home');
  assert.ok(plan.runSet.includes('client/e2e/api/cart-limit.api.spec.ts'), 'code-sourced add runs');
  assert.deepEqual(plan.route.suites, ['smoke', 'ui', 'a11y', 'cart']);
  assert.equal(mergePlan({ config, intake, suiteImpact, changeAnalyst }).planHash, plan.planHash, 'stable hash');
  // New tests in a spec that existed at run start are marked, so G2 doesn't show it as a new file.
  const into = mergePlan({ config, intake, suiteImpact, changeAnalyst, baselineFiles: ['client/e2e/cart-sort.spec.ts'] });
  assert.deepEqual(into.changeSet.add.filter((a) => a.intoExisting).map((a) => a.file), ['client/e2e/cart-sort.spec.ts']);
  // An AC's why (a manual procedure) reaches the plan the critic reviews.
  const manual = structuredClone(suiteImpact);
  manual.acCoverage[2] = { acId: 'AC3', disposition: 'manual', why: 'Steps: open /cart in two tabs' };
  assert.equal(mergePlan({ config, intake, suiteImpact: manual, changeAnalyst }).acCoverage[2].why, 'Steps: open /cart in two tabs');
  assert.equal('why' in plan.acCoverage[0], false);
  const changed = structuredClone(suiteImpact);
  changed.changeSet.update[0].intendedChange = 'something else';
  assert.notEqual(mergePlan({ config, intake, suiteImpact: changed, changeAnalyst }).planHash, plan.planHash, 'any change → new hash');
});

test('merge-plan: several adds to one file are all kept; coverage without a backing item is a problem', () => {
  const si = structuredClone(suiteImpact);
  si.acCoverage.push({ acId: 'AC4', disposition: 'new' });
  si.changeSet.add.push({ file: 'client/e2e/cart-sort.spec.ts', kind: 'ui', acId: 'AC4', scenarios: [{ title: 'invalid sort falls back', steps: ['s'], expected: 'e' }] });
  const intake4 = { ...intake, acceptanceCriteria: [...intake.acceptanceCriteria, { id: 'AC4', text: 'invalid sort', testable: true }] };
  const plan = mergePlan({ config, intake: intake4, suiteImpact: si, changeAnalyst });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.changeSet.add.filter((a) => a.file === 'client/e2e/cart-sort.spec.ts').map((a) => a.acId), ['AC1', 'AC4']);

  const claimedOnly = structuredClone(si);
  claimedOnly.changeSet.add = claimedOnly.changeSet.add.filter((a) => a.acId !== 'AC4');
  assert.ok(mergePlan({ config, intake: intake4, suiteImpact: claimedOnly, changeAnalyst }).problems
    .some((p) => /AC4 is marked "new" but no add item cites it/.test(p)));
});

test('merge-plan: deletes leave the run set; conflicts, empty plans and uncovered change types are reported', () => {
  const withDelete = structuredClone(suiteImpact);
  withDelete.changeSet.delete.push({ file: 'client/e2e/promo.spec.ts', why: 'promo banner removed', evidence: 'diff removes PromoBanner' });
  const plan = mergePlan({ config, intake, suiteImpact: withDelete, changeAnalyst });
  assert.ok(!plan.runSet.includes('client/e2e/promo.spec.ts'));

  const conflict = structuredClone(withDelete);
  conflict.changeSet.delete.push({ file: 'client/e2e/cart.spec.ts', why: 'x', evidence: 'y' });
  assert.ok(mergePlan({ config, intake, suiteImpact: conflict, changeAnalyst }).problems.some((p) => /both deleted and changed/.test(p)));

  const covered = mergePlan({ config, intake: { ...intake, changeType: 'api' }, suiteImpact, changeAnalyst });
  assert.equal(covered.limitations.length, 0, 'api is a declared capability');
  const uncovered = mergePlan({ config, intake: { ...intake, changeType: 'auth' }, suiteImpact, changeAnalyst });
  assert.ok(uncovered.limitations.some((l) => /"auth" is not covered by this repo's QA suite/.test(l)));

  const empty = mergePlan({
    config: { ...config, routes: {} }, intake,
    suiteImpact: { ...suiteImpact, changeSet: { update: [], add: [], delete: [] }, impactedExisting: [] },
    changeAnalyst: { ...changeAnalyst, additionalScenarios: [], regressionRisks: [] },
  });
  assert.ok(empty.problems.some((p) => /run set is empty/.test(p)));

  // Without suites (a first setup), every run runs the whole QA test dir.
  const whole = mergePlan({
    config: { qa: config.qa }, intake,
    suiteImpact: { ...suiteImpact, changeSet: { update: [], add: [], delete: [] }, impactedExisting: [] },
    changeAnalyst: { ...changeAnalyst, additionalScenarios: [], regressionRisks: [{ suggestedSuites: ['smoke'] }] },
  });
  assert.deepEqual(whole.runSet, ['client/e2e/']);
  assert.ok(!whole.problems.some((p) => /run set is empty/.test(p)));
  assert.ok(!whole.limitations.some((l) => /unknown suites/.test(l)), 'no suites configured → nothing to call unknown');
});

// ── lib/config.mjs + check-config.mjs ──────────────────────────────────────
const fullExample = JSON.parse(readFileSync(new URL('../../config/examples/full-example.json', import.meta.url), 'utf8'));
const template = JSON.parse(readFileSync(new URL('../../config/qa.config.example.json', import.meta.url), 'utf8'));

test('config: defaults fill the optional keys; the Playwright config and integration branch are always protected', () => {
  const c = withDefaults({ git: { integrationBranch: 'stage' }, qa: { testDir: 'e2e', playwrightConfig: 'e2e/pw.config.ts', baseUrl: 'http://localhost:3000' } });
  assert.deepEqual(c.qa.protectedFiles, ['e2e/pw.config.ts']);
  assert.deepEqual(c.git.protectedBranches, ['main', 'master', 'stage']);
  assert.equal(c.git.devBranchKeyPattern, '(^|/){KEY}(-|$)');
  assert.deepEqual(c.stack.health, ['http://localhost:3000']);
  assert.equal(c.stack.healthTimeoutSec, 180);
  assert.equal(c.qa.apiTestDir, 'e2e');
  assert.match(c.qa.installCommand, /^npm ci/);
  assert.deepEqual(c.limits, { maxPlanRevisions: 2, maxTestLaunches: 7 });
  assert.deepEqual(c.suites, {});
  // An explicit list keeps its entries and still gains the two that must never change.
  const own = withDefaults({ git: { integrationBranch: 'dev', protectedBranches: ['release'] }, qa: { playwrightConfig: 'p.ts', protectedFiles: ['e2e/fixtures.ts'] } });
  assert.deepEqual(own.git.protectedBranches, ['release', 'dev']);
  assert.deepEqual(own.qa.protectedFiles, ['e2e/fixtures.ts', 'p.ts']);
  assert.deepEqual(withDefaults(withDefaults(fullExample)), withDefaults(fullExample), 'applying defaults twice changes nothing');
});

test('config: the full example is complete and clean; the template names every placeholder; old keys are flagged', () => {
  assert.deepEqual(configProblems(fullExample), { problems: [], warnings: [] });
  // The template is every required key as a placeholder: one message per key, nothing else.
  const t = configProblems(template);
  assert.equal(t.problems.length, 12);
  assert.ok(t.problems.every((p) => /is still a placeholder|allowedTransitionIds must be Jira transition ids/.test(p)), t.problems.join('\n'));
  assert.deepEqual(t.warnings, []);

  const old = configProblems({
    ...fullExample, schemaVersion: 1,
    jira: { ...fullExample.jira, site: 'https://x.atlassian.net', statuses: { ...fullExample.jira.statuses, passed: 'Done' } },
    routes: { ...fullExample.routes, 'checkout': ['smoke', 'nope'] },
    limits: { maxFlakyRetries: 1 },
  });
  assert.deepEqual(old.problems, []);
  for (const w of [/"schemaVersion" is not used/, /"jira\.site" is not used/, /"jira\.statuses\.passed" is not used/,
    /"limits\.maxFlakyRetries" is not used/, /routes\.checkout is never used/, /suite "nope"/]) {
    assert.ok(old.warnings.some((x) => w.test(x)), `expected a warning matching ${w}`);
  }
  assert.ok(configProblems({}).problems.length >= 12, 'an empty file lists every required key');
});

test('check-config: files must exist in the project; a Playwright config that ignores BASE_URL is a warning', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-cfg-'));
  mkdirSync(path.join(dir, '.qa'));
  mkdirSync(path.join(dir, 'web', 'e2e'), { recursive: true });
  writeFileSync(path.join(dir, '.qa', 'config.json'), JSON.stringify(fullExample));
  writeFileSync(path.join(dir, 'web/e2e/playwright.config.ts'), "export default { use: { baseURL: 'http://localhost:3000' } };");
  let out = checkConfig(dir);
  assert.equal(out.ok, false);
  assert.deepEqual(out.problems, [`stack.composeFile: docker-compose.qa.yml doesn't exist in ${dir}`]);
  assert.ok(out.warnings.some((w) => /doesn't read process\.env\.BASE_URL/.test(w)));
  assert.ok(out.warnings.some((w) => /suites\.smoke: web\/e2e\/home\.spec\.ts doesn't exist/.test(w)));

  writeFileSync(path.join(dir, 'docker-compose.qa.yml'), 'services: {}\n');
  writeFileSync(path.join(dir, 'web/e2e/playwright.config.ts'), "export default { use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' } };");
  out = checkConfig(dir);
  assert.equal(out.ok, true);
  assert.ok(!out.warnings.some((w) => /BASE_URL/.test(w)));
  rmSync(path.join(dir, '.qa', 'config.json'));
  assert.throws(() => checkConfig(dir), /qa-orchestrator:setup/);
  rmSync(dir, { recursive: true, force: true });
});

// ── test-diff.mjs ───────────────────────────────────────────────────────────
function suiteDir(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-suite-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  }
  return root;
}

test('test-diff: flags weakened, out-of-plan and missing changes; a clean run passes', () => {
  const before = suiteDir({
    'client/e2e/cart.spec.ts': 'expect(a).toBe(1); expect(b).toBe(2);',
    'client/e2e/home.spec.ts': 'expect(x).toBeTruthy();',
  });
  const baseline = snapshotSuite(before, 'client/e2e');
  const plan = mergePlan({ config, intake, suiteImpact, changeAnalyst });

  const good = suiteDir({
    'client/e2e/cart.spec.ts': 'expect(a).toBe(1); expect(b).toBe(3);',
    'client/e2e/home.spec.ts': 'expect(x).toBeTruthy();',
    'client/e2e/cart-sort.spec.ts': 'expect(url).toContain("sort");',
    'client/e2e/api/cart.api.spec.ts': 'expect(r.status()).toBe(400);',
    'client/e2e/api/cart-limit.api.spec.ts': 'expect(n).toBe(1);',
  });
  const clean = diffSuite({ baseline, current: snapshotSuite(good, 'client/e2e'), plan, outsideChanges: [] });
  assert.equal(clean.ok, true, JSON.stringify(clean.files));

  const bad = suiteDir({
    'client/e2e/cart.spec.ts': 'expect(a).toBe(1); test.skip("x", () => {});',
    'client/e2e/home.spec.ts': 'expect(x).toBeTruthy(); expect(y).toBeFalsy();',
    'client/e2e/cart-sort.spec.ts': 'expect(url).toContain("sort");',
  });
  const result = diffSuite({ baseline, current: snapshotSuite(bad, 'client/e2e'), plan, outsideChanges: ['client/src/pages/CartPage.tsx'] });
  const flags = (file) => result.files.find((f) => f.file === file)?.flags ?? [];
  assert.equal(result.ok, false);
  assert.ok(flags('client/e2e/cart.spec.ts').includes('assertions-decreased'));
  assert.ok(flags('client/e2e/cart.spec.ts').includes('weakening-marker-added'));
  assert.ok(flags('client/e2e/home.spec.ts').includes('out-of-plan'));
  assert.ok(flags('client/e2e/api/cart.api.spec.ts').includes('planned-change-missing'));
  assert.deepEqual(result.outsideTestDir.map((o) => o.file), ['client/src/pages/CartPage.tsx']);
  for (const d of [before, good, bad]) rmSync(d, { recursive: true, force: true });
});

test('test-diff: an "add" to an existing spec (appending tests) is in plan; removing its assertions is not', () => {
  const before = suiteDir({ 'client/e2e/a11y.spec.ts': 'expect(a).toBe(1);' });
  const baseline = snapshotSuite(before, 'client/e2e');
  const plan = { changeSet: { update: [], add: [{ file: 'client/e2e/a11y.spec.ts', acId: 'AC1' }], delete: [] } };
  const appended = suiteDir({ 'client/e2e/a11y.spec.ts': 'expect(a).toBe(1); expect(sortHeader).toHaveAttribute("aria-sort", "descending");' });
  assert.equal(diffSuite({ baseline, current: snapshotSuite(appended, 'client/e2e'), plan, outsideChanges: [] }).ok, true);
  const replaced = suiteDir({ 'client/e2e/a11y.spec.ts': 'test("only new", () => {});' });
  const r = diffSuite({ baseline, current: snapshotSuite(replaced, 'client/e2e'), plan, outsideChanges: [] });
  assert.ok(r.files[0].flags.includes('assertions-decreased'));
  for (const d of [before, appended, replaced]) rmSync(d, { recursive: true, force: true });
});

test('test-diff: a pre-existing spec that loses tests is flagged even when assertions grow', () => {
  const old = Array.from({ length: 8 }, (_, i) => `test('existing ${i}', async () => { expect(a${i}).toBe(1); });`).join('\n');
  const before = suiteDir({ 'client/e2e/checkout.spec.ts': old });
  const baseline = snapshotSuite(before, 'client/e2e');
  assert.equal(baseline.files['client/e2e/checkout.spec.ts'].tests.length, 8);
  const plan = { changeSet: { update: [{ file: 'client/e2e/checkout.spec.ts', acId: 'AC1' }], add: [], delete: [] } };
  // The author's first pass: a whole-file Write with only its 3 new tests, 12 assertions.
  const fresh = Array.from({ length: 3 }, (_, i) => `test('invite ${i}', async () => { ${'expect(x).toBe(1); '.repeat(4)}});`).join('\n');
  const rewritten = suiteDir({ 'client/e2e/checkout.spec.ts': fresh });
  const r = diffSuite({ baseline, current: snapshotSuite(rewritten, 'client/e2e'), plan, outsideChanges: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.files[0].flags, ['tests-removed']);
  assert.equal(r.files[0].testsRemoved.length, 8);
  // Appending keeps every title: clean.
  const appended = suiteDir({ 'client/e2e/checkout.spec.ts': `${old}\n${fresh}` });
  assert.equal(diffSuite({ baseline, current: snapshotSuite(appended, 'client/e2e'), plan, outsideChanges: [] }).ok, true);
  // A baseline from before titles were recorded can't be compared: no flag.
  const legacy = structuredClone(baseline);
  delete legacy.files['client/e2e/checkout.spec.ts'].tests;
  assert.ok(!diffSuite({ baseline: legacy, current: snapshotSuite(rewritten, 'client/e2e'), plan, outsideChanges: [] }).files[0].flags.includes('tests-removed'));
  for (const d of [before, rewritten, appended]) rmSync(d, { recursive: true, force: true });
});

test('test-diff: renaming the test an approved update names is not "tests-removed"; dropping another one is', () => {
  const before = suiteDir({ 'client/e2e/cart.spec.ts': "test('shows ELO', () => { expect(h).toBe('ELO'); });\ntest('sorts', () => { expect(s).toBe(1); });" });
  const baseline = snapshotSuite(before, 'client/e2e');
  const plan = { changeSet: { update: [{ file: 'client/e2e/cart.spec.ts', test: 'shows ELO', acId: 'AC2' }], add: [], delete: [] } };
  const renamed = suiteDir({ 'client/e2e/cart.spec.ts': "test('shows Rating', () => { expect(h).toBe('Rating'); });\ntest('sorts', () => { expect(s).toBe(1); });" });
  assert.equal(diffSuite({ baseline, current: snapshotSuite(renamed, 'client/e2e'), plan, outsideChanges: [] }).ok, true);
  const dropped = suiteDir({ 'client/e2e/cart.spec.ts': "test('shows Rating', () => { expect(h).toBe('Rating'); expect(x).toBe(1); });" });
  const r = diffSuite({ baseline, current: snapshotSuite(dropped, 'client/e2e'), plan, outsideChanges: [] });
  assert.deepEqual(r.files[0].testsRemoved, ['sorts']);
  for (const d of [before, renamed, dropped]) rmSync(d, { recursive: true, force: true });
});

test('test-diff: an update may name its test as "describe › title" (seen live: two planned renames went to G3)', () => {
  const tip = 'the paste-invite-link helper tip is visible under the room-code field on the /join/:roomCode deep-link route';
  const before = suiteDir({ 'client/e2e/checkout.spec.ts': `test.describe('join room — paste-invite-link tip (AC3)', () => {\n  test('${tip}', () => { expect(t).toBeVisible(); });\n  test('keeps', () => { expect(k).toBe(1); });\n});` });
  const baseline = snapshotSuite(before, 'client/e2e');
  const plan = { changeSet: { update: [{ file: 'client/e2e/checkout.spec.ts', test: `join room — paste-invite-link tip (AC3) › ${tip}`, acId: 'AC5' }], add: [], delete: [] } };
  const renamed = suiteDir({ 'client/e2e/checkout.spec.ts': "test('no Paste button on the deep link', () => { expect(b).toHaveCount(0); });\ntest('keeps', () => { expect(k).toBe(1); });" });
  assert.equal(diffSuite({ baseline, current: snapshotSuite(renamed, 'client/e2e'), plan, outsideChanges: [] }).ok, true);
  // A test the plan doesn't name still flags.
  const dropped = suiteDir({ 'client/e2e/checkout.spec.ts': "test('no Paste button on the deep link', () => { expect(b).toHaveCount(0); expect(c).toBe(1); });" });
  assert.deepEqual(diffSuite({ baseline, current: snapshotSuite(dropped, 'client/e2e'), plan, outsideChanges: [] }).files[0].testsRemoved, ['keeps']);
  for (const d of [before, renamed, dropped]) rmSync(d, { recursive: true, force: true });
});

test('test titles: every test(...) form counts, a title may repeat, describe/step do not count', () => {
  const text = [
    "test.describe('group', () => {",
    "  test('same', async () => {}); test('same', async () => {});",
    "  test.skip('it\\'s escaped', () => {}); test(\"say \\\"hi\\\"\", f); test(`tpl`, f);",
    "  test.step('not a test', f); test.beforeEach(f);",
    '});',
  ].join('\n');
  assert.deepEqual(testTitles(text), ['same', 'same', "it\\'s escaped", 'say \\"hi\\"', 'tpl']);
  assert.deepEqual(missingTitles(['same', 'same', 'x'], ['same', 'x']), ['same']);
});

test('merge-plan: known-drift specs leave the run set unless this run changes them, and the plan says so', () => {
  const drifting = {
    ...config,
    qa: { ...config.qa, knownDrift: [
      { file: 'client/e2e/a11y.spec.ts', reason: 'Play Locally is a Link now', since: '7f8a6bd' },
      { file: 'client/e2e/api/old.api.spec.ts', reason: 'x' },
      { file: 'client/e2e/cart.spec.ts', reason: 'drifted, but this run updates it' },
    ] },
  };
  const baselineTests = { 'client/e2e/a11y.spec.ts': ['cart keys', 'checkout a11y', 'playthrough a11y'] };
  const plan = mergePlan({ config: drifting, intake, suiteImpact, changeAnalyst, baselineTests });
  assert.ok(!plan.runSet.includes('client/e2e/a11y.spec.ts'));
  assert.deepEqual(plan.knownDriftSkipped, [{ file: 'client/e2e/a11y.spec.ts', reason: 'Play Locally is a Link now', since: '7f8a6bd', wholeFile: true, tests: baselineTests['client/e2e/a11y.spec.ts'] }]);
  assert.ok(plan.runSet.includes('client/e2e/cart.spec.ts'), 'a spec this run updates always runs');
  // A whole-file skip names every test it drops (seen live: a healthy cart test went unnoticed).
  assert.ok(plan.limitations.some((l) => /known drift, not run: client\/e2e\/a11y\.spec\.ts .*; all 3 of its tests drop: "cart keys", "checkout a11y", "playthrough a11y"/.test(l)));
  // With `tests`, the spec runs and only those tests are skipped; a title not in the spec is said.
  const perTest = { ...config, qa: { ...config.qa, knownDrift: [{ file: 'client/e2e/a11y.spec.ts', reason: 'PROJ-7', tests: ['playthrough a11y', 'gone'] }] } };
  const partial = mergePlan({ config: perTest, intake, suiteImpact, changeAnalyst, baselineTests });
  assert.ok(partial.runSet.includes('client/e2e/a11y.spec.ts'));
  assert.deepEqual(partial.knownDriftSkipped, [{ file: 'client/e2e/a11y.spec.ts', reason: 'PROJ-7', since: null, tests: ['playthrough a11y', 'gone'], wholeFile: false }]);
  assert.ok(partial.limitations.some((l) => /not run: 2 test\(s\) in client\/e2e\/a11y\.spec\.ts \(PROJ-7\): "playthrough a11y", "gone"; its other tests run/.test(l)));
  assert.ok(partial.limitations.some((l) => /no test titled "gone"/.test(l)));
  const withApiDir = mergePlan({ config: drifting, intake: { ...intake, changeType: 'api' }, suiteImpact, changeAnalyst });
  assert.ok(withApiDir.limitations.some((l) => /old\.api\.spec\.ts still runs: it is inside the run-set directory client\/e2e\/api\//.test(l)));
  assert.notEqual(plan.planHash, mergePlan({ config, intake, suiteImpact, changeAnalyst }).planHash, 'skips are part of the approved plan');
});

test('merge-plan: a test-level known-drift skip survives an update to another test in its spec, not one to that test', () => {
  const perTest = { ...config, qa: { ...config.qa, knownDrift: [
    { file: 'client/e2e/a11y.spec.ts', reason: 'PROJ-7', tests: ['playthrough a11y', 'cart keys'] },
    { file: 'client/e2e/cart.spec.ts', reason: 'whole spec, and this run updates it' },
  ] } };
  const baselineTests = { 'client/e2e/a11y.spec.ts': ['cart keys', 'checkout a11y', 'playthrough a11y'] };
  const updating = (test) => ({ ...suiteImpact, changeSet: { ...suiteImpact.changeSet, update: [
    ...suiteImpact.changeSet.update,
    { file: 'client/e2e/a11y.spec.ts', test, acId: 'AC1', why: 'the tip is gone', intendedChange: 'wait for the button' },
  ] } });
  // Seen live: the plan updated the /checkout test (named as "describe › title"); the playthrough must stay out.
  const other = mergePlan({ config: perTest, intake, suiteImpact: updating('a11y › checkout a11y'), changeAnalyst, baselineTests });
  assert.deepEqual(other.knownDriftSkipped, [{ file: 'client/e2e/a11y.spec.ts', reason: 'PROJ-7', since: null, tests: ['playthrough a11y', 'cart keys'], wholeFile: false }]);
  assert.ok(other.runSet.includes('client/e2e/a11y.spec.ts'));
  // An update that names a drifting test takes only that test out of the skip.
  const named = mergePlan({ config: perTest, intake, suiteImpact: updating('a11y › playthrough a11y'), changeAnalyst, baselineTests });
  assert.deepEqual(named.knownDriftSkipped.map((d) => d.tests), [['cart keys']]);
  // A whole-spec entry still lapses when the run changes that spec.
  assert.ok(!other.knownDriftSkipped.some((d) => d.file === 'client/e2e/cart.spec.ts'));
  assert.ok(other.runSet.includes('client/e2e/cart.spec.ts'));
});

// ── apply-deletes.mjs + deliver-tests.mjs against a real git repo ───────────
function gitRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'qa-git-'));
  const git = (...args) => mustRun(realRunner, 'git', ['-C', repo, ...args]);
  git('init', '-q', '-b', 'demo/stage');
  git('config', 'user.name', 'QA Test');
  git('config', 'user.email', 'qa@example.test');
  mkdirSync(path.join(repo, 'client', 'e2e'), { recursive: true });
  writeFileSync(path.join(repo, 'client/e2e/cart.spec.ts'), 'expect(a).toBe("ELO");');
  writeFileSync(path.join(repo, 'client/e2e/promo.spec.ts'), 'expect(c).toBe(1);');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'qa/PROJ-1-cart-sort');
  return { repo, git, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

// Real git, except push and gh which would need a remote.
function runnerFor(calls, { prs = '[]' } = {}) {
  return (cmd, args, opts) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args.includes('push')) return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'gh' && args[1] === 'list') return { status: 0, stdout: prs, stderr: '' };
    if (cmd === 'gh' && args[1] === 'create') return { status: 0, stdout: 'https://github.com/o/r/pull/77\n', stderr: '' };
    if (cmd === 'gh') return { status: 0, stdout: '', stderr: '' }; // comment / edit / ready
    return realRunner(cmd, args, opts);
  };
}

test('apply-deletes: only approved deletions under the QA dir, never before G2', () => {
  const { repo, git, cleanup } = gitRepo();
  const plan = { planHash: 'h1', changeSet: { update: [], add: [], delete: [{ file: 'client/e2e/promo.spec.ts' }] } };
  assert.throws(() => applyDeletes({ runner: realRunner, config, plan, state: { plan: { approvedHash: null } }, worktree: repo }), /not approved/);
  const out = applyDeletes({ runner: realRunner, config, plan, state: { plan: { approvedHash: 'h1' } }, worktree: repo });
  assert.deepEqual(out.deleted, [{ file: 'client/e2e/promo.spec.ts', status: 'deleted' }]);
  assert.equal(existsSync(path.join(repo, 'client/e2e/promo.spec.ts')), false);
  assert.match(git('status', '--porcelain'), /^D {2}client\/e2e\/promo\.spec\.ts/m);
  const outside = { ...plan, changeSet: { ...plan.changeSet, delete: [{ file: 'client/src/App.tsx' }] } };
  assert.throws(() => applyDeletes({ runner: realRunner, config, plan: outside, state: { plan: { approvedHash: 'h1' } }, worktree: repo }), /outside/);
  cleanup();
});

test('restore-spec: puts a damaged pre-existing spec back to its run-start content, nothing else', () => {
  const { repo, cleanup } = gitRepo();
  const baseline = snapshotSuite(repo, 'client/e2e');
  const plan = { changeSet: { update: [], add: [], delete: [{ file: 'client/e2e/promo.spec.ts' }] } };
  const spec = path.join(repo, 'client/e2e/cart.spec.ts');
  writeFileSync(spec, 'test("only the new one", () => {});');
  const out = restoreSpec({ runner: realRunner, config, baseline, plan, worktree: repo, file: 'client\\e2e\\cart.spec.ts' });
  assert.equal(out.file, 'client/e2e/cart.spec.ts');
  assert.equal(readFileSync(spec, 'utf8'), 'expect(a).toBe("ELO");');
  writeFileSync(path.join(repo, 'client/e2e/new.spec.ts'), 'x');
  assert.throws(() => restoreSpec({ runner: realRunner, config, baseline, plan, worktree: repo, file: 'client/e2e/new.spec.ts' }), /did not exist at run start/);
  assert.throws(() => restoreSpec({ runner: realRunner, config, baseline, plan, worktree: repo, file: 'client/e2e/promo.spec.ts' }), /approved delete/);
  assert.throws(() => restoreSpec({ runner: realRunner, config, baseline, plan, worktree: repo, file: 'client/src/App.tsx' }), /outside the QA test dir/);
  cleanup();
});

test('deliver-tests: commits only approved QA files on the qa branch, pushes it, opens a (draft) QA PR once', () => {
  const { repo, git, cleanup } = gitRepo();
  const runDir = mkdtempSync(path.join(tmpdir(), 'qa-run-'));
  writeFileSync(path.join(repo, 'client/e2e/cart.spec.ts'), 'expect(a).toBe("Rating");');
  writeFileSync(path.join(repo, 'client/e2e/cart-sort.spec.ts'), 'expect(u).toContain("sort");');
  const plan = {
    planHash: 'h1',
    changeSet: { update: [{ file: 'client/e2e/cart.spec.ts' }], add: [{ file: 'client/e2e/cart-sort.spec.ts' }], delete: [] },
  };
  const approvedState = {
    runId: 'run-42', ticket: { key: 'PROJ-1', title: 'Cart sort' }, plan: { approvedHash: 'h1' },
    gates: [{ id: 'G2', decision: 'approved' }, { id: 'DELIVER', decision: 'approved' }],
  };
  const active = { key: 'PROJ-1', qaBranch: 'qa/PROJ-1-cart-sort', worktree: repo };
  const feedback = { recommendedVerdict: 'QA Failed', qaPrMarkdown: '## QA report' };

  assert.throws(() => deliverTests({ runner: runnerFor([]), config, plan, state: { ...approvedState, gates: [] }, active, feedback, runDir }), /DELIVER/);
  assert.throws(() => deliverTests({ runner: runnerFor([]), config, plan, state: approvedState, active: { ...active, qaBranch: 'demo/stage' }, feedback, runDir }), /does not match/);

  const calls = [];
  const out = deliverTests({ runner: runnerFor(calls), config, plan, state: approvedState, active, feedback, runDir });
  assert.equal(out.pr.number, 77);
  assert.equal(out.pr.draft, true, 'QA Failed → draft PR');
  assert.ok(calls.some((c) => c === 'git -C ' + repo + ' push -u origin qa/PROJ-1-cart-sort:qa/PROJ-1-cart-sort'));
  assert.ok(calls.some((c) => c.startsWith('gh pr create --base demo/stage --head qa/PROJ-1-cart-sort') && c.endsWith('--draft')));
  assert.match(git('log', '-1', '--format=%B'), /^test\(qa\): PROJ-1 Cart sort[\s\S]*QA-Run: run-42/);
  assert.match(git('log', '-1', '--format=%B'), /1 updated, 1 added, 0 deleted files\./, 'counts files from git, not plan entries');
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['client/e2e/cart-sort.spec.ts', 'client/e2e/cart.spec.ts']);

  // The base is the branch the run tested, even if the checkout's config now names another one.
  const moved = [];
  deliverTests({ runner: runnerFor(moved, { prs: '[]' }), config: { ...config, git: { ...config.git, integrationBranch: 'stage' } },
    plan, state: { ...approvedState, tested: { branch: 'demo/stage', sha: 'x' } }, active, feedback, runDir });
  assert.ok(moved.some((c) => c.startsWith('gh pr create --base demo/stage ')), 'QA PR targets the tested branch');

  // Rerun after a crash: same commit, existing PR found by its marker, no new PR.
  const again = [];
  const out2 = deliverTests({ runner: runnerFor(again, { prs: JSON.stringify([{ number: 77, url: 'u', body: `x ${marker('run-42')}`, isDraft: true }]) }), config, plan, state: approvedState, active, feedback, runDir });
  assert.equal(out2.commit, out.commit);
  assert.ok(!again.some((c) => c.startsWith('gh pr create')));

  // Re-test with no new test changes: still pushes, then updates the SAME open PR (comment, body,
  // draft → ready for a pass) instead of creating a second one.
  const re = [];
  const retestState = { ...approvedState, runId: 'run-99', qa: { retest: { previousPr: 136 } }, tested: { branch: 'demo/stage', sha: 'abcdef1234' } };
  const reOut = deliverTests({
    runner: runnerFor(re, { prs: JSON.stringify([{ number: 136, url: 'https://github.com/o/r/pull/136', body: 'old report', isDraft: true, state: 'OPEN' }]) }),
    config, plan: { ...plan, changeSet: { update: [], add: [], delete: [] } }, state: retestState, active, feedback: { recommendedVerdict: 'QA Passed', qaPrMarkdown: '## now green' }, runDir,
  });
  assert.equal(reOut.pr.number, 136);
  assert.equal(reOut.pr.updated, true);
  assert.equal(reOut.pr.draft, false);
  assert.ok(re.some((c) => c.includes(' push -u origin ')), 'pushed even without new tests');
  assert.ok(re.some((c) => c.startsWith('gh pr comment 136 --body QA re-test run run-99: **QA Passed**')));
  assert.ok(re.some((c) => c.startsWith('gh pr edit 136 --body-file')));
  assert.ok(re.includes('gh pr ready 136'));
  assert.ok(!re.some((c) => c.startsWith('gh pr create')), 'no second PR');

  // A first run whose plan changes no QA test has nothing to deliver: a result, not an error, and
  // no git or gh call, whatever DELIVER says.
  const empty = { ...plan, changeSet: { update: [], add: [], delete: [] } };
  assert.equal(hasChanges(empty, approvedState), false);
  assert.equal(hasChanges(empty, retestState), true, 'a re-test still pushes the merged-in base');
  assert.equal(hasChanges(plan, approvedState), true);
  const none = [];
  const noOut = deliverTests({ runner: runnerFor(none), config, plan: empty, state: { ...approvedState, gates: [{ id: 'G2', decision: 'approved' }] }, active, feedback, runDir });
  assert.deepEqual({ delivered: noOut.delivered, reason: noOut.reason, pr: noOut.pr, commit: noOut.commit }, { delivered: false, reason: 'no QA test changes in this run', pr: null, commit: null });
  assert.deepEqual(none, []);
  assert.equal(out.delivered, true);

  // A stray change outside the plan blocks delivery.
  writeFileSync(path.join(repo, 'client/e2e/home.spec.ts'), 'expect(1).toBe(1);');
  assert.throws(() => deliverTests({ runner: runnerFor([]), config, plan, state: { ...approvedState, runId: 'run-43' }, active, feedback, runDir }), /outside the approved change set: client\/e2e\/home\.spec\.ts/);
  cleanup();
  rmSync(runDir, { recursive: true, force: true });
});

test('deliver-tests: a clean pass is decided from script-written files; each reason blocks it on its own', () => {
  const state = { devChanges: [{ pr: 148 }], gates: [{ id: 'G2', decision: 'approved' }] };
  const feedback = { recommendedVerdict: 'QA Passed', defects: [] };
  const firstRun = { status: 'completed', counts: { passed: 35, failed: 0 } };
  const devPrs = [{ number: 148, headRefName: 'feature/PROJ-9-x' }];
  assert.deepEqual(cleanPass({ state, feedback, firstRun, devPrs }), { clean: true, stale: false, reasons: [] });
  const blocked = (over) => cleanPass({ state, feedback, firstRun, devPrs, ...over });
  assert.match(blocked({ feedback: { ...feedback, recommendedVerdict: 'needs-human-judgment' } }).reasons[0], /not QA Passed/);
  assert.match(blocked({ feedback: { ...feedback, defects: [{ test: 't' }] } }).reasons[0], /1 defect/);
  assert.match(blocked({ firstRun: { status: 'completed', counts: { failed: 2 } } }).reasons[0], /0 failures/);
  assert.match(blocked({ firstRun: null }).reasons[0], /no runner-1\.json/);
  assert.match(blocked({ state: { ...state, gates: [...state.gates, { id: 'G3', decision: 'accepted-diff' }] } }).reasons[0], /needed G3/);
  const stale = blocked({ devPrs: [...devPrs, { number: 150, headRefName: 'fix/PROJ-9-y' }] });
  assert.equal(stale.stale, true);
  assert.match(stale.reasons[0], /STALE: new dev work merged during the run \(#150\)/);
});

test('deliver-tests: G2 "deliver if clean" delivers a clean pass without DELIVER, and nothing else', () => {
  const { repo, cleanup } = gitRepo();
  const runDir = mkdtempSync(path.join(tmpdir(), 'qa-run-'));
  writeFileSync(path.join(repo, 'client/e2e/cart.spec.ts'), 'expect(a).toBe("Rating");');
  const plan = { planHash: 'h1', changeSet: { update: [{ file: 'client/e2e/cart.spec.ts' }], add: [], delete: [] } };
  const g2 = { id: 'G2', decision: 'approved', planHash: 'h1', deliverOnClean: true };
  const state = { runId: 'run-7', ticket: { key: 'PROJ-1' }, plan: { approvedHash: 'h1' }, gates: [g2] };
  const active = { key: 'PROJ-1', qaBranch: 'qa/PROJ-1-cart-sort', worktree: repo };
  const feedback = { recommendedVerdict: 'QA Passed', qaPrMarkdown: '## ok' };
  assert.equal(preApproved(state, plan), true);
  assert.equal(preApproved(state, { ...plan, planHash: 'h2' }), false, 'bound to the approved plan');
  assert.throws(() => deliverTests({ runner: runnerFor([]), config, plan, state, active, feedback, runDir, check: { clean: false, reasons: ['1 defect(s)'] } }),
    /G2 pre-approved a clean pass, but 1 defect\(s\)/);
  assert.throws(() => deliverTests({ runner: runnerFor([]), config, plan, state: { ...state, gates: [{ ...g2, deliverOnClean: undefined }] }, active, feedback, runDir, check: { clean: true } }), /gate DELIVER/);
  const out = deliverTests({ runner: runnerFor([]), config, plan, state, active, feedback, runDir, check: { clean: true, reasons: [] } });
  assert.equal(out.approvedAt, 'G2 (clean pass)');
  assert.equal(out.pr.number, 77);
  cleanup();
  rmSync(runDir, { recursive: true, force: true });
});
