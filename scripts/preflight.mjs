// Preflight (docs/design.md §5 step 0). Deterministic setup and teardown of a QA run.
//
//   preflight.mjs status  --project <dir> [--key PROJ-1] lock holder; with --key also the latest run for the ticket
//   preflight.mjs start   --project <dir> --key PROJ-1  config check, lock, find merged dev PRs, worktree on qa/<KEY>-<slug>,
//                                                      baseline, state.json (with driftProbe: is the known-drift
//                                                      probe due this run), active.json (guard switches on);
//                                                      re-test: freedWorktree, and `unchanged` when the commit
//                                                      is the one the previous delivered run tested
//                         [--no-dev-check [--ref <branch>]]   smoke run: no dev-PR lookup, tests <ref> on qa/<KEY>-smoke-xxxx
//   preflight.mjs resume  --project <dir> --key PROJ-1 [--takeover]   continue the latest run in this session;
//                         --takeover (human-confirmed) also for runs interrupted mid-step whose lock names a dead session.
//                         Not needed when the lock's Claude process (CLAUDE_PID) has provably ended.
//   preflight.mjs stack   --project <dir> --run <runDir> [--attach-only]   install deps, compose up, health, SHA check
//                         (--attach-only: no install/build, only health + SHA proof; used right before tests run)
//   preflight.mjs release --project <dir> --run <runDir> [--teardown] [--forget]
//                         lock released; run kept "closed" (guard keeps H1-H3 for G4) unless --forget; optional down -v;
//                         a finished run is recorded (history, memory) and tidied (tidyRun)
//   preflight.mjs cleanup --project <dir> --run <runDir> [--delete-branch]
//                         remove a released run's worktree (Windows-safe); delete the qa branch only if never pushed
//   preflight.mjs prune   --project <dir>   tidy every finished run on disk; delete run folders without state.json
//
// Exit 3 = a breaker fired (BLOCKED_BACKGROUND / BLOCKED_NOT_INTEGRATED / BLOCKED_ENV); the JSON says why.
// The session id comes from CLAUDE_CODE_SESSION_ID, never from the model.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { UsageError, inDir, isMain, loadConfig, mustRun, need, readJson, realRunner, writeJsonAtomic } from './lib/common.mjs';
import { configProblems } from './lib/config.mjs';
import { snapshotSuite } from './lib/suite.mjs';
import { initialState } from './state.mjs';
import { recordRun } from './metrics.mjs';
import { probeDue, readHistory } from './run-playwright.mjs';
import { updateFromRun } from './memory.mjs';

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const RESUMABLE = ['AWAITING_PLAN_APPROVAL', 'AWAITING_ENGINEER', 'ESCALATED'];

const runsDir = (project) => path.join(project, '.qa-runs');
const lockFile = (project) => path.join(runsDir(project), '.lock');
const activeFile = (project) => path.join(runsDir(project), 'active.json');

export class Breaker extends Error {
  constructor(phase, message, details = {}) { super(message); this.phase = phase; this.details = details; }
}

export function devBranchMatches(pattern, key, branch) {
  return new RegExp(pattern.replaceAll('{KEY}', key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).test(branch);
}

// gh lists newest first; the ticket's first dev PR names its QA branch.
const oldestFirst = (prs) => [...prs].sort((a, b) => a.number - b.number);

export function slugFrom(branch, key) {
  const after = branch.split(new RegExp(`${key}-?`, 'i'))[1] ?? '';
  return after.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'qa';
}

function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${randomBytes(2).toString('hex')}`;
}

function takeLock(project, info) {
  mkdirSync(runsDir(project), { recursive: true });
  try {
    writeFileSync(lockFile(project), JSON.stringify(info), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const holder = readFileSync(lockFile(project), 'utf8');
    throw new UsageError(`a QA run is already in progress on this machine: ${holder}. Finish it, or run "preflight.mjs release".`);
  }
}

// Is a process still running? null when unknown (no pid recorded, or the check itself failed).
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    return err.code === 'EPERM' ? true : null;
  }
}

// Whether the Claude process holding the lock still runs. The lock records that process
// (CLAUDE_PID), not the short-lived script that took it. Only a provably exited process counts as
// gone: one process may host several sessions, so a live pid says nothing about the session.
export function lockOwnerAlive(lock, { alive = pidAlive } = {}) {
  return lock?.claudePid ? alive(lock.claudePid) : null;
}

export function status({ project, key, alive = pidAlive }) {
  const raw = existsSync(lockFile(project)) ? JSON.parse(readFileSync(lockFile(project), 'utf8')) : null;
  const lock = raw && { ...raw, ownerAlive: lockOwnerAlive(raw, { alive }) };
  if (!key) return { key: null, latest: null, lock };
  const latestFile = path.join(runsDir(project), key, 'latest');
  if (!existsSync(latestFile)) return { key, latest: null, lock };
  const runId = readFileSync(latestFile, 'utf8').trim();
  const runDir = path.join(runsDir(project), key, runId);
  const state = readJson(path.join(runDir, 'state.json'), {});
  return { key, latest: { runId, runDir, phase: state.phase ?? null, resumable: RESUMABLE.includes(state.phase) }, lock };
}

// A Claude Code background job (CLAUDE_JOB_DIR is set) may write files only inside a linked git
// worktree, unless the repo's settings set worktree.bgIsolation to "none". The run folder is in
// the main checkout, so such a session can't save ticket.json or any agent output (found live on
// seen live, after start had already built the worktree). The CLI checks this before
// start and resume, so nothing is created. The first settings file that sets the key wins
// (local, then project, then user).
export function backgroundJobBlock({ project, env, home = homedir() }) {
  if (!env.CLAUDE_JOB_DIR) return null;
  for (const file of [path.join(project, '.claude', 'settings.local.json'), path.join(project, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.json')]) {
    let value;
    try { value = JSON.parse(readFileSync(file, 'utf8'))?.worktree?.bgIsolation; } catch { continue; }
    if (value !== undefined) {
      if (value === 'none') return null;
      break;
    }
  }
  return new Breaker('BLOCKED_BACKGROUND', 'this session is a Claude Code background job, which may write files only inside a linked git worktree. '
    + `A QA run saves its outputs in ${path.join(project, '.qa-runs')} in the main checkout, so it can't run here. Either start it in an interactive session `
    + `(a terminal in ${project}: run "claude", then the qa-run command), or let background jobs write in this repo by adding `
    + '"worktree": {"bgIsolation": "none"} to .claude/settings.local.json. Nothing was created.');
}

