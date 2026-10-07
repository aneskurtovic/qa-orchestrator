// Command-text analysis for Bash and PowerShell tool calls.
//
// Deny rules scan the WHOLE command text, not just its first word, so a guarded
// verb is caught inside `bash -c "…"`, `pwsh -Command …`, `eval`, `node -e` or
// after `&&`/`;`/`|`. A false positive (e.g. an echo that mentions "git push")
// only costs a denied call; a false negative would break a guarantee. Each rule
// also runs on a copy with quotes, backticks and backslash escapes removed,
// because the shell drops them: `git "push"` and `git pu\sh` are both a push.
//
// The subagent allowlist is the opposite: the whole command must match one
// pattern and may contain no shell metacharacters, so `git log; rm -rf x` fails.
import { norm } from './paths.mjs';

const GIT = String.raw`\bgit(?:\.exe)?(?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+`;
const GH = String.raw`\bgh(?:\.exe)?\s+`;
const gitVerb = (verbs) => new RegExp(`${GIT}(?:${verbs})\\b`, 'i');

export const DENY_RULES = [
  { id: 'H1', re: new RegExp(`${GH}pr\\s+merge\\b`, 'i'),
    reason: 'Merging is a human decision (G4). A QA run never merges pull requests.' },
  { id: 'H1', re: new RegExp(`${GH}pr\\s+review\\b[^\\n]*(?:--approve|\\s-a\\b)`, 'i'),
    reason: 'Approving a pull request is a human decision (G4).' },
  { id: 'H1', re: new RegExp(`${GH}api\\b[^\\n]*/(?:merge|reviews)\\b`, 'i'),
    reason: 'Merging or reviewing through the GitHub API is a human decision (G4).' },
  { id: 'H1', re: gitVerb('merge|rebase'),
    reason: 'git merge/rebase is not part of a QA run.' },
  { id: 'H2', re: gitVerb('push'),
    reason: "Pushing happens only through deliver-tests.mjs, which pushes the run's qa/<KEY> branch and nothing else." },
  { id: 'H9', re: gitVerb('add|commit|rm|mv|reset|restore|checkout|switch|stash|cherry-pick|revert|tag'),
    reason: 'Git writes during a QA run go through the plugin scripts (preflight.mjs, apply-deletes.mjs, deliver-tests.mjs).' },
  { id: 'H9', re: new RegExp(`${GH}pr\\s+(?:create|edit|close|reopen|comment|ready)\\b`, 'i'),
    reason: 'The QA PR is created by deliver-tests.mjs; pull-request writes are not made directly during a QA run.' },
  // Also .qa/config.json and the .qa/ and .qa-runs/ folders themselves (the last segment of a
  // path, so `.qa-runs/PROJ-5/<run>` is fine): moving or deleting them ends run ownership, and
  // with it the guard.
  { id: 'H10', re: /(?:counters\.log|active\.json|plan\.json|state\.json|suite-baseline\.json|events\.jsonl|metrics\.json|history\.jsonl|memory\.json|progress\.md|dashboard\.html|\.qa-runs[\\/]\.lock|\.qa-runs[\\/][^\s"';&|]*[\\/]outputs[\\/]|\.qa-runs[\\/]MEMORY\.md|\.qa[\\/]config\.json|(?:^|[\s"'=\\/])\.qa(?:-runs)?[\\/]?\*?(?=["'\s;&|)]|$))/i,
    reason: 'Run control files (plan, state, baseline, counters, active run, lock), run data (events, metrics, progress, dashboard, history, memory, agent outputs in outputs/), .qa/config.json and the .qa/ and .qa-runs/ folders are changed only by the plugin scripts and hooks. Use the Read tool to inspect them. A plugin script call is exempt only on its own: one command, with no chaining, pipes, redirects or command substitution.',
    unlessPluginScript: true },
];

