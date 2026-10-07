// Removes the QA tests the approved plan deletes (docs/design.md §5 step 5).
// The only way a test file is deleted during a run.
//
//   apply-deletes.mjs --run <runDir> --project <projectDir>
import { existsSync } from 'node:fs';
import path from 'node:path';
import { inDir, isMain, loadConfig, mustRun, need, readJson } from './lib/common.mjs';

export function applyDeletes({ runner, config, plan, state, worktree }) {
  if (!plan?.planHash || state.plan?.approvedHash !== plan.planHash) {
    throw new Error('the plan is not approved at G2 (planHash ≠ approvedHash); nothing is deleted');
  }
  const deleted = [];
  for (const item of plan.changeSet.delete) {
    if (!inDir(item.file, config.qa.testDir)) throw new Error(`${item.file} is outside ${config.qa.testDir}`);
    if ((config.qa.protectedFiles ?? []).includes(item.file)) throw new Error(`${item.file} is protected`);
    if (!existsSync(path.join(worktree, item.file))) { deleted.push({ file: item.file, status: 'already-absent' }); continue; }
    mustRun(runner, 'git', ['-C', worktree, 'rm', '-q', '--', item.file]);
    deleted.push({ file: item.file, status: 'deleted' });
  }
  return { deleted };
}

if (isMain(import.meta.url)) {
  const { main, realRunner } = await import('./lib/common.mjs');
  main(async (args) => {
    need(args, 'run', 'project');
    const active = readJson(path.join(args.project, '.qa-runs', 'active.json'));
    return applyDeletes({
      runner: realRunner,
      config: loadConfig(args.project),
      plan: readJson(path.join(args.run, 'plan.json')),
      state: readJson(path.join(args.run, 'state.json')),
      worktree: active.worktree,
    });
  });
}
