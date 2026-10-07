// Guard tests: node --test hooks/test/
// Payload shapes mirror the real ones captured in build step 1 (docs/setup.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefVars } from '../../scripts/brief.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..', '..');
const guard = path.join(pluginRoot, 'hooks', 'guard.mjs');
const SESSION = '5c9e1885-0000-4000-8000-000000000001';

function makeRun({ sessionId = SESSION, approved = true, phase = 'MAINTAINING', counters = {}, config = {}, skipConfig = false, baseline = ['client/e2e/checkout.spec.ts'] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-guard-'));
  const project = path.join(root, 'app');
  const runDir = path.join(project, '.qa-runs', 'PROJ-1', 'run1');
  const worktree = path.join(project, '.qa-worktrees', 'run1');
  mkdirSync(path.join(project, '.qa'), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  mkdirSync(path.join(worktree, 'client', 'e2e'), { recursive: true });
  if (!skipConfig) {
    writeFileSync(path.join(project, '.qa', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      jira: { mcpToolPrefix: 'mcp__atlassian__', allowedTransitionIds: ['21', '31'] },
      qa: { testDir: 'client/e2e', protectedFiles: ['client/e2e/playwright.config.ts'] },
      limits: { maxPlanRevisions: 2, maxTestLaunches: 6 },
      ...config,
    }));
  }
  writeFileSync(path.join(project, '.qa-runs', 'active.json'), JSON.stringify({
    key: 'PROJ-1', runId: 'run1', runDir, worktree, sessionId, qaBranch: 'qa/PROJ-1-checkout-total',
  }));
  writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({
    planHash: 'sha256:abc',
    changeSet: {
      update: [{ file: 'client/e2e/checkout.spec.ts', acId: 'AC2' }],
      add: [{ file: 'client/e2e/cart.spec.ts', acId: 'AC1', kind: 'ui' }],
      delete: [],
    },
  }));
  writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ phase, plan: { approvedHash: approved ? 'sha256:abc' : null } }));
  if (baseline) {
    const files = Object.fromEntries(baseline.map((f) => [f, { sha: '0', expects: 1, markers: 0, tests: ['t'] }]));
    writeFileSync(path.join(runDir, 'suite-baseline.json'), JSON.stringify({ testDir: 'client/e2e', files }));
  }
  const lines = Object.entries(counters).flatMap(([kind, n]) => Array.from({ length: n }, () => JSON.stringify({ kind })));
  if (lines.length) writeFileSync(path.join(runDir, 'counters.log'), `${lines.join('\n')}\n`);
  return { root, project, runDir, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const main = (run, tool_name, tool_input) => ({
  session_id: SESSION, transcript_path: 'x.jsonl', cwd: run.project, prompt_id: 'p1',
  permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'toolu_1',
});
const sub = (run, agent, tool_name, tool_input) => ({
  ...main(run, tool_name, tool_input), agent_id: 'a485fcc0ca6201206', agent_type: `qa-orchestrator:${agent}`,
});

function callGuard(payload, { projectDir, raw } = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, QA_HOOK_LOG: '' };
  if (projectDir === undefined) delete env.CLAUDE_PROJECT_DIR;
  else env.CLAUDE_PROJECT_DIR = projectDir;
  const r = spawnSync(process.execPath, [guard, 'PreToolUse'], { input: raw ?? JSON.stringify(payload), env, encoding: 'utf8' });
  let decision = 'allow';
  let reason = '';
  if (r.status === 2) { decision = 'block'; reason = r.stderr; }
  else if (r.stdout.trim()) {
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    decision = out.permissionDecision;
    reason = out.permissionDecisionReason;
  }
  return { decision, reason, status: r.status };
}

function expectDecision(run, payload, decision, rule) {
  const r = callGuard(payload, { projectDir: run.project });
  assert.equal(r.decision, decision, `${JSON.stringify(payload.tool_input)} → ${r.decision}: ${r.reason}`);
  if (rule) assert.match(r.reason, new RegExp(`\\b${rule}\\b`));
  return r;
}