// noDevCheck: a smoke run that checks a repo's QA setup (stack, SHA proof,
// runner) without a ticket whose dev PR is merged. It tests `ref` (default: the
// integration branch) on a qa/<KEY>-smoke branch. Useful when adopting the plugin.
export function start({ runner, project, key, sessionId, ownerPid = null, noDevCheck = false, ref = null, now = new Date() }) {
  if (!KEY.test(key)) throw new UsageError(`invalid ticket key "${key}"`);
  if (!sessionId) throw new UsageError('CLAUDE_CODE_SESSION_ID is not set: run this from a Claude Code session');
  const config = loadConfig(project);
  const { problems } = configProblems(config);
  if (problems.length) throw new UsageError(`.qa/config.json is incomplete:\n- ${problems.join('\n- ')}\nRun /qa-orchestrator:setup to fix it.`);
  const base = ref ?? config.git.integrationBranch;
  const runId = newRunId(now);
  takeLock(project, { claudePid: ownerPid, sessionId, key, runId, since: now.toISOString(), smoke: noDevCheck });
  let worktree = null;
  let runDir = null;
  let freedWorktree = null;
  try {
    const prs = noDevCheck ? [] : JSON.parse(mustRun(runner, 'gh', ['pr', 'list', '--state', 'merged', '--base', base, '--limit', '200',
      '--json', 'number,headRefName,mergeCommit,title,url'], { cwd: project }) || '[]')
      .filter((pr) => devBranchMatches(config.git.devBranchKeyPattern, key, pr.headRefName));
    if (!prs.length && !noDevCheck) {
      throw new Breaker('BLOCKED_NOT_INTEGRATED', `no merged dev PR for ${key} into ${base}. Dev branches must contain the ticket key (e.g. feature/${key}-short-name) and be merged before QA.`);
    }

    mustRun(runner, 'git', ['-C', project, 'fetch', '-q', 'origin', base]);
    const testedSha = mustRun(runner, 'git', ['-C', project, 'rev-parse', `origin/${base}`]).trim();
    for (const pr of prs) {
      const oid = pr.mergeCommit?.oid;
      if (oid && runner('git', ['-C', project, 'merge-base', '--is-ancestor', oid, testedSha]).status !== 0) {
        throw new Breaker('BLOCKED_NOT_INTEGRATED', `dev PR #${pr.number} (${oid.slice(0, 7)}) is not in origin/${base} yet`);
      }
    }

    const { qaBranch, retest } = noDevCheck
      ? { qaBranch: `qa/${key}-smoke-${runId.slice(-4)}`, retest: null }
      // Named after the ticket's FIRST dev PR, so the name stays stable when a fix PR uses another branch name.
      : chooseQaBranch({ runner, project, key, base: `qa/${key}-${slugFrom(oldestFirst(prs)[0].headRefName, key)}` });

    runDir = path.join(runsDir(project), key, runId);
    worktree =path.join(project, '.qa-worktrees', runId);
    mkdirSync(runDir, { recursive: true });
    const previousRunId = retest ? previousDeliveredRun(project, key, qaBranch) : null;

    const diff = prs.map((pr) => `# PR #${pr.number} ${pr.title}\n${mustRun(runner, 'gh', ['pr', 'diff', String(pr.number)], { cwd: project })}`).join('\n');
    writeFileSync(path.join(runDir, 'dev-changes.diff'), diff);
    const devChanges = prs.map((pr) => ({ pr: pr.number, head: pr.headRefName, mergeSha: pr.mergeCommit?.oid ?? null, title: pr.title, url: pr.url }));
    writeJsonAtomic(path.join(runDir, 'dev-changes.json'), { prs: devChanges, diffPath: path.join(runDir, 'dev-changes.diff') });

    if (!retest) {
      mustRun(runner, 'git', ['-C', project, 'worktree', 'add', '-q', '-b', qaBranch, worktree, testedSha]);
    } else {
      // Re-test: origin is the source of truth for the QA branch (a reviewer may have pushed to it).
      mustRun(runner, 'git', ['-C', project, 'fetch', '-q', 'origin', qaBranch]);
      freedWorktree = freeQaBranch({ runner, project, qaBranch });
      mustRun(runner, 'git', ['-C', project, 'worktree', 'add', '-q', '-B', qaBranch, worktree, `origin/${qaBranch}`]);
      const merge = runner('git', ['-C', worktree, 'merge', '--no-edit', '-m', `Merge ${base} @ ${testedSha.slice(0, 7)} into ${qaBranch} for QA re-test`, testedSha]);
      if (merge.status !== 0) {
        const conflicts = runner('git', ['-C', worktree, 'diff', '--name-only', '--diff-filter=U']).stdout.trim().split('\n').filter(Boolean);
        runner('git', ['-C', worktree, 'merge', '--abort']);
        throw new Breaker('BLOCKED_ENV', `the QA branch ${qaBranch} conflicts with ${base} @ ${testedSha.slice(0, 7)} in: ${conflicts.join(', ') || '(see git output)'}. Resolve it on the QA branch (or its PR #${retest.previousPr}), then re-run.`);
      }
    }
    // The app under test must be exactly the tested commit: in a re-test the worktree HEAD is a
    // merge, so nothing outside the QA test dir may differ from testedSha.
    const productDiff = mustRun(runner, 'git', ['-C', worktree, 'diff', '--name-only', testedSha, 'HEAD']).split('\n').filter(Boolean)
      .filter((f) => !inDir(f, config.qa.testDir));
    if (productDiff.length) {
      throw new Breaker('BLOCKED_ENV', `the QA branch ${qaBranch} changes files outside ${config.qa.testDir}: ${productDiff.join(', ')}. QA branches may only hold QA tests; the app under test would not be ${testedSha.slice(0, 7)}.`);
    }
    // Repo-specific test conventions for the agents; a missing one is a warning, not a stop.
    const conventionsDocs = (config.qa.conventionsDocs ?? []).filter((f) => existsSync(path.join(worktree, f))).map((f) => path.join(worktree, f));
    const warnings = (config.qa.conventionsDocs ?? []).filter((f) => !existsSync(path.join(worktree, f)))
      .map((f) => `qa.conventionsDocs: ${f} not found at the tested commit`);
    writeJsonAtomic(path.join(runDir, 'suite-baseline.json'), snapshotSuite(worktree, config.qa.testDir));
    writeJsonAtomic(path.join(runDir, 'config.snapshot.json'), config);

    const state = initialState({ runId, sessionId, key, now: now.toISOString() });
    state.tested = { branch: base, sha: testedSha };
    state.devChanges = devChanges;
    state.qa = {
      branch: qaBranch, pr: null, conventionsDocs,
      retest: retest ? { previousPr: retest.previousPr, previousPrUrl: retest.previousPrUrl, previousRunId } : null,
    };
    state.driftProbe = probeDue(readHistory(project), config.qa.driftProbeEvery, runId);
    writeJsonAtomic(path.join(runDir, 'state.json'), state);
    // Only a fully prepared run becomes the ticket's latest (resume/takeover look at it).
    writeFileSync(path.join(runsDir(project), key, 'latest'), runId);

    // Last: this file switches the guard on for this session.
    writeJsonAtomic(activeFile(project), { schemaVersion: 1, key, runId, runDir, worktree, sessionId, qaBranch, integrationBranch: base, testedSha });
    // A re-test of the commit the previous delivered run already tested has nothing new to test
    // (seen live: a re-test started before the dev fix was merged). The human decides whether to go on.
    const previousSha = previousRunId ? readJson(path.join(runsDir(project), key, previousRunId, 'state.json'), {}).tested?.sha : null;
    const unchanged = previousSha && previousSha === testedSha ? { previousRunId, testedSha } : null;
    return { ok: true, key, runId, runDir, worktree, qaBranch, testedSha, devChanges, conventionsDocs, warnings, retest: state.qa.retest, freedWorktree, unchanged, driftProbe: state.driftProbe };
  } catch (err) {
    // Never leave a half-built worktree: it would keep the QA branch checked out and block the next run.
    if (worktree && existsSync(worktree)) rmSync(worktree, { recursive: true, force: true, maxRetries: 3 });
    // Nor a run folder with only dev-changes.* in it: nothing reads a run without state.json (the
    // a re-test once left two).
    if (runDir && existsSync(runDir)) rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
    runner('git', ['-C', project, 'worktree', 'prune']);
    rmSync(lockFile(project), { force: true });
    throw err;
  }
}

