// qa-orchestrator guard: PreToolUse hook for the policy table in docs/design.md §6.
//
// The plugin is installed at project/local scope, so this runs in every Claude
// Code session in the target repo, not only the QA run. Order of business:
//   1. Not provably the owner of an active QA run → exit 0, no output. Any
//      error while finding out also allows: a bug here must never block the
//      user's unrelated sessions.
//   2. Owner → load the run context and decide. An error from this point on
//      blocks the call (exit 2): inside a run we fail closed.
// QA_HOOK_LOG=1 appends every payload to $CLAUDE_PLUGIN_DATA/hook-log.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOwnedRun, loadContext, recordEffects } from './lib/context.mjs';
import { decide } from './lib/policy.mjs';

const event = process.argv[2] ?? 'PreToolUse';

function log(input) {
  if (process.env.QA_HOOK_LOG !== '1') return;
  try {
    const dir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'qa-orchestrator');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hook-log.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(), event, projectDirEnv: process.env.CLAUDE_PROJECT_DIR ?? null, payload: input,
    })}\n`);
  } catch {
    // Logging never breaks a session.
  }
}

// Denials are run data (dashboard, memory). Recording one never changes the decision.
function logDenial(ctx, result, input) {
  try {
    appendFileSync(join(ctx.runDirRaw, 'events.jsonl'), `${JSON.stringify({
      kind: 'deny', at: new Date().toISOString(), rule: result.rule ?? null, tool: input.tool_name ?? null,
      agent: input.agent_type ?? null, reason: result.reason,
      // What was denied, so a memory hint can name the command, not only the rule.
      call: String(input.tool_input?.command ?? input.tool_input?.file_path ?? input.tool_input?.pattern ?? input.tool_input?.subagent_type ?? '').slice(0, 200) || null,
    })}\n`);
  } catch {
    // Logging never breaks the guard.
  }
}

function run(raw) {
  let input;
  try { input = JSON.parse(raw); } catch { return 0; }
  log(input);

  let owned = null;
  try { owned = findOwnedRun(input, process.env); } catch { return 0; }
  if (!owned) return 0;

  try {
    const ctx = loadContext(owned, process.env);
    const result = decide(input, ctx);
    if (result.decision === 'deny') {
      logDenial(ctx, result, input);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason,
        },
      }));
      return 0;
    }
    if (result.effects) recordEffects(ctx, result.effects, input);
    return 0;
  } catch (err) {
    process.stderr.write(`[qa-orchestrator guard] ${err?.message ?? err}. A QA run is active, so this call is blocked. Fix the run files or end the run.`);
    return 2;
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => { process.exit(run(raw)); });