// Invocations of the plugin's own scripts, e.g. node "C:/…/qa-orchestrator/scripts/state.mjs" …
const PLUGIN_SCRIPT = /^\s*node(?:\.exe)?\s+("[^"]*[\\/]scripts[\\/][\w-]+\.mjs"|'[^']*[\\/]scripts[\\/][\w-]+\.mjs'|\S*[\\/]scripts[\\/][\w-]+\.mjs)(\s|$)/i;

// The script path of a plugin-script invocation (normalized), or null.
export function pluginScriptPath(command, pluginRoot) {
  const m = PLUGIN_SCRIPT.exec(command);
  if (!m) return null;
  const script = norm(m[1].replace(/^["']|["']$/g, ''));
  if (pluginRoot && !script.startsWith(`${norm(pluginRoot)}/scripts/`)) return null;
  return script;
}

export function isPluginScript(command, pluginRoot) {
  return pluginScriptPath(command, pluginRoot) !== null;
}

// The command without its quoted text, keeping what the shell still runs inside double quotes
// (`$(` and backticks; a plain $VAR only expands). A backslash escapes the next character, so
// `\'` doesn't open a quote. A trailing 2>&1 is harmless and common, so it's dropped.
function unquoted(command) {
  let out = '';
  let quote = null;
  const s = String(command);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (quote === '"') {
      if (ch === '\\') i += 1;
      else if (ch === '"') quote = null;
      else if (ch === '`' || (ch === '$' && s[i + 1] === '(')) out += ch === '$' ? '$(' : ch;
      continue;
    }
    if (ch === '\\') { i += 1; out += '_'; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    out += ch;
  }
  return out.replace(/\s2>&1\s*$/, '');
}

// A plugin script call on its own. Nothing chained, piped, redirected or substituted, so the
// H10 exemption can't carry over to a second command (`node …/state.mjs show; echo > state.json`).
function isLonePluginScript(command, pluginRoot) {
  return isPluginScript(command, pluginRoot) && !/[;&|`<>()\r\n]|\$\(/.test(unquoted(command));
}

export function firstDenial(command, { pluginRoot } = {}) {
  const pluginScript = isLonePluginScript(command, pluginRoot);
  const bare = String(command).replace(/["'`]/g, '').replace(/\\(?=\w)/g, '');
  for (const rule of DENY_RULES) {
    if (rule.unlessPluginScript && pluginScript) continue;
    if (rule.re.test(command) || rule.re.test(bare)) return rule;
  }
  return null;
}

// A Playwright launch, counted by H7: an invocation of the plugin runner, or `playwright test` as a
// command (also inside a wrapper like bash -c "…" or node -e "…"). Merely mentioning the runner, as
// in `grep … run-playwright.mjs`, is not a launch (found live: reads consumed the budget).
export function isTestLaunch(command, pluginRoot) {
  const script = pluginScriptPath(command, pluginRoot);
  if (script) return script.endsWith('/scripts/run-playwright.mjs');
  const cmd = String(command).trim();
  // node "$S/run-playwright.mjs" names the runner through a variable, so pluginScriptPath can't
  // resolve it (found live: the real test run went uncounted). Running node on it is a launch.
  return /(?:^|[;&|"'(`]\s*)node(?:\.exe)?\s+["']?[^\s"']*run-playwright\.mjs\b/i.test(cmd)
    || /(?:^|[;&|"'(`]\s*)(?:npx(?:\.cmd)?\s+)?playwright(?:\.cmd)?\s+test\b/i.test(cmd);
}

const META = /[;&|$`<>()\r\n]/;
const READ_ONLY = [
  /^gh pr (?:view|diff|list)(?: [^]*)?$/i,
  /^git (?:diff|log|show|status|rev-parse|ls-files)(?: [^]*)?$/i,
];
const NO_WRITE_FLAGS = /\s--output(?:=|\s)|\s--web\b|\s--no-index\b|\s--ext-diff\b|\s--textconv\b/i;
// git diff compares any two files on disk, with or without --no-index, once a path is outside
// the repo (`git diff /dev/null C:/x/.env`). So read-only git names repo paths only: nothing
// absolute, no ~ and no .. segment. `rev:path` and `a..b` ranges are unaffected.
const OUTSIDE_PATH = /^(?:[\\/~]|[a-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/i;
const namesOutsidePath = (cmd) => /^git\s/i.test(cmd) && cmd.split(/\s+/).slice(1)
  .map((t) => t.replace(/["']/g, '').replace(/^-[^=]*=/, ''))
  .some((t) => OUTSIDE_PATH.test(t));
// Triage checks which earlier commit broke a pre-existing spec. It runs from the main checkout,
// which shares its history with the run worktree: git log|show|blame <testedSha> -- <file>.
// blame --contents would read any file on disk, so it is refused.
const TRIAGE_GIT = [/^git (?:log|show|blame)(?: [^]*)?$/i];
const TRIAGE_FORBID = /\s--output(?:=|\s)|\s--contents\b|\s--no-index\b|\s--ext-diff\b|\s--textconv\b/i;
// The author runs tests only through the runner's self-check mode, which sets
// the worktree, URLs and output paths itself (a bare `npx playwright test`
// would run from the main checkout against the config's default URL).
const AUTHOR_FLAGS = /^(?:\s+--(?:run|project|self-check|files)\s+(?:"[^"]*"|\S+))+$/;

export const SUBAGENT_BASH = {
  'qa-intake': { patterns: READ_ONLY, forbid: NO_WRITE_FLAGS, summary: 'gh pr view|diff|list, git diff|log|show|status|rev-parse|ls-files (repo paths only; no --no-index, --output, --ext-diff or --textconv)' },
  'qa-change-analyst': { patterns: READ_ONLY, forbid: NO_WRITE_FLAGS, summary: 'gh pr view|diff|list, git diff|log|show|status|rev-parse|ls-files (repo paths only; no --no-index, --output, --ext-diff or --textconv)' },
  'qa-triage': { patterns: TRIAGE_GIT, forbid: TRIAGE_FORBID, summary: 'git log|show|blame (read-only; repo paths only; no --contents, --output, --ext-diff or --textconv)' },
  'qa-test-author': { runnerSelfCheck: true, summary: 'node "<plugin>/scripts/run-playwright.mjs" --run <runDir> --project <projectDir> --self-check <n> --files <a,b>' },
};

function authorCommandOk(cmd, pluginRoot) {
  const script = pluginScriptPath(cmd, pluginRoot);
  if (!script || !script.endsWith('/scripts/run-playwright.mjs')) return false;
  const rest = cmd.replace(PLUGIN_SCRIPT, ' ');
  return /\s--self-check\s/.test(` ${rest} `) && /\s--files\s/.test(` ${rest} `) && AUTHOR_FLAGS.test(` ${rest.trim()}`);
}

export function subagentCommandAllowed(agentName, command, { pluginRoot } = {}) {
  const rule = SUBAGENT_BASH[agentName];
  if (!rule) return { ok: false, summary: 'no shell commands' };
  const cmd = String(command).trim();
  // Quoted text is an argument, so `git log -S"setTimeout("` is fine (found live: triage lost a
  // cause commit to that denial). Inside double quotes bash still expands $ and backticks.
  if (META.test(unquoted(cmd)) || /"[^"]*[$`]/.test(cmd)) return { ok: false, summary: rule.summary };
  const ok = rule.runnerSelfCheck
    ? authorCommandOk(cmd, pluginRoot)
    // Also without quotes: `git log "--output=x"` is still --output to git.
    : !rule.forbid.test(` ${cmd}`) && !rule.forbid.test(` ${cmd.replace(/["']/g, '')}`) && !namesOutsidePath(cmd) && rule.patterns.some((re) => re.test(cmd));
  return { ok, summary: rule.summary };
}