const counterLines = (run) => (existsSync(path.join(run.runDir, 'counters.log'))
  ? readFileSync(path.join(run.runDir, 'counters.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).kind)
  : []);

// ── Dormancy: the guard must never interfere outside a run it owns ──────────
test('dormant: no active run → allow even git push origin main', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-guard-'));
  const payload = { session_id: SESSION, cwd: root, tool_name: 'Bash', tool_input: { command: 'git push origin main --force' } };
  assert.equal(callGuard(payload, { projectDir: root }).decision, 'allow');
  rmSync(root, { recursive: true, force: true });
});

test('dormant: another session owns the run → allow', () => {
  const run = makeRun({ sessionId: 'someone-else' });
  expectDecision(run, main(run, 'Bash', { command: 'gh pr merge 12' }), 'allow');
  run.cleanup();
});

test('owned run whose .qa/config.json went missing → block (exit 2), not dormant', () => {
  // Moving the config away must not switch the guard off (external review, F1).
  const run = makeRun({ skipConfig: true });
  const r = callGuard(main(run, 'Bash', { command: 'git push origin main' }), { projectDir: run.project });
  assert.equal(r.status, 2);
  assert.match(r.reason, /config\.json is missing/);
  run.cleanup();
});

test('crash before ownership (corrupt active.json) → allow', () => {
  const run = makeRun();
  writeFileSync(path.join(run.project, '.qa-runs', 'active.json'), '{ half-written');
  expectDecision(run, main(run, 'Bash', { command: 'git push origin main' }), 'allow');
  run.cleanup();
});

test('unparseable hook input → allow', () => {
  assert.equal(callGuard(null, { raw: 'not json' }).decision, 'allow');
});

test('ownership found from cwd inside the run worktree when CLAUDE_PROJECT_DIR is unset', () => {
  const run = makeRun();
  const payload = { ...main(run, 'Bash', { command: 'git push origin HEAD' }), cwd: run.worktree };
  const r = callGuard(payload, { projectDir: undefined });
  assert.equal(r.decision, 'deny');
  run.cleanup();
});

// ── Fail closed once the session owns the run ───────────────────────────────
test('owned run + broken config → block (exit 2)', () => {
  const run = makeRun({ config: { qa: {} } });
  const r = callGuard(main(run, 'Bash', { command: 'ls' }), { projectDir: run.project });
  assert.equal(r.status, 2);
  run.cleanup();
});

test('owned run + corrupt plan.json → block (exit 2)', () => {
  const run = makeRun();
  writeFileSync(path.join(run.runDir, 'plan.json'), '{');
  assert.equal(callGuard(main(run, 'Bash', { command: 'ls' }), { projectDir: run.project }).status, 2);
  run.cleanup();
});

// ── H1 merge / approve are human-only ───────────────────────────────────────
test('H1: merge and approve are denied however they are phrased', () => {
  const run = makeRun();
  for (const command of [
    'gh pr merge 12 --squash',
    'bash -c "gh pr merge 12"',
    'FOO=1 gh.exe pr merge 12',
    'gh pr review 5 --approve',
    'gh api -X PUT repos/example/app/pulls/5/merge',
    'git merge qa/PROJ-1-x',
  ]) expectDecision(run, main(run, 'Bash', { command }), 'deny', 'H1');
  expectDecision(run, main(run, 'PowerShell', { command: 'gh pr merge 12' }), 'deny', 'H1');
  expectDecision(run, main(run, 'PowerShell', { command: 'pwsh -Command "gh pr merge 12"' }), 'deny', 'H1');
  expectDecision(run, main(run, 'mcp__plugin_github_github__merge_pull_request', { pullNumber: 5 }), 'deny', 'H1');
  expectDecision(run, main(run, 'mcp__plugin_github_github__pull_request_review_write', { method: 'create' }), 'deny', 'H1');
  expectDecision(run, main(run, 'mcp__plugin_github_github__pull_request_read', { pullNumber: 5 }), 'allow');
  run.cleanup();
});

// ── H2 / H9 git and PR writes go through the scripts only ──────────────────
test('H2: every direct git push is denied, including refspec and -C forms', () => {
  const run = makeRun();
  for (const command of [
    'git push origin qa/PROJ-1-checkout-total',
    'git -C "C:/work/app" push origin HEAD:main',
    'git -c push.default=current push',
    'cd x && git push --force',
  ]) expectDecision(run, main(run, 'Bash', { command }), 'deny', 'H2');
  run.cleanup();
});

test('H9: git writes and PR creation are denied; reads are allowed', () => {
  const run = makeRun();
  for (const command of ['git commit -m wip', 'git add -A', 'git checkout demo/stage', 'gh pr create --base stage --head qa/PROJ-1-x']) {
    expectDecision(run, main(run, 'Bash', { command }), 'deny', 'H9');
  }
  for (const command of ['git log -1 --oneline', 'git diff demo/stage~3..demo/stage', 'gh pr list --state merged --base demo/stage', 'ls client/e2e']) {
    expectDecision(run, main(run, 'Bash', { command }), 'allow');
  }
  run.cleanup();
});

// ── H10 run control files ──────────────────────────────────────────────────
test('H10: control files only via plugin scripts', () => {
  const run = makeRun();
  expectDecision(run, main(run, 'Bash', { command: `echo {} > "${run.runDir}/state.json"` }), 'deny', 'H10');
  expectDecision(run, main(run, 'PowerShell', { command: `Set-Content "${run.project}/.qa-runs/active.json" "{}"` }), 'deny', 'H10');
  expectDecision(run, main(run, 'Bash', { command: `node "${pluginRoot}/scripts/state.mjs" --state "${run.runDir}/state.json" phase EXECUTING` }), 'allow');
  expectDecision(run, main(run, 'Bash', { command: `node "C:/elsewhere/scripts/state.mjs" "${run.runDir}/state.json"` }), 'deny', 'H10');
  const gitBashRoot = pluginRoot.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  expectDecision(run, main(run, 'Bash', { command: `node "${gitBashRoot}/scripts/state.mjs" --state "${run.runDir}/state.json" show` }), 'allow');
  expectDecision(run, main(run, 'Write', { file_path: path.join(run.runDir, 'state.json'), content: '{}' }), 'deny', 'H10');
  expectDecision(run, main(run, 'Edit', { file_path: path.join(run.runDir, 'plan.json'), old_string: 'a', new_string: 'b' }), 'deny', 'H10');
  expectDecision(run, main(run, 'Write', { file_path: path.join(run.runDir, 'intake.json'), content: '{}' }), 'allow');
  run.cleanup();
});

// ── Bypasses found by an external review (F1–F4) ────────────
test('H10: the .qa/ and .qa-runs/ folders can\'t be renamed or deleted from the shell', () => {
  const run = makeRun();
  for (const command of [
    'mv .qa/config.json .qa/config.saved',
    'mv .qa .qa-off',
    'rm -rf .qa-runs',
    `Remove-Item -Recurse "${run.project}\\.qa-runs"`,
    `cp /dev/null "${run.project}/.qa/config.json"`,
  ]) expectDecision(run, main(run, 'Bash', { command }), 'deny', 'H10');
  // Paths inside those folders don't touch ownership, and real runs name them all the time
  // (`RUN=".../.qa-runs/PROJ-5/<run>" node …`, seen in live transcripts). The worktree folder is
  // a different name.
  for (const command of [
    `RUN="${run.runDir}" node "${pluginRoot}/scripts/state.mjs" timeline --run "$RUN" --step intake --outcome ok`,
    `time node "${pluginRoot}/scripts/preflight.mjs" status --project "${run.project}" --key PROJ-1`,
    `ls "${run.runDir}/playwright-report-1"`,
    'ls .qa-worktrees',
  ]) expectDecision(run, main(run, 'Bash', { command }), 'allow');
  run.cleanup();
});

test('closed run whose .qa/config.json went missing → dormant, so the session can still release', () => {
  // After release, H9 no longer applies: a checkout without the config must not lock the session.
  const run = makeRun({ skipConfig: true });
  const activePath = path.join(run.project, '.qa-runs', 'active.json');
  writeFileSync(activePath, JSON.stringify({ ...JSON.parse(readFileSync(activePath, 'utf8')), closed: true }));
  expectDecision(run, main(run, 'Bash', { command: `node "${pluginRoot}/scripts/preflight.mjs" release --project "${run.project}" --run "${run.runDir}" --forget` }), 'allow');
  run.cleanup();
});

test('H10: a plugin script call is exempt only on its own, not what is chained after it', () => {
  const run = makeRun();
  const script = `node "${pluginRoot}/scripts/state.mjs"`;
  for (const command of [
    `${script} show --run "${run.runDir}"; echo '{}' > "${run.runDir}/state.json"`,
    `${script} show --run "${run.runDir}" && rm "${run.runDir}/plan.json"`,
    `${script} show --run "${run.runDir}" | tee "${run.runDir}/state.json"`,
    `${script} set --run "${run.runDir}" ticket "$(cat ${run.runDir}/plan.json)"`,
    // An escaped quote outside quotes is a literal ', not the start of a quoted string.
    `${script} show --run "${run.runDir}" \\' ; echo {} > "${run.runDir}/state.json" \\'`,
  ]) expectDecision(run, main(run, 'Bash', { command }), 'deny', 'H10');
  // What the playbook really sends: quoted JSON and notes (with ; ( ) > inside the quotes), 2>&1.
  for (const command of [
    `${script} set --run "${run.runDir}" ticket '{"key":"PROJ-1","title":"Sort (desc) > asc; fix","url":"https://x/PROJ-1"}'`,
    `${script} gate --run "${run.runDir}" --id G2 --decision approved --note "answered (by operator); ok"`,
    `${script} show --run "${run.runDir}" 2>&1`,
    `${script} --state "$RUN/state.json" show`,
  ]) expectDecision(run, main(run, 'Bash', { command }), 'allow');
  run.cleanup();
});

test('H1/H2/H9: quoting or escaping the verb doesn\'t get past the rule', () => {
  const run = makeRun();
  for (const [command, rule] of [
    ['git "push" origin HEAD:main', 'H2'],
    ["git 'push' origin HEAD:main", 'H2'],
    ['git pu\\sh origin HEAD:main', 'H2'],
    ['g"i"t push', 'H2'],
    ['gh pr "merge" 123 --squash', 'H1'],
    ['gh "pr" merge 123', 'H1'],
    ['git "commit" -m x', 'H9'],
  ]) expectDecision(run, main(run, 'Bash', { command }), 'deny', rule);
  expectDecision(run, main(run, 'Bash', { command: 'git log --grep="push" -1' }), 'allow');
  run.cleanup();
});

test('H6/H11: read-only git can\'t read files outside the repo', () => {
  const run = makeRun();
  const secret = path.join(run.project, '.env');
  expectDecision(run, sub(run, 'qa-intake', 'Read', { file_path: secret }), 'deny', 'H11');
  for (const [agent, command] of [
    ['qa-intake', `git diff --no-index -- /dev/null "${secret}"`],
    ['qa-intake', `git diff /dev/null "${secret}"`],
    ['qa-intake', 'git diff --no-index a b'],
    ['qa-change-analyst', 'git diff HEAD -- ../../other/.env'],
    ['qa-change-analyst', 'git diff --ext-diff HEAD~1'],
    ['qa-intake', 'git show HEAD --textconv'],
    ['qa-triage', `git log -p -- "${secret}"`],
    ['qa-triage', 'git show --ext-diff HEAD'],
  ]) expectDecision(run, sub(run, agent, 'Bash', { command }), 'deny', 'H6');
  for (const [agent, command] of [
    ['qa-intake', 'git diff origin/demo/stage~3..origin/demo/stage -- client/src'],
    ['qa-change-analyst', 'git show abc123:client/src/App.tsx'],
    ['qa-intake', 'gh pr view 12 --json files,url'],
    ['qa-triage', 'git blame -L 10,20 abc123 -- client/e2e/checkout.spec.ts'],
  ]) expectDecision(run, sub(run, agent, 'Bash', { command }), 'allow');
  run.cleanup();
});

// ── H3 / H8 Jira ────────────────────────────────────────────────────────────
test('H3: Jira is an allowlist (reads, own-ticket comment, configured transitions); H8: subagents never touch Jira', () => {
  const run = makeRun();
  const cloudId = '00000000-0000-4000-8000-000000000000';
  // Real tool names and shapes from the build step 3 probe (docs/setup.md).
  expectDecision(run, main(run, 'mcp__atlassian__transitionJiraIssue', { cloudId, issueIdOrKey: 'PROJ-1', transitionId: '21' }), 'allow');
  expectDecision(run, main(run, 'mcp__atlassian__transitionJiraIssue', { cloudId, issueIdOrKey: 'proj-1', transition: { id: '31' } }), 'allow');
  expectDecision(run, main(run, 'mcp__atlassian__transitionJiraIssue', { cloudId, issueIdOrKey: 'PROJ-1', transitionId: '41' }), 'deny', 'H3');
  expectDecision(run, main(run, 'mcp__atlassian__transitionJiraIssue', { cloudId, issueIdOrKey: 'PROJ-1', transitionName: 'QA Passed' }), 'deny', 'H3');
  expectDecision(run, main(run, 'mcp__atlassian__transitionJiraIssue', { cloudId, issueIdOrKey: 'PROJ-2', transitionId: '21' }), 'deny', 'H3');
  expectDecision(run, main(run, 'mcp__atlassian__addOrEditJiraIssueComment', { cloudId, issueIdOrKey: 'PROJ-1', commentBody: 'x' }), 'allow');
  expectDecision(run, main(run, 'mcp__atlassian__addOrEditJiraIssueComment', { cloudId, issueIdOrKey: 'PROJ-9', commentBody: 'x' }), 'deny', 'H3');
  for (const op of ['getJiraIssue', 'searchJiraIssuesUsingJql', 'discover', 'atlassianUserInfo', 'getAccessibleAtlassianResources']) {
    expectDecision(run, main(run, `mcp__atlassian__${op}`, { cloudId }), 'allow');
  }
  expectDecision(run, main(run, 'mcp__atlassian__executeRead', { name: 'listJiraIssueTransitions', cloudId, inputs: { issueIdOrKey: 'PROJ-1' } }), 'allow');
  for (const op of ['executeWrite', 'executeDestructive', 'editJiraIssue', 'createJiraIssue', 'updateConfluenceContent']) {
    expectDecision(run, main(run, `mcp__atlassian__${op}`, { name: 'transitionJiraIssue', cloudId, inputs: { issueIdOrKey: 'PROJ-1', transitionId: '41' } }), 'deny', 'H3');
  }
  expectDecision(run, sub(run, 'qa-intake', 'mcp__atlassian__getJiraIssue', { issueIdOrKey: 'PROJ-1' }), 'deny', 'H8');
  expectDecision(run, sub(run, 'qa-intake', 'mcp__context7__query-docs', {}), 'deny', 'H8');
  run.cleanup();
});

test('H3: another Atlassian connector in the session is denied, reads included; the configured one is unaffected', () => {
  const run = makeRun();
  // The claude.ai connector configured on the author's machine, and a plugin-provided one.
  for (const tool of ['mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue', 'mcp__claude_ai_Atlassian_Rovo__getJiraIssue',
    'mcp__claude_ai_Atlassian_Rovo__authenticate', 'mcp__plugin_atlassian_atlassian__executeWrite', 'mcp__jira__addComment']) {
    expectDecision(run, main(run, tool, { issueIdOrKey: 'PROJ-1', transitionId: '41' }), 'deny', 'H3');
  }
  expectDecision(run, sub(run, 'qa-intake', 'mcp__claude_ai_Atlassian_Rovo__getJiraIssue', { issueIdOrKey: 'PROJ-1' }), 'deny', 'H3');
  expectDecision(run, main(run, 'mcp__atlassian__getJiraIssue', { issueIdOrKey: 'PROJ-1' }), 'allow');
  expectDecision(run, main(run, 'mcp__context7__query-docs', {}), 'allow');
  run.cleanup();
});

// ── H4 test author scope ────────────────────────────────────────────────────
test('H4: author writes only approved QA files, in any Windows path form', () => {
  const run = makeRun();
  const approved = path.join(run.worktree, 'client', 'e2e', 'checkout.spec.ts');
  const gitBash = approved.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  for (const file of [approved, approved.replace(/\\/g, '/'), gitBash, approved.toUpperCase()]) {
    expectDecision(run, sub(run, 'qa-test-author', 'Edit', { file_path: file, old_string: 'ELO', new_string: 'Rating' }), 'allow');
  }
  expectDecision(run, sub(run, 'qa-test-author', 'Write', { file_path: path.join(run.worktree, 'client/e2e/cart.spec.ts'), content: 'test("x", () => {})' }), 'allow');
  expectDecision(run, sub(run, 'qa-test-author', 'Edit', { file_path: path.join(run.worktree, 'client/e2e/home.spec.ts'), old_string: 'a', new_string: 'b' }), 'deny', 'H4');
  expectDecision(run, sub(run, 'qa-test-author', 'Write', { file_path: path.join(run.worktree, 'client/src/pages/CheckoutPage.tsx'), content: 'x' }), 'deny', 'H4');
  expectDecision(run, sub(run, 'qa-test-author', 'Edit', { file_path: path.join(run.worktree, 'client/e2e/playwright.config.ts'), old_string: 'retries: 0', new_string: 'retries: 5' }), 'deny', 'H4');
  expectDecision(run, sub(run, 'qa-test-author', 'Edit', { file_path: approved, old_string: 'test(', new_string: 'test.skip(' }), 'deny', 'H4');
  expectDecision(run, sub(run, 'qa-test-author', 'Write', { file_path: path.join(run.worktree, '../../outside.spec.ts'), content: 'x' }), 'deny', 'H4');
  expectDecision(run, sub(run, 'qa-triage', 'Write', { file_path: approved, content: 'x' }), 'deny', 'H4');
  run.cleanup();
});

test('H4: the author changes a pre-existing spec only with Edit, never a whole-file Write (live defect)', () => {
  const run = makeRun();
  const existing = path.join(run.worktree, 'client/e2e/checkout.spec.ts');
  const r = expectDecision(run, sub(run, 'qa-test-author', 'Write', { file_path: existing, content: 'test("only the new one", () => {})' }), 'deny', 'H4');
  assert.match(r.reason, /existed before this run.*Edit or MultiEdit/);
  expectDecision(run, sub(run, 'qa-test-author', 'Edit', { file_path: existing, old_string: 'a', new_string: 'b' }), 'allow');
  expectDecision(run, sub(run, 'qa-test-author', 'MultiEdit', { file_path: existing, edits: [{ old_string: 'a', new_string: 'b' }] }), 'allow');
  // Appending to a spec that already exists (an "add" item on an existing file) is the same case.
  const appendRun = makeRun({ baseline: ['client/e2e/checkout.spec.ts', 'client/e2e/cart.spec.ts'] });
  const appended = path.join(appendRun.worktree, 'client/e2e/cart.spec.ts');
  expectDecision(appendRun, sub(appendRun, 'qa-test-author', 'Write', { file_path: appended, content: 'x' }), 'deny', 'H4');
  expectDecision(appendRun, sub(appendRun, 'qa-test-author', 'Edit', { file_path: appended, old_string: 'a', new_string: 'b' }), 'allow');
  // No baseline (a run started before it existed): the plan's update items still count as pre-existing.
  const old = makeRun({ baseline: null });
  expectDecision(old, sub(old, 'qa-test-author', 'Write', { file_path: path.join(old.worktree, 'client/e2e/checkout.spec.ts'), content: 'x' }), 'deny', 'H4');
  expectDecision(old, sub(old, 'qa-test-author', 'Write', { file_path: path.join(old.worktree, 'client/e2e/cart.spec.ts'), content: 'x' }), 'allow');
  // The baseline is a control file the guard now trusts.
  expectDecision(run, main(run, 'Write', { file_path: path.join(run.runDir, 'suite-baseline.json'), content: '{}' }), 'deny', 'H10');
  expectDecision(run, main(run, 'Bash', { command: `echo {} > "${run.runDir}/suite-baseline.json"` }), 'deny', 'H10');
  for (const r2 of [run, appendRun, old]) r2.cleanup();
});

test('H9/H4: the main session restores a damaged spec only through restore-spec.mjs', () => {
  const run = makeRun();
  const rel = 'client/e2e/checkout.spec.ts';
  expectDecision(run, main(run, 'Bash', { command: `git -C "${run.worktree}" checkout HEAD -- ${rel}` }), 'deny', 'H9');
  expectDecision(run, main(run, 'Write', { file_path: path.join(run.worktree, rel), content: 'x' }), 'deny', 'H4');
  const restore = `node "${pluginRoot}/scripts/restore-spec.mjs" --run "${run.runDir}" --project "${run.project}" --file ${rel}`;
  expectDecision(run, main(run, 'Bash', { command: restore }), 'allow');
  run.cleanup();
});

test('H4: nothing is written before G2 approval; repair mode narrows to added files', () => {
  const unapproved = makeRun({ approved: false });
  expectDecision(unapproved, sub(unapproved, 'qa-test-author', 'Write', { file_path: path.join(unapproved.worktree, 'client/e2e/cart.spec.ts'), content: 'x' }), 'deny', 'H4');
  unapproved.cleanup();

  const repair = makeRun({ phase: 'REPAIRING' });
  expectDecision(repair, sub(repair, 'qa-test-author', 'Edit', { file_path: path.join(repair.worktree, 'client/e2e/checkout.spec.ts'), old_string: 'a', new_string: 'b' }), 'deny', 'H4');
  expectDecision(repair, sub(repair, 'qa-test-author', 'Edit', { file_path: path.join(repair.worktree, 'client/e2e/cart.spec.ts'), old_string: 'a', new_string: 'b' }), 'allow');
  repair.cleanup();
});

test('H4: qa.playwrightConfig is protected even when qa.protectedFiles leaves it out', () => {
  const run = makeRun({ config: { qa: { testDir: 'client/e2e', playwrightConfig: 'client/e2e/playwright.config.ts' } } });
  const r = expectDecision(run, sub(run, 'qa-test-author', 'Edit', { file_path: path.join(run.worktree, 'client/e2e/playwright.config.ts'), old_string: 'retries: 0', new_string: 'retries: 5' }), 'deny', 'H4');
  assert.match(r.reason, /is protected/);
  run.cleanup();
});

test('H4: main session may not edit the worktree or the QA config during a run', () => {
  const run = makeRun();
  expectDecision(run, main(run, 'Edit', { file_path: path.join(run.worktree, 'client/e2e/checkout.spec.ts'), old_string: 'a', new_string: 'b' }), 'deny', 'H4');
  expectDecision(run, main(run, 'Write', { file_path: path.join(run.project, '.qa', 'config.json'), content: '{}' }), 'deny', 'H4');
  run.cleanup();
});

// ── H5 bounded reflection ──────────────────────────────────────────────────
test('H5: critic rounds and plan revisions are capped by hook-owned counters', () => {
  const fresh = makeRun();
  expectDecision(fresh, main(fresh, 'Agent', { subagent_type: 'qa-orchestrator:qa-suite-impact', prompt: 'x' }), 'allow');
  expectDecision(fresh, main(fresh, 'Agent', { subagent_type: 'qa-orchestrator:qa-critic', prompt: 'x' }), 'allow');
  assert.deepEqual(counterLines(fresh), ['producerDispatches', 'criticRounds']);
  fresh.cleanup();

  const round2 = makeRun({ counters: { criticRounds: 2, producerDispatches: 4 } });
  expectDecision(round2, main(round2, 'Agent', { subagent_type: 'qa-orchestrator:qa-change-analyst', prompt: 'x' }), 'allow');
  round2.cleanup();

  const exhausted = makeRun({ counters: { criticRounds: 3 } });
  expectDecision(exhausted, main(exhausted, 'Agent', { subagent_type: 'qa-orchestrator:qa-critic', prompt: 'x' }), 'deny', 'H5');
  expectDecision(exhausted, main(exhausted, 'Agent', { subagent_type: 'qa-orchestrator:qa-suite-impact', prompt: 'x' }), 'deny', 'H5');
  exhausted.cleanup();

  const tiering = makeRun();
  expectDecision(tiering, main(tiering, 'Agent', { subagent_type: 'qa-orchestrator:qa-critic', prompt: 'x', model: 'haiku' }), 'deny', 'H5');
  expectDecision(tiering, main(tiering, 'Agent', { subagent_type: 'qa-orchestrator:qa-intake', prompt: 'x', model: 'sonnet' }), 'deny', 'H5');
  tiering.cleanup();

  // Headless runs exit when the orchestrator's turn ends; a background agent would be orphaned.
  const background = makeRun();
  expectDecision(background, main(background, 'Agent', { subagent_type: 'qa-orchestrator:qa-test-author', prompt: 'x', run_in_background: true }), 'deny', 'H5');
  expectDecision(background, main(background, 'Agent', { subagent_type: 'qa-orchestrator:qa-critic', prompt: 'x', run_in_background: true }), 'deny', 'H5');
  assert.deepEqual(counterLines(background), [], 'a denied background dispatch uses no critic round');
  expectDecision(background, main(background, 'Agent', { subagent_type: 'qa-orchestrator:qa-test-author', prompt: 'x', run_in_background: false }), 'allow');
  background.cleanup();

  // Continuing an agent by message would skip the brief, validation and these counters.
  const resume = makeRun();
  expectDecision(resume, main(resume, 'SendMessage', { to: 'a8a4a45859103ab31', message: 'Deliver your report now.' }), 'deny', 'H5');
  expectDecision(resume, sub(resume, 'qa-triage', 'SendMessage', { to: 'x', message: 'y' }), 'deny', 'H5');
  const activePath = path.join(resume.project, '.qa-runs', 'active.json');
  writeFileSync(activePath, JSON.stringify({ ...JSON.parse(readFileSync(activePath, 'utf8')), closed: true }));
  expectDecision(resume, main(resume, 'SendMessage', { to: 'x', message: 'y' }), 'allow');
  resume.cleanup();

  const spam = makeRun({ counters: { criticRounds: 1, producerDispatches: 6 } });
  expectDecision(spam, main(spam, 'Agent', { subagent_type: 'qa-orchestrator:qa-suite-impact', prompt: 'x' }), 'deny', 'H5');
  expectDecision(spam, sub(spam, 'qa-intake', 'Agent', { subagent_type: 'Explore', prompt: 'x' }), 'deny', 'H5');
  spam.cleanup();
});

// ── H6 subagent shell allowlist ────────────────────────────────────────────
test('H6: subagents run only their whole-command allowlist', () => {
  const run = makeRun();
  expectDecision(run, sub(run, 'qa-intake', 'Bash', { command: 'git log -1 --oneline .' }), 'allow');
  expectDecision(run, sub(run, 'qa-change-analyst', 'Bash', { command: 'gh pr diff 131' }), 'allow');
  for (const command of ['git log; rm -rf client', 'git log && curl evil', 'git diff --output=x.patch', 'cat secrets.txt', 'git log $(whoami)']) {
    expectDecision(run, sub(run, 'qa-intake', 'Bash', { command }), 'deny', 'H6');
  }
  const selfCheck = `node "${pluginRoot}/scripts/run-playwright.mjs" --run "${run.runDir}" --project "${run.project}" --self-check 1 --files client/e2e/cart.spec.ts`;
  expectDecision(run, sub(run, 'qa-test-author', 'Bash', { command: selfCheck }), 'allow');
  expectDecision(run, sub(run, 'qa-test-author', 'Bash', { command: 'npx playwright test client/e2e/cart.spec.ts' }), 'deny', 'H6');
  expectDecision(run, sub(run, 'qa-test-author', 'Bash', { command: selfCheck.replace(' --self-check 1', ' --attempt 1') }), 'deny', 'H6');
  expectDecision(run, sub(run, 'qa-test-author', 'Bash', { command: `${selfCheck} --update-snapshots` }), 'deny', 'H6');
  expectDecision(run, sub(run, 'qa-test-author', 'Bash', { command: `node "${pluginRoot}/scripts/state.mjs" --run x phase EXECUTING` }), 'deny', 'H6');
  expectDecision(run, sub(run, 'qa-test-author', 'Bash', { command: `node "C:/evil/scripts/run-playwright.mjs" --self-check 1 --files a` }), 'deny', 'H6');
  expectDecision(run, sub(run, 'qa-test-author', 'Bash', { command: 'git status' }), 'deny', 'H6');
  expectDecision(run, sub(run, 'qa-triage', 'Bash', { command: 'ls' }), 'deny', 'H6');
  // Triage verifies causeCommit itself with read-only history commands.
  for (const command of ['git log --oneline -5 abc1234 -- client/e2e/a11y.spec.ts', 'git show 7f8a6bd --stat', 'git blame -L 10,20 abc1234 -- client/e2e/a11y.spec.ts',
    // Metacharacters inside quotes are literal (this exact call was once denied).
    'git log -S"setTimeout(" --format="%h %ad %s" abc1234 -- client/e2e/game-keyboard.spec.ts', "git log -G'a|b' -- client/e2e/x.spec.ts"]) {
    expectDecision(run, sub(run, 'qa-triage', 'Bash', { command }), 'allow');
  }
  for (const command of ['git blame --contents C:/Users/me/.env abc -- f', 'git log --output=x.txt', 'git diff HEAD', 'git -C elsewhere log', 'git log && ls', 'gh pr view 1', 'git checkout abc',
    'git log -S"$(id)"', 'git log -S"$HOME"', 'git log -S"`id`"', 'git log -S"x" ; ls', 'git log -S"x" > out.txt',
    'git log "--output=x.txt"', "git blame '--contents' C:/x -- f"]) {
    expectDecision(run, sub(run, 'qa-triage', 'Bash', { command }), 'deny');
  }
  expectDecision(run, sub(run, 'qa-intake', 'PowerShell', { command: 'Get-ChildItem' }), 'deny', 'H6');
  const stranger = { ...sub(run, 'x', 'Bash', { command: 'ls' }), agent_type: 'Explore' };
  expectDecision(run, stranger, 'deny', 'H6');
  run.cleanup();
});

// ── H11 subagent read scope ─────────────────────────────────────────────────
test('H11: subagents read only the worktree, the run folder and the plugin; the main session is unrestricted', () => {
  const run = makeRun();
  const wt = (p) => path.join(run.worktree, p);
  expectDecision(run, sub(run, 'qa-critic', 'Read', { file_path: wt('client/e2e/home.spec.ts') }), 'allow');
  expectDecision(run, sub(run, 'qa-critic', 'Read', { file_path: path.join(run.runDir, 'plan.json') }), 'allow');
  expectDecision(run, sub(run, 'qa-critic', 'Read', { file_path: path.join(pluginRoot, 'schemas', 'qa-critic.schema.json') }), 'allow');
  expectDecision(run, sub(run, 'qa-triage', 'Grep', { pattern: 'expect', path: wt('client/e2e') }), 'allow');
  expectDecision(run, sub(run, 'qa-suite-impact', 'Glob', { pattern: '**/*.spec.ts', path: run.worktree }), 'allow');
  expectDecision(run, sub(run, 'qa-suite-impact', 'Glob', { pattern: `${run.worktree.replace(/\\/g, '/')}/client/**/*.ts` }), 'allow');

  // Outside the roots: the main checkout's untracked files, the user profile, other repos.
  expectDecision(run, sub(run, 'qa-intake', 'Read', { file_path: path.join(run.project, '.env') }), 'deny', 'H11');
  expectDecision(run, sub(run, 'qa-intake', 'Read', { file_path: 'C:/Users/me/.claude/settings.json' }), 'deny', 'H11');
  expectDecision(run, sub(run, 'qa-intake', 'Read', { file_path: wt('../../../secrets.txt') }), 'deny', 'H11');
  expectDecision(run, sub(run, 'qa-triage', 'Grep', { pattern: 'API_KEY' }), 'deny', 'H11');
  expectDecision(run, sub(run, 'qa-triage', 'Grep', { pattern: 'x', path: run.worktree, glob: '../**/.env' }), 'deny', 'H11');
  expectDecision(run, sub(run, 'qa-suite-impact', 'Glob', { pattern: 'C:/Users/me/**/.env' }), 'deny', 'H11');
  expectDecision(run, sub(run, 'qa-suite-impact', 'Glob', { pattern: '**/*.ts' }), 'deny', 'H11');

  expectDecision(run, main(run, 'Read', { file_path: path.join(run.project, '.env') }), 'allow');
  run.cleanup();
});

// ── Closed run (released, awaiting the human at G4) ─────────────────────────
test('closed run: only the human-only rules remain (merge, push, final Jira status)', () => {
  const run = makeRun();
  const activePath = path.join(run.project, '.qa-runs', 'active.json');
  writeFileSync(activePath, JSON.stringify({ ...JSON.parse(readFileSync(activePath, 'utf8')), closed: true }));
  expectDecision(run, main(run, 'Bash', { command: 'gh pr merge 77 --squash' }), 'deny', 'H1');
  expectDecision(run, main(run, 'Bash', { command: 'git push origin main' }), 'deny', 'H2');
  expectDecision(run, main(run, 'mcp__atlassian__transitionJiraIssue', { issueIdOrKey: 'PROJ-1', transition: { id: '41' } }), 'deny', 'H3');
  expectDecision(run, main(run, 'mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue', { issueIdOrKey: 'PROJ-1', transitionId: '41' }), 'deny', 'H3');
  expectDecision(run, main(run, 'Bash', { command: 'git commit -m "normal work"' }), 'allow');
  expectDecision(run, main(run, 'Edit', { file_path: path.join(run.worktree, 'client/e2e/home.spec.ts'), old_string: 'a', new_string: 'b' }), 'allow');
  expectDecision(run, main(run, 'Agent', { subagent_type: 'qa-orchestrator:qa-critic', prompt: 'x' }), 'allow');
  run.cleanup();
});

// ── H7 aggregate test-launch budget ────────────────────────────────────────
test('H7: reading or grepping the runner is not a launch; wrapped playwright runs are (live defect)', () => {
  const run = makeRun();
  const runner = `${pluginRoot.replace(/\\/g, '/')}/scripts/run-playwright.mjs`;
  for (const command of [`grep -n "PLAYWRIGHT" "${runner}"`, `cat "${runner}"`, 'git log -1 -- scripts/run-playwright.mjs']) {
    expectDecision(run, main(run, 'Bash', { command }), 'allow');
  }
  assert.deepEqual(counterLines(run), [], 'no launches counted for reads');
  for (const command of ['npx playwright test client/e2e/home.spec.ts', 'bash -c "npx playwright test"', `node "${runner}" --run x --project y --attempt 1`,
    // The playbook's S stood for the scripts dir, and a live re-test ran exactly this: uncounted.
    `S="${pluginRoot.replace(/\\/g, '/')}/scripts"; node "$S/run-playwright.mjs" --run x --project y --attempt 1`]) {
    expectDecision(run, main(run, 'Bash', { command }), 'allow');
  }
  assert.equal(counterLines(run).length, 4);
  run.cleanup();
});

test('H7: test launches are counted across the author and the runner script', () => {
  const run = makeRun({ counters: { testLaunches: 5 } });
  expectDecision(run, main(run, 'Bash', { command: `node "${pluginRoot}/scripts/run-playwright.mjs" --run "${run.runDir}" --attempt 1` }), 'allow');
  assert.equal(counterLines(run).filter((k) => k === 'testLaunches').length, 6);
  expectDecision(run, sub(run, 'qa-test-author', 'Bash', { command: `node "${pluginRoot}/scripts/run-playwright.mjs" --run "${run.runDir}" --project "${run.project}" --self-check 2 --files client/e2e/a.spec.ts` }), 'deny', 'H7');
  run.cleanup();
});

// The probe moved to the FEEDBACK phase (while qa-feedback writes). Only the budget may stop it.
test('H7: the known-drift probe in FEEDBACK is one counted launch, denied only by the budget', () => {
  const probe = (run) => main(run, 'Bash', { command: `node "${pluginRoot}/scripts/run-playwright.mjs" --run "${run.runDir}" --project "${run.project}" --drift-probe` });
  const run = makeRun({ phase: 'FEEDBACK', counters: { testLaunches: 5 } });
  expectDecision(run, probe(run), 'allow');
  assert.equal(counterLines(run).filter((k) => k === 'testLaunches').length, 6);
  expectDecision(run, probe(run), 'deny', 'H7');
  run.cleanup();
});

// ── Run data: H10 protection, denial log, recorder hook ────────────────────
const events = (run) => (existsSync(path.join(run.runDir, 'events.jsonl'))
  ? readFileSync(path.join(run.runDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

test('H10: run data (events, metrics, progress, dashboard, history, memory) is written only by the plugin', () => {
  const run = makeRun();
  for (const f of ['events.jsonl', 'metrics.json', 'progress.md', 'dashboard.html']) {
    expectDecision(run, main(run, 'Write', { file_path: path.join(run.runDir, f), content: 'x' }), 'deny', 'H10');
  }
  for (const f of ['history.jsonl', 'memory.json', 'MEMORY.md']) {
    expectDecision(run, main(run, 'Write', { file_path: path.join(run.project, '.qa-runs', f), content: 'x' }), 'deny', 'H10');
  }
  expectDecision(run, main(run, 'Bash', { command: `echo {} >> "${run.project}/.qa-runs/memory.json"` }), 'deny', 'H10');
  expectDecision(run, main(run, 'Bash', { command: `node "${pluginRoot}/scripts/memory.mjs" forget --project "${run.project}" --id abc` }), 'allow');
  // Notes are the orchestrator's own handoff files, not control files.
  expectDecision(run, main(run, 'Write', { file_path: path.join(run.runDir, 'notes', 'critic-2.md'), content: 'gaps' }), 'allow');
  run.cleanup();
});

test('H6/H7: the self-check command a brief generates is allowed for the author and counts as one launch', () => {
  const run = makeRun();
  // Exactly what brief.mjs puts in RUN/briefs/test-author.md: Windows separators, a quoted plugin path with a space.
  const { vars } = briefVars({ runDir: run.runDir, project: run.project, agent: 'qa-test-author', step: 'test-author', memory: { entries: [] }, pluginRoot });
  assert.match(vars.selfCheckCommand, /--self-check 1 --files client\/e2e\/checkout.spec.ts,client\/e2e\/cart.spec\.ts$/);
  expectDecision(run, sub(run, 'qa-test-author', 'Bash', { command: vars.selfCheckCommand }), 'allow');
  assert.deepEqual(counterLines(run), ['testLaunches']);
  run.cleanup();
});

test('guard: every denial is logged to events.jsonl for the dashboard and memory; allows are not', () => {
  const run = makeRun();
  expectDecision(run, sub(run, 'qa-test-author', 'Write', { file_path: path.join(run.worktree, 'client/e2e/checkout.spec.ts'), content: 'x' }), 'deny', 'H4');
  expectDecision(run, main(run, 'Bash', { command: 'ls client/e2e' }), 'allow');
  const logged = events(run);
  assert.equal(logged.length, 1);
  assert.deepEqual({ kind: logged[0].kind, rule: logged[0].rule, tool: logged[0].tool, agent: logged[0].agent },
    { kind: 'deny', rule: 'H4', tool: 'Write', agent: 'qa-orchestrator:qa-test-author' });
  run.cleanup();
});

test('recorder: SubagentStop appends the agent\'s time, tool uses and tokens; never blocks; dormant outside a run', () => {
  const run = makeRun();
  const transcript = path.join(run.root, 'session', 'subagents', 'agent-a1.jsonl');
  mkdirSync(path.dirname(transcript), { recursive: true });
  const msg = (id, t, usage, content = []) => JSON.stringify({ timestamp: t, message: { id, role: 'assistant', model: 'claude-sonnet-5', usage, content } });
  writeFileSync(transcript, [
    JSON.stringify({ timestamp: '2026-09-26T10:00:00.000Z', type: 'user', message: { role: 'user', content: 'Read your brief at …' } }),
    // One API message split over two lines repeats its usage: counted once.
    msg('m1', '2026-09-26T10:00:05.000Z', { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 }, [{ type: 'tool_use', id: 't1' }]),
    msg('m1', '2026-09-26T10:00:06.000Z', { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 }, [{ type: 'tool_use', id: 't2' }]),
    msg('m2', '2026-09-26T10:01:30.000Z', { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 40 }),
  ].join('\n'));
  writeFileSync(transcript.replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'qa-orchestrator:qa-triage', requestShape: 'background' }));
  const recorder = path.join(pluginRoot, 'hooks', 'record.mjs');
  const stop = (payload) => spawnSync(process.execPath, [recorder], {
    input: JSON.stringify({ session_id: SESSION, cwd: run.project, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_transcript_path: transcript, ...payload }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: run.project }, encoding: 'utf8',
  });
  const r = stop({});
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'the recorder never prints a decision');
  const [e] = events(run);
  assert.equal(e.agent, 'qa-triage');
  assert.equal(e.requestShape, 'background');
  assert.equal(e.durationMs, 90000);
  assert.equal(e.toolUses, 2);
  assert.deepEqual(e.tokens, { input: 3, cacheWrite: 100, cacheRead: 500, output: 50 });
  assert.equal(e.messages, 2);

  // Not a plugin agent, another session, or garbage input: nothing recorded, still exit 0.
  writeFileSync(transcript.replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'Explore' }));
  assert.equal(stop({}).status, 0);
  assert.equal(stop({ session_id: 'someone-else', agent_type: 'qa-orchestrator:qa-intake' }).status, 0);
  assert.equal(spawnSync(process.execPath, [recorder], { input: 'not json', encoding: 'utf8' }).status, 0);
  assert.equal(events(run).length, 1);
  assert.equal(existsSync(path.join(run.runDir, 'outputs')), false, 'no step in the prompt: no handback saved');
  run.cleanup();
});

