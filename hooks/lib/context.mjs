// Run ownership and run context for the guard.
//
// findOwnedRun() decides whether the guard has any business with this tool
// call. It must never block: guard.mjs treats any exception from it as "not
// owned" and allows the call. loadContext() runs only after ownership is
// proven; its exceptions block the call (fail closed inside a run).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { join, norm } from './paths.mjs';
import { withDefaults } from '../../scripts/lib/config.mjs';

function ancestors(dir) {
  const out = [];
  let cur = path.resolve(String(dir));
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return out;
    cur = parent;
  }
}

// The project root that holds .qa/config.json and .qa-runs/active.json.
// CLAUDE_PROJECT_DIR first; then the payload cwd and its ancestors, which also
// covers a session that has cd'ed into .qa-worktrees/<runId>.
export function findOwnedRun(input, env) {
  const candidates = [];
  if (env.CLAUDE_PROJECT_DIR) candidates.push(env.CLAUDE_PROJECT_DIR);
  if (input.cwd) candidates.push(...ancestors(input.cwd));
  for (const dir of candidates) {
    const activePath = path.join(dir, '.qa-runs', 'active.json');
    if (!existsSync(activePath)) continue;
    const active = JSON.parse(readFileSync(activePath, 'utf8'));
    if (!active.sessionId || active.sessionId !== input.session_id) return null;
    // Owned from here on. While the run is open, a missing .qa/config.json is loadContext's
    // error (blocks), not a reason to go dormant: otherwise moving the config away would switch
    // the guard off. A released run (closed) goes dormant instead: git writes are allowed again
    // then, and a checkout without the config must not lock the session out of `release --forget`.
    if (active.closed && !existsSync(path.join(dir, '.qa', 'config.json'))) return null;
    return { projectDir: dir, active };
  }
  return null;
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// counters.log is append-only, one JSON line per event, so two hooks firing at
// once (parallel Agent calls) can't lose an update the way read-modify-write can.
export function readCounters(runDir) {
  const counters = { criticRounds: 0, producerDispatches: 0, testLaunches: 0 };
  const file = path.join(runDir, 'counters.log');
  if (!existsSync(file)) return counters;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { kind } = JSON.parse(line);
    if (kind in counters) counters[kind] += 1;
  }
  return counters;
}

export function recordEffects(ctx, effects, input) {
  const lines = Object.entries(effects ?? {})
    .flatMap(([kind, n]) => Array.from({ length: n }, () => JSON.stringify({
      kind, at: new Date().toISOString(), tool: input.tool_name, toolUseId: input.tool_use_id,
    })));
  if (lines.length) appendFileSync(path.join(ctx.runDirRaw, 'counters.log'), `${lines.join('\n')}\n`);
}

export function loadContext(owned, env) {
  const { projectDir, active } = owned;
  const configPath = path.join(projectDir, '.qa', 'config.json');
  if (!existsSync(configPath)) throw new Error('.qa/config.json is missing while this session owns an active run');
  // The same defaults the scripts apply (scripts/lib/config.mjs).
  const config = withDefaults(JSON.parse(readFileSync(configPath, 'utf8')));
  if (!config.qa?.testDir) throw new Error('.qa/config.json has no qa.testDir');
  if (!active.runDir || !active.worktree) throw new Error('active.json lacks runDir/worktree');

  const runDirRaw = active.runDir;
  const plan = readJson(path.join(runDirRaw, 'plan.json'), null);
  const state = readJson(path.join(runDirRaw, 'state.json'), {});
  // Test files at run start (preflight's snapshot); older runs without one fall back to the plan's updates.
  const baseline = readJson(path.join(runDirRaw, 'suite-baseline.json'), null);
  const approvedHash = state.plan?.approvedHash;

  return {
    projectDir: norm(projectDir),
    pluginRoot: env.CLAUDE_PLUGIN_ROOT ? norm(env.CLAUDE_PLUGIN_ROOT) : null,
    config,
    active,
    runDirRaw,
    runDir: norm(runDirRaw),
    worktree: norm(active.worktree),
    plan,
    phase: state.phase ?? null,
    planApproved: Boolean(plan?.planHash && approvedHash && plan.planHash === approvedHash),
    baselineFiles: Object.keys(baseline?.files ?? {}),
    counters: readCounters(runDirRaw),
    limits: config.limits,
    controlFiles: [
      join(projectDir, '.qa-runs', 'active.json'),
      join(projectDir, '.qa-runs', '.lock'),
      join(runDirRaw, 'counters.log'),
      join(runDirRaw, 'plan.json'),
      join(runDirRaw, 'state.json'),
      join(runDirRaw, 'suite-baseline.json'),
      // Run data: written by the recorder hook and the plugin scripts, never by the model.
      join(runDirRaw, 'events.jsonl'),
      join(runDirRaw, 'metrics.json'),
      join(runDirRaw, 'progress.md'),
      join(runDirRaw, 'dashboard.html'),
      join(projectDir, '.qa-runs', 'history.jsonl'),
      join(projectDir, '.qa-runs', 'memory.json'),
      join(projectDir, '.qa-runs', 'MEMORY.md'),
    ],
    // Agent handbacks the recorder saves: validate.mjs --step checks what the agent said, not a retyped copy.
    controlDirs: [join(runDirRaw, 'outputs')],
  };
}
