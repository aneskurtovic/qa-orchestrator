# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code **plugin** (`qa-orchestrator`, marketplace `aneskurtovic`), not an application. It runs a
multi-agent QA workflow for one Jira ticket inside a *target* repo. Nothing here is
project-specific; a target opts in with a committed `.qa/config.json` (a filled-in example is
`config/examples/full-example.json`).

**Docs.** Only `README.md` and this file sit at the root; every other doc is in `docs/` (the map
is in README "Docs"). Keep the set small: a new doc needs a purpose no existing one covers.
- `docs/design.md`: how it works and why. Read only the section you need: §4 agents, §5 flow, §6
  guard rules, §8 run folder.
- `docs/setup.md`: verified facts (versions, hook payloads, Jira, memory), each with its date.
- `docs/dry-run.md`: checking a target's setup without Jira or GitHub writes.
- `docs/demo/`: an intro deck and the full workflow map (`workflow.html`).

**Every doc states only what is true now**, checked against the code, config or git. A past
observation is written with its date ("verified 2026-09-24: …"). There is no changelog; git
history is the record.

**Editing this repo doesn't change the plugin you're running.** Where the running copy comes from
depends on how it was installed:
- **Local-directory marketplace (developing the plugin):** the plugin loads in place from the directory in
  `~/.claude/plugins/known_marketplaces.json` (`aneskurtovic` → `installLocation`), usually the
  main checkout, not a worktree. A change goes live only after it's merged to `main` and that
  checkout pulls. The next new session picks it up, with no reinstall. (The install
  also leaves a copy in `~/.claude/plugins/cache/`; that copy isn't what loads, see `docs/setup.md`.)
- **GitHub marketplace:** the plugin is copied into `~/.claude/plugins/cache/`, and a
  new copy arrives only when `version` changes (`claude plugin marketplace update aneskurtovic`).

The plugin is installed **per project** (`--scope project`, or `--scope local` to keep it out of
git), never at user scope. See README "Install".

## Commands

```bash
npm test                                                        # all tests (node --test, no deps)
node --test hooks/test/guard.test.mjs                           # one file
node --test --test-name-pattern="restore-spec" "scripts/test/*.test.mjs"   # one test by name
claude plugin validate .                                        # plugin manifest/agents/skills/hooks
node scripts/check-config.mjs --project <target repo>           # check a target's .qa/config.json
QA_HOOK_LOG=1 claude …  &&  node hooks/test/summarize-log.mjs   # record payloads, summarize after the session ends
```

- There is no build or lint step and **no npm dependencies**. Keep it that way: scripts and hooks use
  only Node built-ins.
- Node ≥ 22 (`engines` in `package.json`). CI runs the suite on Node 22 and 24 on `windows-latest`.
  If you change the floor, change the CI matrix too. (`npm test` relies on `node --test` expanding
  quoted globs, which Node 20 can't do.)
- The tests create real git repos in temp dirs, so `git config user.email/user.name` must be set.
- CI runs on Windows on purpose: the plugin runs on Windows/Git Bash, and many tests cover path
  handling.

## Architecture

Three layers, each with a different trust level:

1. **Orchestrator playbook**: `skills/qa-run/SKILL.md`, executed by the main session as
   `/qa-orchestrator:qa-run <KEY>`. It's the only layer that talks to Jira (Atlassian MCP) and asks
   the human at gates (G0–G3, DELIVER). It sets `disable-model-invocation: true`, which means
   Claude can't start the skill on its own. Only the typed `/qa-orchestrator:qa-run` command can.
   That matters because the skill moves Jira tickets.
   `skills/setup/SKILL.md` (`/qa-orchestrator:setup`) writes a project's `.qa/config.json`. It only
   reads Jira and moves no ticket, so Claude may start it on its own when asked to set the plugin up.
   It commits, pushes and opens a PR only when the file can't land in the user's checkout (a
   background job or a worktree) and the user picks that option.
2. **Seven leaf agents** in `agents/`. Each has a fixed model, which the dispatch must not override
   (the guard denies it). Each is dispatched with a prompt pointing at a **brief**
   (`RUN/briefs/<step>.md`) that `scripts/brief.mjs` fills from `templates/briefs/<agent>.md`
   (`{{var}}` placeholders). An agent returns one fenced JSON block, which `scripts/validate.mjs`
   checks against `schemas/<agent>.schema.json` plus semantic checks: AC ids exist and files are
   under `qa.testDir`.
3. **Deterministic scripts** in `scripts/` do every write that matters: git worktree/branch, state,
   plan merge, deletes, test runs, delivery (commit/push/PR), metrics, memory.

The **guard** (`hooks/guard.mjs`, a PreToolUse hook) enforces rules H1–H11 against the model:
- **It applies only to a QA run, through two layers, and both are needed.** (1) Install scope: the
  plugin is installed at project/local scope, so its hooks load only in the target repo. (2) Run
  ownership: inside that repo, every session still loads the hook, including normal dev work.
  `findOwnedRun()` (`hooks/lib/context.mjs`) therefore must stay **fail-open**. It allows the call
  unless the session provably owns an active run (`.qa-runs/active.json` has this `session_id`),
  and it also allows on any error while checking. After ownership is proven, errors **fail
  closed** (exit 2). That includes a missing `.qa/config.json` while the run is open, so moving it
  away can't switch the guard off (a released run goes dormant instead).
- `decide()` in `hooks/lib/policy.mjs` is a pure function of the hook input and the run context.
  Shell rules live in `hooks/lib/shell.mjs`: deny rules scan the whole command text, and subagent
  allowlists must match the whole command.
- `hooks/record.mjs` (SubagentStop) appends agent telemetry to `RUN/events.jsonl` and saves the
  agent's handback to `RUN/outputs/<step>.md` for `validate.mjs --step`. It never blocks.
- Tests drive the real hook by spawning `guard.mjs` with a JSON payload on stdin
  (`callGuard`/`expectDecision` in `hooks/test/guard.test.mjs`).

### Script conventions (`scripts/lib/common.mjs`)
- The entry point is `main(fn)`. It prints the result as JSON and exits 1 on failure, 2 on
  `UsageError`. A script signals that a breaker or check fired by exiting 3 itself (`preflight.mjs`,
  `test-diff.mjs`, `check-config.mjs`, `validate.mjs --step` with no saved output); the JSON says which. The SKILL playbooks branch on these
  codes.
- `loadConfig` returns `.qa/config.json` with the defaults from `scripts/lib/config.mjs` filled in;
  the guard's `loadContext` applies the same `withDefaults`.
- `parseArgs` turns `--kebab-case` flags into camelCase keys.
- `isMain(import.meta.url)` guards the CLI, so tests import the exported functions directly.
- External commands go through an injected `runner` (`realRunner` in production, fakes in tests).
  Never call `spawnSync` directly in a script.
- Writes use `writeJsonAtomic`/`writeTextAtomic` (temp file + rename).
- `scripts/lib/schema.mjs` is a **subset** JSON Schema validator: type, enum, required, properties,
  `additionalProperties: false`, items, minItems, minLength, pattern, minimum, maximum. Any other
  keyword in `schemas/` is silently ignored.

### Run state (lives in the target repo, gitignored: `.qa-runs/`, `.qa-worktrees/`)
- The playbook changes `RUN/state.json` only through `state.mjs`, and every `state.mjs` write calls
  `refreshViews` (`scripts/lib/views.mjs`), which regenerates `progress.md`, `dashboard.html` and
  `metrics.json`. `preflight.mjs` and `deliver-tests.mjs` also write their own fields there,
  without refreshing the views.
  H10 protects these files, plus `plan.json`, `suite-baseline.json`, `counters.log`,
  `events.jsonl`, `active.json`, `.lock`, `history.jsonl`, memory and the `outputs/` folder (the
  lists are in `hooks/lib/context.mjs`).
- G2 approval binds to the `planHash` of `plan.json` on disk at that moment. Any later plan edit
  invalidates it.
- `counters.log` is append-only (one JSON line per event), so parallel hook invocations can't lose
  counts. The H5 (plan revisions) and H7 (test launches) caps are computed from it.

### Paths are Windows-first
The same file shows up as `C:\a`, `C:/a` and `/c/a` (Git Bash). Every path comparison in the guard
goes through `norm()`/`isUnder()` in `hooks/lib/paths.mjs`, which also lowercases drive-letter
paths. Playwright file filters must be forward-slash: backslash filters select 0 tests.

## Changes that span files

- **A guard rule (H1–H11):** `hooks/lib/policy.mjs` / `shell.mjs`, a test in
  `hooks/test/guard.test.mjs`, the table in `docs/design.md` §6, the summary in README.md, and any mention in
  `skills/qa-run/SKILL.md` (the playbook tells the orchestrator how to react to specific denials).
- **An agent's output contract:** `agents/<name>.md` (instructions),
  `schemas/<name>.schema.json`, `semanticErrors` in `scripts/validate.mjs`, the consumers of that JSON
  (`merge-plan.mjs`, `views.mjs` digests, `memory.mjs`, the next agent's brief), and test fixtures.
- **A new agent:** everything above, plus `templates/briefs/<name>.md`, brief variables in
  `brief.mjs`, its shell allowlist (H6) and read scope, and the model list in SKILL.md.
- **A config key:** `scripts/lib/config.mjs` (`KNOWN`, plus its default in `withDefaults` or its
  entry in the `required` list), `config/examples/full-example.json` (and
  `config/qa.config.example.json` if it's required), the tables in `skills/setup/SKILL.md` steps
  2–3, and the config table in `docs/design.md` §3. A new default belongs in `withDefaults`, not
  at the use site: that's how the scripts and the guard see the same value.
- **A playbook step or gate:** `skills/qa-run/SKILL.md`, the flow and gate table in
  `docs/design.md` §5, and the step comment at the top of the script it calls.
- **A release:** bump the version in both `package.json` and `.claude-plugin/plugin.json`. Adopters on
  the GitHub marketplace get the change only after a version bump.
- **Node floor:** `engines` in `package.json`, the CI matrix in `.github/workflows/test.yml`, and the
  README requirements line.
- **Install scope or instructions:** README "Install", `docs/setup.md`, `docs/design.md` §3 / §6,
  the `hooks/hooks.json` description, the `hooks/guard.mjs` header comment, and this file.
- **Moving or renumbering a doc section:** grep for its path and `§` number. The script and hook
  header comments cite `docs/design.md` sections.