test('recorder: saves the handback by step (SubagentHandback, else the fenced JSON, else the last message); H10 protects it', () => {
  const run = makeRun();
  const transcript = path.join(run.root, 'session', 'subagents', 'agent-a2.jsonl');
  mkdirSync(path.dirname(transcript), { recursive: true });
  writeFileSync(transcript.replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'qa-orchestrator:qa-critic' }));
  const prompt = (step) => JSON.stringify({ timestamp: '2026-09-29T18:40:00.000Z', type: 'user', message: { role: 'user', content: `Read your brief at "${run.runDir}/briefs/${step}.md" and follow it. It is your complete task for step ${step} of this QA run.` } });
  const said = (t, content) => JSON.stringify({ timestamp: t, message: { id: t, role: 'assistant', content } });
  const json = '```json\n{"verdict":"approve","gaps":[]}\n```';
  const stop = (lastMessage) => spawnSync(process.execPath, [path.join(pluginRoot, 'hooks', 'record.mjs')], {
    input: JSON.stringify({ session_id: SESSION, cwd: run.project, hook_event_name: 'SubagentStop', agent_id: 'a2', agent_transcript_path: transcript, last_assistant_message: lastMessage }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: run.project }, encoding: 'utf8',
  });
  const saved = (step) => readFileSync(path.join(run.runDir, 'outputs', `${step}.md`), 'utf8');

  // Live shape: the JSON goes through SubagentHandback, then a short summary is the last message.
  writeFileSync(transcript, [prompt('critic-2'), said('2026-09-29T18:41:00.000Z', [{ type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: { message: json } }]),
    said('2026-09-29T18:41:05.000Z', [{ type: 'text', text: 'I sent the report.' }])].join('\n'));
  assert.equal(stop('I sent the report.').status, 0);
  assert.equal(saved('critic-2'), `${json}\n`);
  assert.deepEqual([events(run).at(-1).step, events(run).at(-1).output], ['critic-2', 'outputs/critic-2.md']);

  // Earlier shape: the fenced JSON is a text message, followed by a sign-off.
  writeFileSync(transcript, [prompt('critic-3'), said('2026-09-29T18:42:00.000Z', [{ type: 'text', text: `Here it is.\n${json}` }]),
    said('2026-09-29T18:42:05.000Z', [{ type: 'text', text: 'Done.' }])].join('\n'));
  stop('Done.');
  assert.equal(saved('critic-3'), `Here it is.\n${json}\n`);

  // Fenced JSON written as text, then a SubagentHandback with only a summary: the JSON wins.
  writeFileSync(transcript, [prompt('critic-5'), said('2026-09-29T18:44:00.000Z', [{ type: 'text', text: json }]),
    said('2026-09-29T18:44:05.000Z', [{ type: 'tool_use', id: 'h2', name: 'SubagentHandback', input: { message: 'Report delivered.' } }])].join('\n'));
  stop('Report delivered.');
  assert.equal(saved('critic-5'), `${json}\n`);

  // No JSON anywhere (turn limit): the last message is saved, so validate reports what is missing.
  writeFileSync(transcript, [prompt('critic-4'), said('2026-09-29T18:43:00.000Z', [{ type: 'text', text: 'Still checking AC3…' }])].join('\n'));
  stop('Still checking AC3…');
  assert.equal(saved('critic-4'), 'Still checking AC3…\n');

  const out = path.join(run.runDir, 'outputs', 'critic-2.md');
  expectDecision(run, main(run, 'Write', { file_path: out, content: json }), 'deny', 'H10');
  expectDecision(run, main(run, 'Edit', { file_path: out, old_string: 'approve', new_string: 'revise' }), 'deny', 'H10');
  expectDecision(run, main(run, 'Bash', { command: `echo x > "${out}"` }), 'deny', 'H10');
  expectDecision(run, main(run, 'Bash', { command: 'git log --oneline -- client/e2e/outputs/report.spec.ts' }), 'allow');
  expectDecision(run, main(run, 'Bash', { command: `node "${pluginRoot}/scripts/validate.mjs" qa-critic "${run.runDir}/critic-2.json" --run "${run.runDir}" --project "${run.project}" --step critic-2` }), 'allow');
  run.cleanup();
});
