// Delivers the QA test changes (docs/design.md §5 step 9): one commit on the run's
// qa/<KEY>-<slug> branch, a push of that branch only, and the QA PR into the
// integration branch. The only GitHub write in a run. Idempotent: rerunning
// after a crash reuses the commit and the PR (found by the run marker).
//
//   deliver-tests.mjs --run <runDir> --project <projectDir> [--check]
//
// Requires: G2 approved for the current plan, and either a DELIVER gate approved by the human or,
// when the human chose "Approve, and deliver if the run passes clean" at G2, a clean pass.
// A plan that changes no QA test (and isn't a re-test) has nothing to deliver: it returns
// { delivered: false, reason } and touches nothing, before any approval check.
// --check only reports { clean, stale, reasons, preApproved, changes } (read-only); the playbook
// uses it for the stale check, to decide whether to ask DELIVER, and to skip delivery with no changes.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { inDir, isMain, loadConfig, mustRun, need, posix, readJson, writeJsonAtomic } from './lib/common.mjs';
import { devBranchMatches } from './preflight.mjs';

export const marker = (runId) => `<!-- qa-run:${runId} -->`;

function lastGate(state, id) {
  return [...(state.gates ?? [])].reverse().find((g) => g.id === id);
}

// Dev PRs for the ticket merged into the tested branch, now (newest state, read-only).
export function mergedDevPrs(runner, config, state, cwd) {
  const key = state.ticket?.key;
  const base = state.tested?.branch ?? config.git.integrationBranch;
  return JSON.parse(mustRun(runner, 'gh', ['pr', 'list', '--state', 'merged', '--base', base, '--limit', '200', '--json', 'number,headRefName'], { cwd }) || '[]')
    .filter((pr) => devBranchMatches(config.git.devBranchKeyPattern, key, pr.headRefName));
}

// A clean pass: nothing in the run needed a person, so delivery approved at G2 may go ahead. Every
// condition comes from a file a script wrote (runner-1.json, feedback.json, the gate log), never
// from what the model reports.
export function cleanPass({ state, feedback, firstRun, devPrs = [] }) {
  const reasons = [];
  if (feedback?.recommendedVerdict !== 'QA Passed') reasons.push(`the recommendation is ${feedback?.recommendedVerdict ?? 'missing'}, not QA Passed`);
  if (feedback?.defects?.length) reasons.push(`${feedback.defects.length} defect(s)`);
  if (firstRun?.status !== 'completed' || firstRun?.counts?.failed !== 0) reasons.push(`attempt 1 was not a completed run with 0 failures (${firstRun?.status ?? 'no runner-1.json'}, ${firstRun?.counts?.failed ?? '?'} failed)`);
  const human = [...new Set((state.gates ?? []).filter((g) => g.id === 'G3' || g.id === 'G2-escalate').map((g) => g.id))];
  if (human.length) reasons.push(`the run needed ${human.join(' and ')}`);
  const tested = new Set((state.devChanges ?? []).map((d) => d.pr));
  const newer = devPrs.filter((pr) => !tested.has(pr.number)).map((pr) => `#${pr.number}`);
  if (newer.length) reasons.push(`STALE: new dev work merged during the run (${newer.join(', ')})`);
  return { clean: reasons.length === 0, stale: newer.length > 0, reasons };
}

// Anything to deliver: a planned QA test change, or a re-test (which still pushes the merged-in base
// to the open QA PR's branch).
export const hasChanges = (plan, state) => Boolean(state.qa?.retest) || ['update', 'add', 'delete'].some((k) => plan?.changeSet?.[k]?.length);

// G2 pre-approved delivery for this plan: the approval that binds the current planHash says so.
export const preApproved = (state, plan) => {
  const g2 = [...(state.gates ?? [])].reverse().find((g) => g.id === 'G2' && g.decision === 'approved');
  return Boolean(g2?.deliverOnClean && plan?.planHash && g2.planHash === plan.planHash);
};

