// Validates one worker output against its contract, then writes it to <file> as
// clean JSON so later steps read plain JSON.
//
//   validate.mjs <schema-name> <file> --run <runDir> --project <projectDir> [--step <step>]
//
// With --step the output is the agent's handback that the recorder hook saved to
// RUN/outputs/<step>.md, and <file> is written only when it is valid. Without it,
// <file> itself holds the output (a saved-by-hand fallback, or re-validating on resume).
// Exit 0 + {"ok":true,"digest"} when valid. Exit 3 + {"missing":true} when --step has no saved output.
// Exit 1 + {"ok":false,"errors":[…]} otherwise, schema and semantic errors in one list; the main
// session re-prompts the agent with those errors, then asks G3 (docs/design.md §4).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, inDir, isMain, loadConfig, need, readJson, writeJsonAtomic } from './lib/common.mjs';
import { extractJson, validate } from './lib/schema.mjs';

const schemasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

export function loadSchema(name) {
  try { return readJson(path.join(schemasDir, `${name}.schema.json`)); } catch {
    throw new UsageError(`unknown schema "${name}"`);
  }
}

// Checks a JSON Schema can't express: references between files and repo paths. They also run on
// output the schema rejected, so one fix dispatch sees every error (seen live: the semantic error
// appeared only on the fourth fix). Hence `list`/`obj` for every value the schema may not have checked.
const list = (x) => (Array.isArray(x) ? x : []);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

export function semanticErrors(name, raw, { intake, config, triage, changeAnalyst }) {
  const errors = [];
  const data = obj(raw);
  const testDir = config?.qa?.testDir;
  const acIds = new Set((intake?.acceptanceCriteria ?? []).map((a) => a.id));
  const underTestDir = (file, where) => {
    if (testDir && typeof file === 'string' && !inDir(file, testDir)) errors.push(`${where}: ${file} is outside the QA test dir ${testDir}`);
  };
  const knownAc = (id, where) => {
    if (id && acIds.size && !acIds.has(id)) errors.push(`${where}: unknown acceptance criterion ${id}`);
  };

  if (name === 'qa-intake') {
    const ids = list(data.acceptanceCriteria).map((a) => obj(a).id);
    if (new Set(ids).size !== ids.length) errors.push('acceptanceCriteria: duplicate ids');
  }
  if (name === 'qa-suite-impact') {
    const coverage = list(data.acCoverage).map(obj);
    const covered = new Set(coverage.map((c) => c.acId));
    for (const id of acIds) if (!covered.has(id)) errors.push(`acCoverage: ${id} has no disposition`);
    coverage.forEach((c, i) => knownAc(c.acId, `acCoverage[${i}]`));
    const changeSet = obj(data.changeSet);
    for (const kind of ['update', 'add', 'delete']) {
      list(changeSet[kind]).map(obj).forEach((item, i) => {
        underTestDir(item.file, `changeSet.${kind}[${i}]`);
        knownAc(item.acId, `changeSet.${kind}[${i}]`);
      });
    }
    list(changeSet.update).map(obj).forEach((item, i) => { if (!item.acId) errors.push(`changeSet.update[${i}]: an update must cite the AC that changes the expectation`); });
  }
  if (name === 'qa-change-analyst') {
    list(data.additionalScenarios).forEach((s, i) => underTestDir(obj(s).file, `additionalScenarios[${i}]`));
    // File paths here were dropped by the merge as "unknown suites", and the QA PR then said the
    // ticket's specs were in no suite (seen live).
    const suites = Object.keys(config?.suites ?? {});
    list(data.regressionRisks).forEach((r, i) => list(obj(r).suggestedSuites).forEach((s) => {
      if (!suites.includes(s)) errors.push(`regressionRisks[${i}].suggestedSuites: "${s}" is not a configured suite (${suites.join(', ') || 'none'})`);
    }));
  }
  if (name === 'qa-test-author') {
    list(data.filesChanged).forEach((f, i) => underTestDir(obj(f).file, `filesChanged[${i}]`));
  }
  if (name === 'qa-feedback') {
    // A defect is a failed test that triage classified as one. Something seen only in the code has no
    // failing test and is a `code-observation` finding (seen live: an untested i18n remark alone made
    // the verdict QA Failed).
    // The final classification is the one the orchestrator recorded in state.json (a flaky rerun
    // that failed, or a G3 "It's a defect", changes it); triage.json holds only the first pass.
    const final = Array.isArray(triage?.final) && triage.final.length ? triage.final : (triage?.failures ?? []);
    const triaged = final.filter((f) => f.classification === 'defect');
    const names = (f) => [f.test, f.spec, f.spec && path.basename(String(f.spec))].filter(Boolean).map(String);
    const defects = list(data.defects).map(obj);
    const findings = list(data.findings).map(obj);
    defects.forEach((d, i) => {
      const test = String(d.test ?? '');
      const matches = test && triaged.some((f) => names(f).some((n) => test.includes(n) || n.includes(test)));
      if (!matches) errors.push(`defects[${i}]: "${test}" is not a failed test that triage classified as a defect. An observation without a failing test goes in findings as code-observation`);
    });
    // What the change analyst saw only in the code reaches the human (seen live: shown at G2, missing in Jira).
    const observed = findings.filter((f) => f.type === 'code-observation').map((f) => String(f.detail ?? ''));
    (changeAnalyst?.observations ?? []).forEach((o, i) => {
      const base = path.basename(String(o.file));
      if (!observed.some((d) => d.includes(base))) errors.push(`findings: change-analyst observations[${i}] (${o.file}:${o.line ?? '?'}) needs a code-observation finding whose detail names ${base}`);
    });
    const failing = defects.length || findings.some((f) => f.type === 'req-not-implemented');
    if (data.recommendedVerdict === 'QA Failed' && !failing) errors.push('recommendedVerdict: QA Failed needs a defect or a req-not-implemented finding');
  }
  return errors;
}