// The newest run on this QA branch that reached the human (its report is what the open QA PR shows).
// Abandoned or stopped runs don't count, so a re-test compares against the verdict people saw.
export function previousDeliveredRun(project, key, qaBranch) {
  const dir = path.join(runsDir(project), key);
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter((d) => existsSync(path.join(dir, d, 'state.json'))).sort().reverse();
  for (const runId of runs) {
    const s = readJson(path.join(dir, runId, 'state.json'), {});
    if (s.qa?.branch === qaBranch && s.phase === 'AWAITING_HUMAN_REVIEW') return runId;
  }
  return null;
}

// Which QA branch this run uses. Origin is the source of truth:
// - no branch yet                           → a fresh branch
// - branch on origin with an OPEN QA PR     → re-test on that branch (the same PR gets updated)
// - branch whose PR was merged or closed,
//   or a local-only branch (maybe undelivered work) → never reused; the next free "-2", "-3", …
export function chooseQaBranch({ runner, project, key, base }) {
  // Any OPEN QA PR for this ticket means re-test, whatever its slug (found live: the fix PR's
  // branch name differed, so a slug-based lookup missed the open QA PR).
  if (key) {
    const open = JSON.parse(mustRun(runner, 'gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,url,isDraft,headRefName'], { cwd: project }) || '[]')
      .filter((pr) => String(pr.headRefName).startsWith(`qa/${key}-`))
      .sort((a, b) => a.number - b.number);
    if (open.length) return { qaBranch: open[0].headRefName, retest: { previousPr: open[0].number, previousPrUrl: open[0].url } };
  }
  for (let n = 1; n <= 20; n += 1) {
    const branch = n === 1 ? base : `${base}-${n}`;
    const onOrigin = runner('git', ['-C', project, 'ls-remote', '--exit-code', '--heads', 'origin', branch]).status === 0;
    const local = runner('git', ['-C', project, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    if (!onOrigin && !local) return { qaBranch: branch, retest: null };
    if (onOrigin) {
      const open = JSON.parse(mustRun(runner, 'gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url,isDraft'], { cwd: project }) || '[]');
      if (open.length) return { qaBranch: branch, retest: { previousPr: open[0].number, previousPrUrl: open[0].url } };
    }
  }
  throw new UsageError(`more than 20 QA branches exist for ${base}; clean some up`);
}

