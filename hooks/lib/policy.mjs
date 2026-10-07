// The guard's policy table (docs/design.md §6), as a pure function of the hook input
// and the loaded run context. Only called once the session is proven to own an
// active QA run; any exception here is turned into a block by guard.mjs.
import { firstDenial, isTestLaunch, subagentCommandAllowed } from './shell.mjs';
import { isUnder, join, resolveFrom, samePath } from './paths.mjs';

const PLUGIN = 'qa-orchestrator';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const WEAKENING = /\.(?:skip|fixme|only)\s*\(/;

const ALLOW = Object.freeze({ decision: 'allow' });
const allow = (effects) => ({ decision: 'allow', effects });
const deny = (rule, reason) => ({ decision: 'deny', rule, reason: `[qa-orchestrator ${rule}] ${reason}` });

// 'qa-orchestrator:qa-test-author' → 'qa-test-author'; anything else → null.
export function pluginAgent(agentType) {
  const s = String(agentType ?? '');
  return s.startsWith(`${PLUGIN}:`) ? s.slice(PLUGIN.length + 1) : null;
}

// After a run is released (awaiting the human, G4) the session keeps only the
// human-only rules: no merge/approve (H1), no push (H2), no final Jira status (H3).
const CLOSED_RULES = new Set(['H1', 'H2', 'H3']);

export function decide(input, ctx) {
  const result = decideOpen(input, ctx);
  if (ctx.active?.closed) {
    return result.decision === 'deny' && CLOSED_RULES.has(result.rule) ? result : ALLOW;
  }
  return result;
}

function decideOpen(input, ctx) {
  const tool = String(input.tool_name ?? '');
  const sub = Boolean(input.agent_id);
  const agent = sub ? pluginAgent(input.agent_type) : null;

  if (SHELL_TOOLS.has(tool)) return shellDecision(tool, input, ctx, sub, agent);
  if (EDIT_TOOLS.has(tool)) return editDecision(tool, input, ctx, sub, agent);
  if (READ_TOOLS.has(tool)) return sub ? readDecision(tool, input, ctx) : ALLOW;
  if (tool === 'Agent' || tool === 'Task') return agentDecision(input, ctx, sub);
  // Continuing an agent by message skips the brief, the validation and the H5 counters (found live: four
  // turn-limit continuations and one uncounted plan revision).
  if (tool === 'SendMessage') {
    return deny('H5', 'Agents are not continued by message during a QA run. An agent that stopped early or returned no valid JSON goes through the fix path: a note with what is missing, a brief with step "<step>-fix", and a new dispatch (it counts like any other).');
  }
  if (tool.startsWith('mcp__')) return mcpDecision(tool, input, ctx, sub);
  return ALLOW;
}

function shellDecision(tool, input, ctx, sub, agent) {
  const command = String(input.tool_input?.command ?? '');
  const denial = firstDenial(command, { pluginRoot: ctx.pluginRoot });
  if (denial) return deny(denial.id, denial.reason);

  if (sub) {
    if (tool !== 'Bash') return deny('H6', `Subagents may not use ${tool} during a QA run.`);
    const { ok, summary } = subagentCommandAllowed(agent, command, { pluginRoot: ctx.pluginRoot });
    if (!ok) {
      return deny('H6', `${input.agent_type ?? 'this subagent'} may only run: ${summary}. One command, no pipes, redirects or chaining.`);
    }
  }

  if (isTestLaunch(command, ctx.pluginRoot)) {
    const used = ctx.counters.testLaunches;
    const max = ctx.limits.maxTestLaunches;
    if (used >= max) {
      return deny('H7', `Test-launch budget used up (${used}/${max}). Escalate to the human (G3) instead of running tests again.`);
    }
    return allow({ testLaunches: 1 });
  }
  return ALLOW;
}

function editDecision(tool, input, ctx, sub, agent) {
  const ti = input.tool_input ?? {};
  const target = resolveFrom(input.cwd ?? ctx.projectDir, ti.file_path ?? ti.notebook_path);
  if (!target) return deny('H4', `${tool} call without a file path.`);

  if (ctx.controlFiles.some((f) => samePath(f, target)) || ctx.controlDirs.some((d) => isUnder(target, d))) {
    return deny('H10', 'Run control files (plan, state, baseline, counters, active run, lock) and run data (events, metrics, progress, dashboard, history, memory, the agent outputs in outputs/) are written only by the plugin scripts and hooks.');
  }

  if (!sub) {
    if (isUnder(target, ctx.worktree)) {
      return deny('H4', 'The main session does not edit the QA worktree. The qa-test-author agent does, within the approved plan.');
    }
    if (isUnder(target, join(ctx.projectDir, '.qa'))) {
      return deny('H4', 'QA configuration is frozen while a run is active.');
    }
    return ALLOW;
  }

  if (agent !== 'qa-test-author') {
    return deny('H4', `${input.agent_type ?? 'This subagent'} does not write files during a QA run.`);
  }
  if (!ctx.planApproved) {
    return deny('H4', 'The test plan has not been approved at G2 (planHash ≠ approvedHash). Nothing may be written yet.');
  }

  const testDir = join(ctx.worktree, ctx.config.qa.testDir);
  const rel = target.startsWith(`${ctx.worktree}/`) ? target.slice(ctx.worktree.length + 1) : target;
  if (!isUnder(target, testDir)) {
    return deny('H4', `${rel} is outside the QA test directory (${ctx.config.qa.testDir}). Product code is never changed by a QA run.`);
  }
  if ((ctx.config.qa.protectedFiles ?? []).some((f) => samePath(join(ctx.worktree, f), target))) {
    return deny('H4', `${rel} is protected (e.g. the Playwright config). Changing it could weaken the whole suite.`);
  }

  const changeSet = ctx.plan?.changeSet ?? {};
  const files = (list) => (list ?? []).map((item) => join(ctx.worktree, item.file));
  const allowed = ctx.phase === 'REPAIRING' ? files(changeSet.add) : [...files(changeSet.update), ...files(changeSet.add)];
  if (!allowed.some((f) => samePath(f, target))) {
    const hint = ctx.phase === 'REPAIRING' ? 'In repair mode only files added in this run may change.' : 'Only files in the approved change set may change.';
    return deny('H4', `${rel} is not in the approved change set. ${hint}`);
  }

  // A Write replaces the whole file. On a spec that existed before the run that silently drops its
  // existing tests (a rewrite once lost 8 tests), so pre-existing files change only by Edit.
  const preExisting = [...ctx.baselineFiles.map((f) => join(ctx.worktree, f)), ...files(changeSet.update)];
  if (tool === 'Write' && preExisting.some((f) => samePath(f, target))) {
    return deny('H4', `${rel} existed before this run. Write would replace the whole file and drop its existing tests; change it with Edit or MultiEdit. Write is only for new files.`);
  }

  const text = [ti.content, ti.new_string, ...(ti.edits ?? []).map((e) => e.new_string), ti.new_source]
    .filter((x) => typeof x === 'string').join('\n');
  if (WEAKENING.test(text)) {
    return deny('H4', 'test.skip / test.fixme / .only are not allowed. They hide failures instead of testing the requirement.');
  }
  return ALLOW;
}

// H11: subagents read only the run worktree (a clean checkout of the tested
// commit, so untracked secrets such as .env files aren't in it), the run folder
// and the plugin itself. Works for any repo without per-project deny lists.
const GLOB_CHARS = /[*?[{]/;

function readDecision(tool, input, ctx) {
  const ti = input.tool_input ?? {};
  const roots = [ctx.worktree, ctx.runDir, ctx.pluginRoot].filter(Boolean);
  const where = `the run worktree (${ctx.worktree}), the run folder or the plugin`;
  const inRoots = (p) => roots.some((r) => isUnder(p, r));

  let target;
  if (tool === 'Read') target = ti.file_path;
  else {
    const pattern = String(ti.pattern ?? '');
    const globArg = String(ti.glob ?? '');
    const parentRef = /(^|[\\/])\.\.([\\/]|$)/;
    if (parentRef.test(pattern) || parentRef.test(globArg)) return deny('H11', `${tool} patterns may not contain "..".`);
    target = ti.path;
    if (tool === 'Glob' && isAbsolutePattern(pattern)) {
      // An absolute pattern names its own directory: check the part before the first wildcard.
      const segs = pattern.replace(/\\/g, '/').split('/');
      const firstWild = segs.findIndex((s) => GLOB_CHARS.test(s));
      const base = (firstWild < 0 ? segs : segs.slice(0, firstWild)).join('/');
      if (!inRoots(resolveFrom('/', base))) return deny('H11', `Subagents may only search ${where}.`);
      if (!target) return ALLOW;
    }
    if (!target) return deny('H11', `${tool} needs an explicit "path" inside ${where}; the default is the main checkout.`);
  }
  const resolved = resolveFrom(input.cwd ?? ctx.projectDir, target);
  if (!resolved || !inRoots(resolved)) return deny('H11', `Subagents may only read ${where}.`);
  return ALLOW;
}

function isAbsolutePattern(p) {
  return /^(?:[a-zA-Z]:)?[\\/]/.test(p);
}

function agentDecision(input, ctx, sub) {
  if (sub) return deny('H5', 'Subagents do not start other agents during a QA run.');
  const name = pluginAgent(input.tool_input?.subagent_type);
  // Model tiering is part of the plugin's design (agents/*.md), not the orchestrator's choice.
  if (name && input.tool_input?.model) {
    return deny('H5', `Don't override the model for ${name}; the plugin defines it. Dispatch again without "model".`);
  }
  // A headless run (claude -p) exits when the orchestrator's turn ends, which orphans a backgrounded agent.
  if (name && input.tool_input?.run_in_background) {
    return deny('H5', `Dispatch ${name} in the foreground (without run_in_background) and wait for its result. A QA run never ends its turn while work is running.`);
  }
  const { criticRounds, producerDispatches } = ctx.counters;
  const maxRevisions = ctx.limits.maxPlanRevisions;

  if (name === 'qa-critic') {
    if (criticRounds >= 1 + maxRevisions) {
      return deny('H5', `Critic round limit reached (${criticRounds}). Ask the human to decide on the plan (G2-escalate).`);
    }
    return allow({ criticRounds: 1 });
  }
  if (name === 'qa-suite-impact' || name === 'qa-change-analyst') {
    const maxProducers = 2 * (1 + maxRevisions);
    if (criticRounds > maxRevisions || producerDispatches >= maxProducers) {
      return deny('H5', `Plan revision limit reached (${maxRevisions} revisions). Ask the human to decide on the plan (G2-escalate).`);
    }
    return allow({ producerDispatches: 1 });
  }
  return ALLOW;
}

// Jira through the Atlassian MCP is an allowlist, not a denylist: besides its
// direct tools it exposes generic executeWrite / executeDestructive tools that
// could reach any Jira operation, including a final-status transition.
const JIRA_READS = /^(?:get|search|list)|^(?:discover|executeRead|atlassianUserInfo)$/;

function jiraDecision(op, ti, ctx) {
  if (JIRA_READS.test(op)) return ALLOW;
  const key = String(ctx.active?.key ?? '').toUpperCase();
  const onRunTicket = String(ti.issueIdOrKey ?? '').toUpperCase() === key && key !== '';
  if (op === 'addOrEditJiraIssueComment') {
    return onRunTicket ? ALLOW : deny('H3', `A QA run only comments on its own ticket (${key}).`);
  }
  if (op === 'transitionJiraIssue') {
    if (!onRunTicket) return deny('H3', `A QA run only transitions its own ticket (${key}).`);
    const id = ti.transitionId ?? ti.transition?.id ?? ti.transition_id;
    const allowedIds = (ctx.config.jira?.allowedTransitionIds ?? []).map(String);
    if (id === undefined || !allowedIds.includes(String(id))) {
      return deny('H3', `Jira transition ${id ?? '(no transitionId; names are not accepted)'} is not one the QA run may perform (allowed ids: ${allowedIds.join(', ') || 'none configured'}). Final QA statuses are set by a human.`);
    }
    return ALLOW;
  }
  return deny('H3', `Jira operation "${op}" is not allowed during a QA run. Allowed: reads, a comment on ${key}, and the configured transitions.`);
}

function mcpDecision(tool, input, ctx, sub) {
  const jiraPrefix = ctx.config.jira?.mcpToolPrefix ?? 'mcp__atlassian__';
  if (tool.startsWith(jiraPrefix)) {
    if (sub) return deny('H8', 'Only the main session talks to Jira.');
    return jiraDecision(tool.slice(jiraPrefix.length), input.tool_input ?? {}, ctx);
  }
  // A second Atlassian connector in the session (the claude.ai one, mcp__claude_ai_Atlassian_Rovo__*)
  // would skip every check above, so only the configured one reaches Jira. H3, so it holds after release.
  if (/atlassian|jira|confluence/i.test(tool)) {
    const server = tool.split('__').slice(0, 2).join('__');
    return deny('H3', `${server} is not the configured Jira connector (${jiraPrefix}). A QA run reaches Jira only through that one.`);
  }
  if (/github/i.test(tool)) {
    const op = tool.split('__').pop();
    if (!/^(?:get_|list_|search_)|_read$/i.test(op)) {
      return deny('H1', `GitHub write "${op}" is not allowed during a QA run. deliver-tests.mjs owns the only GitHub writes.`);
    }
    return sub ? deny('H8', 'Subagents use no MCP tools during a QA run.') : ALLOW;
  }
  if (sub) return deny('H8', 'Subagents use no MCP tools during a QA run.');
  return ALLOW;
}