// One line per agent result (the numbers, not "see the JSON").
export function digest(name, d) {
  const count = (xs, key) => Object.entries(xs.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const files = (xs) => new Set(xs.map((x) => x.file)).size;
  switch (name) {
    case 'qa-intake': return `${d.acceptanceCriteria.length} ACs, change type ${d.changeType}, confidence ${d.confidence}, ${d.ambiguities?.length ?? 0} ambiguities, ${d.assumptions?.length ?? 0} assumptions`;
    case 'qa-suite-impact': return `AC dispositions: ${count(d.acCoverage, 'disposition')}; update ${files(d.changeSet.update)} files, add ${files(d.changeSet.add)}, delete ${files(d.changeSet.delete)}`;
    case 'qa-change-analyst': return `${d.changedBehaviours.length} changed behaviours, ${d.additionalScenarios.length} extra scenarios in ${files(d.additionalScenarios)} files, risk ${d.riskLevel}, ${d.criticalPaths?.length ?? 0} critical paths, ${d.observations?.length ?? 0} code observations`;
    case 'qa-critic': return `${d.verdict}, ${d.gaps.length} gaps (${count(d.gaps, 'target')})`;
    case 'qa-test-author': return `${d.filesChanged.length} files changed`;
    case 'qa-triage': return `${d.failures.length} failures: ${count(d.failures, 'classification')}`;
    case 'qa-feedback': return `recommends ${d.recommendedVerdict}; ${d.defects.length} defects, findings: ${count(d.findings, 'type')}`;
    default: return '';
  }
}

export function validateOutput(name, rawText, context) {
  let data;
  try { data = extractJson(rawText); } catch (err) { return { ok: false, errors: [err.message] }; }
  const errors = validate(loadSchema(name), data);
  try { errors.push(...semanticErrors(name, data, context)); } catch { /* a shape the schema errors already name */ }
  if (errors.length) return { ok: false, errors };
  let summary = '';
  try { summary = digest(name, data); } catch { /* a digest never fails validation */ }
  return { ok: true, data, digest: summary };
}

if (isMain(import.meta.url)) {
  const args = (await import('./lib/common.mjs')).parseArgs(process.argv.slice(2));
  try {
    need(args, 'run', 'project');
    const [name, file] = args._;
    if (!name || !file) throw new UsageError('usage: validate.mjs <schema> <file> --run <runDir> --project <projectDir> [--step <step>]');
    const source = typeof args.step === 'string' ? path.join(args.run, 'outputs', `${args.step}.md`) : file;
    if (source !== file && !existsSync(source)) {
      const errors = [`no saved output for step ${args.step} (${source}). The recorder hook saves the agent's handback when it stops; save it yourself to ${file} and validate without --step.`];
      process.stdout.write(`${JSON.stringify({ ok: false, missing: true, errors }, null, 2)}\n`);
      process.exit(3);
    }
    const context = {
      config: loadConfig(args.project),
      intake: readJson(path.join(args.run, 'intake.json'), null),
      changeAnalyst: readJson(path.join(args.run, 'change-analyst.json'), null),
      triage: { ...readJson(path.join(args.run, 'triage.json'), {}), final: readJson(path.join(args.run, 'state.json'), {}).triage ?? null },
    };
    const result = validateOutput(name, readFileSync(source, 'utf8'), context);
    if (result.ok) writeJsonAtomic(file, result.data);
    process.stdout.write(`${JSON.stringify(result.ok ? { ok: true, digest: result.digest } : result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