// A re-test needs the QA branch that the previous run's worktree still has checked out: release
// keeps that worktree for review, and git checks a branch out in one worktree only (seen live).
// Remove it when that loses nothing: a finished run's worktree under .qa-worktrees/,
// with no uncommitted changes and no commit that isn't on origin. Otherwise stop and say why.
// Call after fetching origin/<qaBranch>. Returns what was removed, or null.
export function freeQaBranch({ runner, project, qaBranch }) {
  const holder = mustRun(runner, 'git', ['-C', project, 'worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/)
    .map((block) => ({ dir: /^worktree (.+)$/m.exec(block)?.[1]?.trim(), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() }))
    .find((w) => w.branch === qaBranch && w.dir);
  if (!holder) return null;
  const dir = path.resolve(holder.dir);
  const runId = path.basename(dir);
  const refuse = (why) => new UsageError(`${qaBranch} is checked out in ${dir}, ${why}. The re-test needs that branch.`);
  if (!samePath(path.dirname(dir), path.join(project, '.qa-worktrees'))) {
    throw refuse('which is not a QA run worktree. Check out another branch there first');
  }
  const active = readJson(activeFile(project), null);
  if (active?.runId === runId && !active.closed) throw refuse(`and run ${runId} is still active. Release it first`);
  const loss = localWork({ runner, dir, branch: qaBranch });
  if (loss?.startsWith('uncommitted')) {
    throw refuse(`with ${loss}. Commit and push them to the QA branch, or discard them, then run "preflight.mjs cleanup" for that run`);
  }
  if (loss) throw refuse(`with ${loss}. Push them to the QA branch first`);
  removeWorktree(runner, project, dir);
  return { runId, removed: dir };
}

// git prints a worktree's long path, while `project` may be an 8.3 short one (C:\Users\RUNNER~1\…
// on GitHub's Windows runners), so compare what the filesystem resolves both to.
function samePath(a, b) {
  const real = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
  return real(a).toLowerCase() === real(b).toLowerCase();
}

const RM = { recursive: true, force: true, maxRetries: 3 };

// Removes a QA worktree without leaving half of one registered with git. On Windows a folder in use
// (an editor, an indexer) makes rmSync fail partway, and the rest would look like uncommitted
// deletions to the next re-test. A rename fails whole instead; git then forgets the missing
// worktree, and whatever rmSync can't delete is an unregistered `<runId>.removing` that prune retries.
function removeWorktree(runner, project, dir) {
  const trash = `${dir}.removing`;
  renameSync(dir, trash);
  mustRun(runner, 'git', ['-C', project, 'worktree', 'prune']);
  rmSync(trash, RM);
}

// Whether the QA stack has containers. It mounts files from the run's worktree (e.g. a database seed file),
// so a worktree is removed only when the stack is down. If docker can't answer, assume it is up,
// unless it says its daemon isn't running: then no container runs (seen live: a BLOCKED_ENV
// with Docker Desktop closed kept its worktree, and the retry had to move to qa/<KEY>-<slug>-2).
const DAEMON_DOWN = /failed to connect to the docker API|Cannot connect to the Docker daemon|error during connect/i;
function stackUp(runner, project) {
  const name = loadConfig(project).stack?.project;
  if (!name) return false;
  const r = runner('docker', ['compose', '-p', name, 'ps', '-q'], { cwd: project });
  if (r.status !== 0) return !DAEMON_DOWN.test(`${r.stderr ?? ''}${r.stdout ?? ''}`);
  return Boolean(String(r.stdout).trim());
}

// What removing a QA worktree would lose, or null: uncommitted changes, or commits that aren't on
// origin/<branch>. A branch that was never pushed loses nothing only when every commit on it is on
// origin already (a run that changed no QA test, or a Stop before the author wrote anything).
function localWork({ runner, dir, branch }) {
  if (mustRun(runner, 'git', ['-C', dir, 'status', '--porcelain']).trim()) return 'uncommitted changes';
  if (!branch || runner('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).status !== 0) {
    const local = Number(mustRun(runner, 'git', ['-C', dir, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin']).trim());
    return local > 0 ? 'a QA branch that was never pushed' : null;
  }
  const unpushed = Number(mustRun(runner, 'git', ['-C', dir, 'rev-list', '--count', `origin/${branch}..HEAD`]).trim());
  return unpushed > 0 ? `${unpushed} commit(s) not on origin` : null;
}

// node_modules folders at the top of a worktree and in its workspaces (client/, server/, …).
function nodeModulesDirs(dir, depth = 0) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '.git') continue;
    if (e.name === 'node_modules') out.push(path.join(dir, e.name));
    else if (depth < 2) out.push(...nodeModulesDirs(path.join(dir, e.name), depth + 1));
  }
  return out;
}

// What a finished run no longer needs (two runs once left 1.5 GB: a worktree with its own
// node_modules, and every trace stored twice). test-results-<n> goes, because playwright-report-<n>
// holds the same traces and screenshots. The worktree goes when that loses nothing and the QA stack
// is down (with its QA branch, if that was never pushed); otherwise it stays without node_modules,
// which the stack step installs again when missing.
// A run waiting at a gate is released too and resumes later, so only finished runs are tidied.
export function tidyRun({ runner, project, runDir }) {
  const state = readJson(path.join(runDir, 'state.json'), {});
  if (!FINISHED.includes(state.phase)) return { skipped: `phase ${state.phase ?? 'unknown'}` };
  const removed = readdirSync(runDir).filter((d) => {
    const n = /^test-results-(.+)$/.exec(d)?.[1];
    return n && existsSync(path.join(runDir, `playwright-report-${n}`));
  });
  for (const d of removed) rmSync(path.join(runDir, d), RM);
  const worktree = path.join(project, '.qa-worktrees', state.runId ?? path.basename(runDir));
  if (!existsSync(worktree)) return { removed, worktree: null };
  const loss = localWork({ runner, dir: worktree, branch: state.qa?.branch })
    ?? (stackUp(runner, project) ? 'the QA stack is up and mounts files from it (release with --teardown)' : null);
  if (!loss) {
    removeWorktree(runner, project, worktree);
    const branchDeleted = deleteEmptyBranch(runner, project, state.qa?.branch);
    return { removed, worktree: { removed: worktree }, ...(branchDeleted ? { branchDeleted } : {}) };
  }
  const modules = nodeModulesDirs(worktree);
  for (const d of modules) rmSync(d, RM);
  return { removed, worktree: { kept: worktree, why: loss, nodeModulesRemoved: modules.length } };
}

// After its worktree went, a QA branch that was never pushed has no commit of its own (localWork
// said so) and holds nothing. chooseQaBranch never reuses a local-only branch, so leaving it would
// move the next run on the ticket to "-2". A pushed branch backs a QA PR and stays.
function deleteEmptyBranch(runner, project, branch) {
  if (!branch) return null;
  if (runner('git', ['-C', project, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).status === 0) return null;
  if (runner('git', ['-C', project, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status !== 0) return null;
  mustRun(runner, 'git', ['-C', project, 'branch', '-D', branch]);
  return branch;
}

// Tidies every finished run on disk and deletes run folders without state.json (a start that
// failed before start cleaned up after itself). Refused while a run holds the lock.
export function prune({ runner, project }) {
  if (existsSync(lockFile(project))) throw new UsageError('a run holds the lock: prune after it is released');
  const root = runsDir(project);
  const dirs = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
  const orphansRemoved = [];
  const tidied = [];
  for (const key of dirs(root)) {
    for (const runId of dirs(path.join(root, key))) {
      const dir = path.join(root, key, runId);
      if (!existsSync(path.join(dir, 'state.json'))) {
        rmSync(dir, RM);
        orphansRemoved.push(`${key}/${runId}`);
        continue;
      }
      const t = tidyRun({ runner, project, runDir: dir });
      if (!t.skipped) tidied.push({ run: `${key}/${runId}`, ...t });
    }
  }
  // What an earlier removeWorktree couldn't delete (already unregistered from git).
  const trees = path.join(project, '.qa-worktrees');
  for (const d of dirs(trees).filter((n) => n.endsWith('.removing'))) {
    rmSync(path.join(trees, d), RM);
    orphansRemoved.push(`.qa-worktrees/${d}`);
  }
  return { ok: true, orphansRemoved, tidied };
}

// takeover: the run was interrupted mid-step (session closed, usage limit hit)
// and its lock still names the dead session. With the human's confirmation
// (G0) this session takes the run over from whatever phase it was in.
const FINISHED = ['AWAITING_HUMAN_REVIEW', 'STOPPED', 'BLOCKED_ENV', 'BLOCKED_NOT_INTEGRATED'];

// Files preflight writes at start; everything else in the run folder is a step's output.
const START_FILES = new Set(['state.json', 'config.snapshot.json', 'suite-baseline.json', 'dev-changes.json', 'ticket.json']);

// What an interrupted run already produced, so the new session continues at the recorded phase
// instead of redoing finished sub-steps: the step outputs on disk, the agent handbacks the recorder
// saved (`saved`, by step; one not yet validated is validated with --step instead of redispatched)
// and the timeline since the current phase began.
export function progressOf(runDir, state) {
  const outputs = readdirSync(runDir).filter((f) => /\.(?:json|md)$/.test(f) && !START_FILES.has(f) && !f.endsWith('.raw.json')).sort();
  const outputsDir = path.join(runDir, 'outputs');
  const saved = existsSync(outputsDir) ? readdirSync(outputsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
  const timeline = state.timeline ?? [];
  const phaseStart = timeline.findLastIndex((t) => String(t.step).startsWith('phase:'));
  return { outputs, saved, stepsInPhase: timeline.slice(phaseStart + 1).filter((t) => !['resume', 'takeover'].includes(t.step)) };
}

export function resume({ project, key, sessionId, ownerPid = null, takeover: takeoverFlag = false, alive = pidAlive }) {
  if (!sessionId) throw new UsageError('CLAUDE_CODE_SESSION_ID is not set');
  const s = status({ project, key, alive });
  if (!s.latest) throw new UsageError(`no run for ${key}`);
  // A lock whose Claude process has provably ended needs no "is that session closed?" confirmation.
  const ownerGone = Boolean(s.lock && s.lock.runId === s.latest.runId && s.lock.sessionId !== sessionId && s.lock.ownerAlive === false);
  const takeover = takeoverFlag || ownerGone;
  const allowed = takeover ? !FINISHED.includes(s.latest.phase) : s.latest.resumable;
  if (!allowed) {
    throw new UsageError(takeover
      ? `the latest ${key} run is finished (${s.latest.phase}); start a new run instead`
      : `no resumable run for ${key} (latest phase: ${s.latest.phase}). If its session was interrupted, resume with --takeover`);
  }
  if (s.lock && s.lock.runId !== s.latest.runId) throw new UsageError(`another run holds the lock: ${JSON.stringify(s.lock)}`);
  if (s.lock && !takeover && s.lock.sessionId !== sessionId) {
    throw new UsageError(`the run is locked by session ${s.lock.sessionId}. If that session is gone, resume with --takeover`);
  }
  rmSync(lockFile(project), { force: true });
  takeLock(project, { claudePid: ownerPid, sessionId, key, runId: s.latest.runId, since: new Date().toISOString(), resumed: true, takeover, ownerGone });
  const state = readJson(path.join(s.latest.runDir, 'state.json'));
  const previousSession = state.sessionId;
  const progress = progressOf(s.latest.runDir, state);
  writeJsonAtomic(path.join(s.latest.runDir, 'state.json'), {
    ...state, sessionId, resumedAt: new Date().toISOString(),
    timeline: [...(state.timeline ?? []), { step: takeover ? 'takeover' : 'resume', at: new Date().toISOString(), outcome: `from session ${previousSession}` }],
  });
  const worktree = path.join(project, '.qa-worktrees', s.latest.runId);
  writeJsonAtomic(activeFile(project), {
    schemaVersion: 1, key, runId: s.latest.runId, runDir: s.latest.runDir, worktree, sessionId,
    qaBranch: state.qa?.branch, integrationBranch: state.tested?.branch, testedSha: state.tested?.sha,
  });
  return { ok: true, resumed: s.latest.runId, phase: state.phase, runDir: s.latest.runDir, takeover, ownerGone, previousSession, ...progress };
}

// "http://host/health#sha" → JSON field; "http://host/#meta:app-sha" → <meta name="app-sha" content="…">
export async function readSha(fetchFn, spec) {
  const [url, selector = ''] = spec.split('#');
  const res = await fetchFn(url);
  const body = await res.text();
  if (selector.startsWith('meta:')) {
    const name = selector.slice(5);
    return new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i').exec(body)?.[1] ?? null;
  }
  try { return JSON.parse(body)[selector] ?? null; } catch { return null; }
}

export async function stack({ runner, fetchFn, project, runDir, env = process.env, sleep, now = Date.now }) {
  const config = loadConfig(project);
  const active = readJson(activeFile(project));
  const { worktree, testedSha } = active;
  const s = config.stack;
  const attachOnly = env.QA_STACK_ATTACH_ONLY === '1';

  if (!existsSync(path.join(worktree, 'node_modules')) && env.QA_SKIP_INSTALL !== '1') {
    const r = runner(config.qa.installCommand, [], { cwd: worktree, shell: true });
    if (r.status !== 0) throw new Breaker('BLOCKED_ENV', `dependency install failed: ${(r.stderr || r.stdout).slice(-500)}`);
  }
  if (!attachOnly) {
    const r = runner('docker', ['compose', '-p', s.project, '-f', path.join(worktree, s.composeFile), 'up', '--build', '-d'],
      { cwd: worktree, env: { ...env, GIT_SHA: testedSha } });
    if (r.status !== 0) throw new Breaker('BLOCKED_ENV', `docker compose up failed: ${(r.stderr || r.stdout).slice(-800)}`);
  }

  const deadline = now() + s.healthTimeoutSec * 1000;
  const pending = new Set(s.health);
  while (pending.size && now() < deadline) {
    for (const url of [...pending]) {
      try { if ((await fetchFn(url)).ok) pending.delete(url); } catch { /* not up yet */ }
    }
    if (pending.size) await sleep(3000);
  }
  if (pending.size) throw new Breaker('BLOCKED_ENV', `not healthy within ${s.healthTimeoutSec}s: ${[...pending].join(', ')}`);

  const shas = {};
  for (const [name, spec] of Object.entries(s.shaCheck)) {
    const sha = await readSha(fetchFn, spec);
    shas[name] = sha;
    const matches = sha && sha.length >= 7 && testedSha.startsWith(sha.slice(0, 40));
    if (!matches) throw new Breaker('BLOCKED_ENV', `the running ${name} is ${sha ?? 'unknown'}, not the tested commit ${testedSha.slice(0, 12)}. The stack is not the code under test.`, { shas });
  }
  return { ok: true, attachOnly, healthy: s.health, shas, testedSha };
}

// Releases the machine lock. By default the run stays "closed" in active.json so
// the session keeps the human-only rules (H1-H3) while the human decides (G4);
// --forget removes it and the guard goes fully dormant.
export function release({ runner, project, runDir, teardown, forget = false, env = process.env }) {
  const config = loadConfig(project);
  const active = readJson(activeFile(project), null);
  if (active && runDir && path.resolve(active.runDir) !== path.resolve(runDir)) throw new UsageError('active run is a different run');
  if (teardown && active) {
    runner('docker', ['compose', '-p', config.stack.project, '-f', path.join(active.worktree, config.stack.composeFile), 'down', '-v'], { cwd: active.worktree, env });
  }
  if (forget || !active) rmSync(activeFile(project), { force: true });
  else writeJsonAtomic(activeFile(project), { ...active, closed: true, closedAt: new Date().toISOString() });
  rmSync(lockFile(project), { force: true });
  const recorded = active ? recordFinishedRun(project, active.runDir) : {};
  // After recording, which reads the run folder. Tidying never fails a release either.
  const target = active?.runDir ?? runDir;
  let tidy = null;
  if (target && existsSync(target)) {
    try { tidy = tidyRun({ runner, project, runDir: target }); } catch (err) { tidy = { error: err.message }; }
  }
  return {
    ok: true, released: active?.runId ?? null, closed: Boolean(active && !forget), tornDown: Boolean(teardown && active),
    ...recorded, tidy,
  };
}

// A finished run leaves its line in .qa-runs/history.jsonl and its lessons in .qa-runs/memory.json.
// A run that never dispatched an agent (stopped in preflight) has nothing to record: it would only
// add an empty history line and use up a memory expiry slot. Run data never fails a release.
function recordFinishedRun(project, runDir) {
  if (!existsSync(path.join(runDir, 'briefs', 'index.json'))) return { history: { skipped: 'no agent ran' } };
  const out = {};
  try {
    const m = recordRun({ project, runDir });
    out.history = { activeMin: Math.round(m.time.total.activeMs / 6000) / 10, tokens: m.agents.totals.total };
  } catch (err) { out.history = { error: err.message }; }
  try { out.memory = updateFromRun({ project, runDir }); } catch (err) { out.memory = { error: err.message }; }
  return out;
}

// Removes a released run's worktree. `git worktree remove` fails on Windows when
// an npm workspace install left a link (node_modules/<pkg> → the worktree's own
// package dir); Node's rmSync unlinks links instead of following them. The QA
// branch is deleted only on request and only if it was never pushed (a pushed
// branch backs a QA PR).
export function cleanup({ runner, project, runDir, deleteBranch = false }) {
  const state = readJson(path.join(runDir, 'state.json'));
  const active = readJson(activeFile(project), null);
  if (active && path.resolve(active.runDir) === path.resolve(runDir) && !active.closed) {
    throw new UsageError('the run is still active: release it first');
  }
  const worktree = path.join(project, '.qa-worktrees', state.runId);
  if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true, maxRetries: 3 });
  mustRun(runner, 'git', ['-C', project, 'worktree', 'prune']);
  const branch = state.qa?.branch ?? null;
  let branchDeleted = false;
  if (deleteBranch && branch) {
    const remote = runner('git', ['-C', project, 'ls-remote', '--heads', 'origin', branch]).stdout.trim();
    if (remote) throw new UsageError(`${branch} exists on origin (it backs a QA PR); not deleting it`);
    if (runner('git', ['-C', project, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) {
      mustRun(runner, 'git', ['-C', project, 'branch', '-D', branch]);
      branchDeleted = true;
    }
  }
  return { ok: true, removed: worktree, branch, branchDeleted };
}

function markBlocked(project, runDir, breaker) {
  const file = runDir && path.join(runDir, 'state.json');
  if (!file || !existsSync(file)) return;
  const state = readJson(file);
  writeJsonAtomic(file, { ...state, phase: breaker.phase, blocked: { reason: breaker.message, at: new Date().toISOString(), ...breaker.details } });
}

if (isMain(import.meta.url)) {
  const { parseArgs } = await import('./lib/common.mjs');
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  // The Claude process that runs this session (outlives this script; the lock records it).
  const ownerPid = Number(process.env.CLAUDE_PID) || null;
  const print = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
  try {
    need(args, 'project');
    if (cmd === 'start' || cmd === 'resume') {
      const blocked = backgroundJobBlock({ project: args.project, env: process.env });
      if (blocked) throw blocked;
    }
    let result;
    if (cmd === 'status') { result = status({ project: args.project, key: typeof args.key === 'string' ? args.key : null }); }
    else if (cmd === 'start') {
      need(args, 'key');
      result = start({ runner: realRunner, project: args.project, key: args.key, sessionId, ownerPid,
        noDevCheck: Boolean(args.noDevCheck), ref: typeof args.ref === 'string' ? args.ref : null });
    }
    else if (cmd === 'resume') { need(args, 'key'); result = resume({ project: args.project, key: args.key, sessionId, ownerPid, takeover: Boolean(args.takeover) }); }
    else if (cmd === 'stack') {
      need(args, 'run');
      const env = args.attachOnly ? { ...process.env, QA_STACK_ATTACH_ONLY: '1', QA_SKIP_INSTALL: '1' } : process.env;
      result = await stack({ runner: realRunner, fetchFn: fetch, project: args.project, runDir: args.run, env, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
      const state = readJson(path.join(args.run, 'state.json'));
      writeJsonAtomic(path.join(args.run, 'state.json'), { ...state, stack: result });
    } else if (cmd === 'cleanup') {
      need(args, 'run');
      result = cleanup({ runner: realRunner, project: args.project, runDir: args.run, deleteBranch: Boolean(args.deleteBranch) });
    } else if (cmd === 'prune') { result = prune({ runner: realRunner, project: args.project }); }
    else if (cmd === 'release') { result = release({ runner: realRunner, project: args.project, runDir: args.run, teardown: Boolean(args.teardown), forget: Boolean(args.forget) }); }
    else throw new UsageError('usage: preflight.mjs status|start|resume|stack|release|cleanup|prune --project <dir> …');
    print(result);
  } catch (err) {
    if (err instanceof Breaker) {
      markBlocked(args.project, typeof args.run === 'string' ? args.run : null, err);
      if (cmd === 'stack') { try { release({ runner: realRunner, project: args.project, runDir: args.run, teardown: false, forget: true }); } catch { /* best effort */ } }
      print({ ok: false, phase: err.phase, reason: err.message, ...err.details });
      process.exit(3);
    }
    process.stderr.write(`${err.message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
