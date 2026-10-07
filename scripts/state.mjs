// state.json for one QA run (docs/design.md §8). The only writer of state.json.
//
//   state.mjs phase    --run <runDir> <PHASE>
//   state.mjs timeline --run <runDir> --step <name> [--agent a] [--model m] [--outcome ok] [--started ISO]
//   state.mjs gate     --run <runDir> --id <G1|G2|G3|DELIVER|STACK> --decision <text> [--note text] [--deliver-on-clean]
//   state.mjs set      --run <runDir> <dotted.path> <json-value>
//   state.mjs show     --run <runDir>
//
// Approving G2 binds the approval to the plan.json hash on disk at that moment;
// the caller can't supply a hash. Editing the plan afterwards invalidates it. --deliver-on-clean
// (G2 approval only) records the human's "deliver if the run passes clean".
import path from 'node:path';
import { UsageError, isMain, main, need, readJson, writeJsonAtomic } from './lib/common.mjs';
import { refreshViews } from './lib/views.mjs';

export const PHASES = [
  'PREFLIGHT', 'BLOCKED_NOT_INTEGRATED', 'UNDERSTANDING', 'PLANNING', 'AWAITING_PLAN_APPROVAL',
  'MAINTAINING', 'REPAIRING', 'EXECUTING', 'TRIAGING', 'FEEDBACK', 'REPORTING', 'AWAITING_HUMAN_REVIEW',
  'AWAITING_ENGINEER', 'BLOCKED_ENV', 'ESCALATED', 'STOPPED',
];
const GATES = ['G0', 'G1', 'G2', 'G2-escalate', 'G3', 'DELIVER', 'STACK'];
// Fields with their own command, or owned by other scripts.
const RESERVED = ['phase', 'plan.approvedHash', 'gates', 'timeline', 'runId', 'sessionId', 'schemaVersion', 'tested', 'publication'];

const stateFile = (runDir) => path.join(runDir, 'state.json');

// Only what a script or the playbook writes. The route, the suite changes, the runs and the
// feedback live in their own run files (plan.json, runner-<n>.json, feedback.json); copies here
// stayed empty (a run once ended with `runs: []`).
export function initialState({ runId, sessionId, key, now = new Date().toISOString() }) {
  return {
    schemaVersion: 1, runId, sessionId, startedAt: now,
    ticket: { key }, tested: null, devChanges: [], qa: {}, phase: 'PREFLIGHT',
    plan: { approvedHash: null }, triage: [], gates: [], publication: {}, timeline: [],
  };
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
}

export function applyCommand(state, cmd, args, { planJson, briefs = [], now = new Date().toISOString() } = {}) {
  const next = structuredClone(state);
  switch (cmd) {
    case 'phase': {
      const phase = args._[1];
      if (!PHASES.includes(phase)) throw new UsageError(`unknown phase "${phase}". One of: ${PHASES.join(', ')}`);
      next.phase = phase;
      next.timeline.push({ step: `phase:${phase}`, at: now });
      return next;
    }
    case 'timeline': {
      need(args, 'step');
      next.timeline.push({
        step: args.step, agent: args.agent ?? null, model: args.model ?? null,
        // An agent step starts when its brief was written, so metrics need no timestamp from the model.
        startedAt: args.started ?? briefs.findLast((b) => b.step === args.step)?.at ?? null, finishedAt: now, outcome: args.outcome ?? 'ok',
      });
      return next;
    }
    case 'gate': {
      need(args, 'id', 'decision');
      if (!GATES.includes(args.id)) throw new UsageError(`unknown gate "${args.id}". One of: ${GATES.join(', ')}`);
      const entry = { id: args.id, at: now, decision: args.decision, by: 'human', note: args.note ?? null };
      if (args.deliverOnClean && !(args.id === 'G2' && args.decision === 'approved')) {
        throw new UsageError('--deliver-on-clean goes only with a G2 approval');
      }
      if (args.id === 'G2' && args.decision === 'approved') {
        if (!planJson?.planHash) throw new Error('G2 approval needs plan.json with a planHash (run merge-plan.mjs first)');
        entry.planHash = planJson.planHash;
        // The human approved delivery too, for a clean pass only (deliver-tests.mjs checks it).
        if (args.deliverOnClean) entry.deliverOnClean = true;
        next.plan = { ...next.plan, hash: planJson.planHash, approvedHash: planJson.planHash };
      }
      next.gates.push(entry);
      return next;
    }
    case 'set': {
      const [, dotted, raw] = args._;
      if (!dotted || raw === undefined) throw new UsageError('usage: set --run <dir> <dotted.path> <json>');
      if (RESERVED.some((r) => dotted === r || dotted.startsWith(`${r}.`))) {
        throw new UsageError(`"${dotted}" is managed by its own command or script, not by set`);
      }
      let value;
      try { value = JSON.parse(raw); } catch { throw new UsageError(`value for ${dotted} is not valid JSON`); }
      setPath(next, dotted, value);
      return next;
    }
    default:
      throw new UsageError(`unknown command "${cmd}". Use phase | timeline | gate | set | show`);
  }
}

if (isMain(import.meta.url)) {
  main(async (args) => {
    need(args, 'run');
    const cmd = args._[0];
    const file = stateFile(args.run);
    const state = readJson(file);
    if (cmd === 'show') return state;
    const planJson = readJson(path.join(args.run, 'plan.json'), null);
    const briefs = readJson(path.join(args.run, 'briefs', 'index.json'), []);
    const next = applyCommand(state, cmd, args, { planJson, briefs });
    writeJsonAtomic(file, next);
    // Every recorded step refreshes RUN/progress.md, RUN/dashboard.html and RUN/metrics.json.
    refreshViews(args.run);
    return { ok: true, phase: next.phase, approvedHash: next.plan?.approvedHash ?? null };
  });
}