export function deliverTests({ runner, config, plan, state, active, feedback, runDir, check = null }) {
  const key = state.ticket?.key ?? active.key;
  const qaBranch = active.qaBranch;
  // The QA PR targets the branch this run TESTED (fixed at preflight), not whatever the checkout's
  // config says now: the checkout may have switched branches since.
  const base = state.tested?.branch ?? active.integrationBranch ?? config.git.integrationBranch;
  const worktree = active.worktree;
  const testDir = config.qa.testDir;

  if (!plan?.planHash || state.plan?.approvedHash !== plan.planHash) throw new Error('the plan is not approved at G2');
  if (!hasChanges(plan, state)) return { delivered: false, reason: 'no QA test changes in this run', commit: null, branch: qaBranch, base, approvedAt: null, pr: null };
  let approvedAt = null;
  if (lastGate(state, 'DELIVER')?.decision === 'approved') approvedAt = 'DELIVER';
  else if (preApproved(state, plan) && check?.clean) approvedAt = 'G2 (clean pass)';
  if (!approvedAt) {
    const why = preApproved(state, plan) ? `; G2 pre-approved a clean pass, but ${check?.reasons?.join('; ') || 'it was not checked'}` : '';
    throw new Error(`the human has not approved delivery (gate DELIVER)${why}`);
  }
  if (!qaBranch || !qaBranch.startsWith(`qa/${key}-`)) throw new Error(`QA branch "${qaBranch}" does not match qa/${key}-<slug>`);
  if ((config.git.protectedBranches ?? []).includes(qaBranch)) throw new Error(`refusing to deliver to protected branch ${qaBranch}`);
  const current = mustRun(runner, 'git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (current !== qaBranch) throw new Error(`worktree is on ${current}, expected ${qaBranch}`);

  const allowedFiles = new Set([...plan.changeSet.update, ...plan.changeSet.add, ...plan.changeSet.delete].map((i) => posix(i.file)));
  mustRun(runner, 'git', ['-C', worktree, 'add', '-A', '--', testDir]);
  const staged = mustRun(runner, 'git', ['-C', worktree, 'diff', '--cached', '--name-only']).split('\n').filter(Boolean).map(posix);
  const stray = staged.filter((f) => !inDir(f, testDir) || !allowedFiles.has(f));
  if (stray.length) throw new Error(`staged files outside the approved change set: ${stray.join(', ')}`);

  const trailer = `QA-Run: ${state.runId}`;
  const existing = mustRun(runner, 'git', ['-C', worktree, 'log', '--format=%H', `--grep=${trailer}`, '-n', '1']).trim();
  let commit = existing || null;
  if (!commit && staged.length) {
    const title = state.ticket?.title ? ` ${state.ticket.title}` : '';
    // Files, not plan entries: a plan has one entry per scenario and may add tests to an existing
    // spec (a commit once said "7 added" for one new and one changed file).
    const status = mustRun(runner, 'git', ['-C', worktree, 'diff', '--cached', '--name-status']).split('\n').filter(Boolean).map((l) => l[0]);
    const n = (s) => status.filter((x) => x === s).length;
    mustRun(runner, 'git', ['-C', worktree, 'commit', '-q', '-m', `test(qa): ${key}${title}`,
      '-m', `QA suite changes for ${key}: ${n('M')} updated, ${n('A')} added, ${n('D')} deleted files.`,
      '-m', trailer]);
    commit = mustRun(runner, 'git', ['-C', worktree, 'rev-parse', 'HEAD']).trim();
  }
  const retest = state.qa?.retest ?? null;
  // A re-test may add no new tests (the earlier ones now pass); the merged-in base still gets pushed.
  if (!commit && !retest) throw new Error('nothing to deliver: no QA test changes in this run');

  // Never force: if someone pushed to the QA branch during the run, stop and say so.
  const push = runner('git', ['-C', worktree, 'push', '-u', 'origin', `${qaBranch}:${qaBranch}`]);
  if (push.status !== 0) {
    throw new Error(`push of ${qaBranch} was rejected (someone pushed to it during the run?). Nothing was forced. ${(push.stderr || push.stdout).trim().slice(0, 300)}`);
  }

  const draft = feedback?.recommendedVerdict === 'QA Failed';
  const bodyFile = path.join(runDir, 'qa-pr.md');
  writeFileSync(bodyFile, `${feedback?.qaPrMarkdown ?? `QA run ${state.runId} for ${key}.`}\n\n${marker(state.runId)}\n`);
  const prs = JSON.parse(mustRun(runner, 'gh', ['pr', 'list', '--head', qaBranch, '--state', 'all', '--json', 'number,url,body,isDraft,state'], { cwd: worktree }) || '[]');
  let pr = prs.find((p) => (p.body ?? '').includes(marker(state.runId)));
  let updated = false;
  const open = prs.find((p) => p.state === 'OPEN');
  if (!pr && open) {
    // Re-test: update the existing QA PR instead of opening a second one.
    mustRun(runner, 'gh', ['pr', 'comment', String(open.number), '--body',
      `QA re-test run ${state.runId}: **${feedback?.recommendedVerdict ?? 'no verdict'}** (tested ${state.tested?.branch ?? base} @ ${(state.tested?.sha ?? '').slice(0, 7)}). The description below is replaced with this run's report.`], { cwd: worktree });
    mustRun(runner, 'gh', ['pr', 'edit', String(open.number), '--body-file', bodyFile], { cwd: worktree });
    if (open.isDraft && !draft) mustRun(runner, 'gh', ['pr', 'ready', String(open.number)], { cwd: worktree });
    if (!open.isDraft && draft) mustRun(runner, 'gh', ['pr', 'ready', String(open.number), '--undo'], { cwd: worktree });
    pr = { ...open, isDraft: draft };
    updated = true;
  }
  if (!pr) {
    const args = ['pr', 'create', '--base', base, '--head', qaBranch, '--title', `QA: ${key}${state.ticket?.title ? ` ${state.ticket.title}` : ''}`, '--body-file', bodyFile];
    if (draft) args.push('--draft');
    const url = mustRun(runner, 'gh', args, { cwd: worktree }).trim().split('\n').pop();
    pr = { url, number: Number(url.match(/\/pull\/(\d+)/)?.[1] ?? NaN), isDraft: draft };
  }
  return { delivered: true, commit, branch: qaBranch, base, approvedAt, pr: { number: pr.number, url: pr.url, draft: Boolean(pr.isDraft), updated } };
}

if (isMain(import.meta.url)) {
  const { main, realRunner } = await import('./lib/common.mjs');
  main(async (args) => {
    need(args, 'run', 'project');
    const stateFile = path.join(args.run, 'state.json');
    const state = readJson(stateFile);
    const config = loadConfig(args.project);
    const plan = readJson(path.join(args.run, 'plan.json'));
    const active = readJson(path.join(args.project, '.qa-runs', 'active.json'));
    const feedback = readJson(path.join(args.run, 'feedback.json'), null);
    const check = {
      ...cleanPass({ state, feedback, firstRun: readJson(path.join(args.run, 'runner-1.json'), null), devPrs: mergedDevPrs(realRunner, config, state, active.worktree) }),
      preApproved: preApproved(state, plan),
      changes: hasChanges(plan, state),
    };
    if (args.check) return check;
    const result = deliverTests({ runner: realRunner, config, plan, state, active, feedback, runDir: args.run, check });
    writeJsonAtomic(stateFile, {
      ...state,
      qa: { ...state.qa, pr: result.pr?.number ?? state.qa?.pr ?? null },
      publication: { ...state.publication, testsCommit: result.commit, qaPr: result.pr, approvedAt: result.approvedAt },
    });
    return result;
  });
}
