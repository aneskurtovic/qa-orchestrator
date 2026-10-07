// Restores one pre-existing QA spec to its run-start content, e.g. after the author replaced it and
// dropped its existing tests. The main session may not run git checkout (guard H9) or write
// the worktree (H4); this script is its only way back. The author then re-applies its planned
// change with Edit.
//
//   restore-spec.mjs --run <runDir> --project <projectDir> --file <repo-relative spec>
//
// Only files in suite-baseline.json (present at run start), inside the QA test dir and not an
// approved delete. The restored content must hash to the baseline entry, else exit 1.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UsageError, inDir, isMain, loadConfig, mustRun, need, posix, readJson } from './lib/common.mjs';

export function restoreSpec({ runner, config, baseline, plan, worktree, file }) {
  const rel = posix(file);
  if (!inDir(rel, config.qa.testDir)) throw new UsageError(`${rel} is outside the QA test dir ${config.qa.testDir}`);
  const before = baseline.files[rel];
  if (!before) throw new UsageError(`${rel} did not exist at run start (not in suite-baseline.json); only pre-existing specs can be restored`);
  if ((plan?.changeSet?.delete ?? []).some((d) => posix(d.file) === rel)) {
    throw new UsageError(`${rel} is an approved delete in this run's plan; it is not restored`);
  }
  mustRun(runner, 'git', ['-C', worktree, 'checkout', 'HEAD', '--', rel]);
  const sha = createHash('sha256').update(readFileSync(path.join(worktree, rel), 'utf8')).digest('hex').slice(0, 16);
  if (sha !== before.sha) throw new Error(`${rel} at HEAD differs from its run-start baseline (${sha} ≠ ${before.sha}); restore it by hand`);
  return { ok: true, file: rel, tests: before.tests?.length ?? null, expects: before.expects };
}

if (isMain(import.meta.url)) {
  const { main, realRunner } = await import('./lib/common.mjs');
  main(async (args) => {
    need(args, 'run', 'project', 'file');
    const active = readJson(path.join(args.project, '.qa-runs', 'active.json'));
    return restoreSpec({
      runner: realRunner,
      config: loadConfig(args.project),
      baseline: readJson(path.join(args.run, 'suite-baseline.json')),
      plan: readJson(path.join(args.run, 'plan.json'), null),
      worktree: active.worktree,
      file: args.file,
    });
  });
}
