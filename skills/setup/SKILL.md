---
name: setup
description: Set up the QA orchestrator in this repo, or check an existing setup. Finds the Playwright suite, the QA stack and the branches in the repo, looks up the Jira values, asks only what it can't find, and writes .qa/config.json. Use when the user wants to set up, configure or adopt the QA orchestrator in a project. Invoke as /qa-orchestrator:setup.
---
# setup

Creates or updates `.qa/config.json`, the one file a project needs to use the QA orchestrator. The
person may be new to this: say in plain words what you are doing and why, one step at a time.
Setup works best in a normal Claude Code session opened in the project's own checkout: the file then
lands there, uncommitted, for the user to review and commit.

Rules for the whole skill:
- **Read-only until step 5.** Then write only `.qa/config.json` and `.gitignore`. Don't change the
  app, its tests, its Playwright config or its compose file. Don't commit anything, except on a
  branch the user chose in "Where the file goes" (step 1).
- **Jira is read-only.** Never call `transitionJiraIssue`, `addOrEditJiraIssueComment`,
  `editJiraIssue`, `createJiraIssue`, `executeWrite` or `executeDestructive`.
- Every value you write comes from the repo, from Jira, or from the user. Never guess one silently:
  if you can't find it, ask.

Notation: `PROJECT` = the absolute path of the repo root (the current working directory).
`S` = `"${CLAUDE_PLUGIN_ROOT}/scripts"`. The defaults for every key you leave out are in
`${CLAUDE_PLUGIN_ROOT}/docs/design.md` §3.

## 1. Before you start

- Run `node S/preflight.mjs status --project PROJECT`. If `lock` is not null, a QA run is in
  progress, and its scripts re-read the config at every step. Stop and ask the user to finish the
  run first.
- If `PROJECT/.qa/config.json` exists, run `node S/check-config.mjs --project PROJECT`, show its
  problems and warnings, and keep that result: the report in step 6 compares against it. Then ask
  which path to take:
  - **Fix only:** fix the problems and warnings, nothing else. Skip step 2 and step 3's lookups, but
    do step 3's "Check the Jira values of an existing config", then steps 4–6 as written. Step 4
    still applies: show the change and get a yes before writing.
  - **Whole setup:** every step, starting from the existing values.

  Either way, keep every value the user doesn't want changed.

### Where the file goes

Find out before writing whether a write reaches the user's checkout. It doesn't if:
- `git rev-parse --path-format=absolute --git-dir --git-common-dir` prints two different paths
  (PROJECT is a linked worktree, not the checkout the user works in), or
- the environment variable `CLAUDE_JOB_DIR` is set (a background job, which may write only in a
  worktree), or
- an edit to PROJECT is refused later on. Stop there and ask this same question.

In any of these cases, say so before going on, and ask one `AskUserQuestion`:
- **Run setup in a normal session (Recommended):** stop here. Tell the user to open Claude Code in
  their checkout and run `/qa-orchestrator:setup` again.
- **This is my working copy, write here:** only when the reason is the linked worktree (the user
  works in it). Go on as if it were the checkout.
- **Put it on a branch and open a PR:** go on. The branch must start exactly at
  `origin/<git.integrationBranch>`, or the PR could revert newer changes there. A worktree made for
  a background job usually starts from the default branch instead. So before reading or writing
  `.qa/config.json` in it, run `git fetch origin <branch>` and `git rev-parse HEAD
  origin/<branch>`. If the two shas differ, the worktree has no commits of its own yet, and
  `git status --porcelain` prints nothing (a reset would throw away uncommitted changes), run
  `git reset --hard origin/<branch>` and check again. If there are changes, don't reset: stop and
  recommend a normal session instead. Never reset onto a local branch. Then read the
  config from this worktree, since `origin/<branch>` may have a newer one than the checkout.
  After `check-config` passes, commit only `.qa/config.json` and `.gitignore`
  (`chore(qa): set up .qa/config.json`, or `chore(qa): fix .qa/config.json` for fix only), push, and
  open a PR into the integration branch. A push can take minutes if the repo has a pre-push hook:
  tell the user and wait for it.

## 2. Find the values in the repo

Note where each value came from (file and line). You show it to the user in step 4.

| Key | How to find it |
|---|---|
| `qa.playwrightConfig` | `playwright.config.{ts,js,mjs,cjs}` outside `node_modules`. If there are several, ask which one runs the QA suite. If there are none, stop: the plugin maintains an existing Playwright suite and can't start one from nothing. |
| `qa.testDir` | the config's `testDir`, resolved from the config file's folder and written relative to the repo root. If it has none, use the config file's folder. |
| `qa.baseUrl` | the URL of the app in the QA stack (see `stack` below). The config's `use.baseURL` often shows it. |
| `qa.apiUrl` | the API's URL in the QA stack, only if the suite has API tests. |
| `qa.apiTestDir` | a folder of API tests under `testDir` (often `api/`). Leave it out if there is none. |
| `qa.installCommand` | from the lockfile at the repo root. `package-lock.json`: leave it out (the default is `npm ci`). `pnpm-lock.yaml`: `pnpm install --frozen-lockfile`. `yarn.lock`: `yarn install --immutable` for Yarn 2+ (`.yarnrc.yml` exists), `yarn install --frozen-lockfile` for Yarn 1. |
| `qa.conventionsDocs` | an existing guide for writing tests (a README in `testDir`, a testing section in `CONTRIBUTING.md`, a doc under `docs/`). Optional. The agents follow it when they write tests. |
| `git.integrationBranch` | the branch dev work is merged to before QA. Look at `git branch -r` for `stage`, `staging`, `develop` or `dev`; otherwise the default branch (`git symbolic-ref refs/remotes/origin/HEAD`). Always confirm it in step 4. |
| `git.protectedBranches` | only if the repo has long-lived branches besides `main`, `master` and the integration branch (those three are protected by default). |
| `stack.composeFile` | a Docker Compose file that starts the app for tests, e.g. `docker-compose.qa.yml` or `compose.test.yml`. |
| `stack.project` | a Compose project name for the QA stack: the repo folder name in lowercase, plus `-qa`. |
| `stack.health` | URLs that answer 200 once the stack is up: the app URL, plus the API's health endpoint if it has one (look for `/health`, `/healthz`, or a `healthcheck:` in the compose file). If you leave it out, the plugin waits for `qa.baseUrl`. |
| `stack.shaCheck` | only if the running app reports its build commit: a field in a JSON response (`"<url>#<field>"`) or a `<meta>` tag (`"<url>#meta:<name>"`). It proves the tests ran against the commit under test. If there is none, leave it out and tell the user that the run can't prove which build it tested. |
| `suites`, `routes` | leave them out at first: every run then runs the whole test folder. Mention that they can be added later, when the suite gets slow. |
| `qa.knownDrift`, `qa.driftProbeEvery` | leave them out. Known drift is added later, when runs show a spec failing outside its ticket (release suggests it). The probe that checks whether drift healed runs every 5th run by default; `0` turns it off. |

Check these requirements and report what isn't met. Don't fix them yourself: they are changes to
the project.
- `@playwright/test` resolves from the repo root: a dependency of the root `package.json`, or of a
  workspace whose packages install into the root `node_modules`. The plugin's runner looks for
  Playwright there, after running the install command at the repo root.
- The Playwright config reads `process.env.BASE_URL`, e.g.
  `baseURL: process.env.BASE_URL ?? 'http://localhost:3000'`. API tests read `process.env.API_URL`.
  The runner passes `qa.baseUrl` and `qa.apiUrl` that way. If the config ignores them, the tests
  run against whatever URL it has hardcoded.
- The compose file starts the app **next to** a developer's own stack: its own ports, no fixed
  `container_name`, a throwaway database volume with seeded test data. If there is no such file,
  say that the first run needs one and what it must do. The rest of the setup can still finish.

## 3. Find the Jira values

Use the Atlassian MCP. If its tools aren't available, stop and tell the user to add it:
`claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v2/mcp`, then
`/mcp` to log in, then run this skill again.

- `jira.cloudId`: `getAccessibleAtlassianResources`. If more than one site is listed, ask which.
- `jira.projectKey`: ask which Jira project the QA runs work on. Offer the project keys of
  recently updated issues (`searchJiraIssuesUsingJql` with `ORDER BY updated DESC`).
- `jira.statuses`: the exact names of three statuses in that project:
  - `ready`: dev is done and the ticket waits for QA;
  - `inQa`: QA is working on it;
  - `review`: QA is done and a person decides.

  Collect the status names from the project's issues and ask which is which. The names must match
  Jira exactly.
- `jira.allowedTransitionIds`: explain it to the user first. In Jira, a ticket moves from one
  status to the next through a *transition* (an arrow in the workflow), and each transition has an
  id. A QA run may use only two: the one into `inQa` (when it starts) and the one into `review`
  (when it hands over). The plugin's guard blocks every other transition, so the AI can never move
  a ticket to Done. To find the two ids:
  1. Find a ticket in the `ready` status and list its transitions with `executeRead`
     `{ name: "listJiraIssueTransitions", cloudId, inputs: { issueIdOrKey } }`. Take the `id` of
     the transition whose target status is `inQa`.
  2. Do the same with a ticket in the `inQa` status, for the transition into `review`.

  Jira only lists the transitions out of a ticket's *current* status. If no ticket is in the
  status you need, ask the user to move a test ticket there by hand, then list again.

### Check the Jira values of an existing config

`check-config` checks only the file. A status renamed in Jira, or a changed workflow, still passes
it and breaks the next run. So, when a config exists (on both paths of step 1), check it against
Jira, read-only:
- **Site and project:** `getAccessibleAtlassianResources` lists `jira.cloudId`, and a search in
  `jira.projectKey` works.
- **Statuses:** for each of `ready`, `inQa` and `review`, search
  `project = <KEY> AND status = "<name>"`. An error saying the value doesn't exist means that name
  is wrong. An empty result is fine. This proves only that the status exists on the site; the
  transition check below proves it is in this project's workflow.
- **Transitions:** on a ticket in `ready`, `listJiraIssueTransitions` must list one of
  `allowedTransitionIds` leading into `inQa`. On a ticket in `inQa`, another must lead into
  `review`. If no ticket is in that status, report the check as "not checked" and don't ask the
  user to move one.

Report every mismatch as a problem to fix (with the right value, if you found it) and include it
in step 4. On the fix-only path, missing Atlassian MCP tools don't stop the skill: report the Jira
check as "not checked" and say how to add the MCP.

## 4. Confirm with the user

Ask one `AskUserQuestion` (at most 4 questions) about what you couldn't settle yourself. On the
whole-setup path, always ask about the integration branch and which statuses are
`ready`/`inQa`/`review`, plus anything that had several candidates. On the fix-only path, ask only
what a fix needs a decision on. Put the value you found first, marked "(Recommended)".

Then show what you are about to write:
- For a new file: the complete file, with the source of each value.
- For an existing file (both paths): only what changes, one line per key, `key: before → after`
  (`(removed)` or `(new)` where it applies), each with its reason.

Also show the requirements from step 2 that aren't met. Then ask with `AskUserQuestion` whether to
write it: "Write it" or "Change something". Write nothing until the answer is "Write it".

## 5. Write and check

- Write `PROJECT/.qa/config.json`. Include only the keys whose value differs from its default.
- Add `.qa-runs/` and `.qa-worktrees/` to `PROJECT/.gitignore` if they're missing.
- Run `node S/check-config.mjs --project PROJECT`. Exit 3 means it found problems: fix each one
  (ask the user where you need to) and run it again until it prints `ok: true`. A problem that
  only a change to the project can fix (a missing compose file, a requirement from step 2) isn't
  setup's to fix: stop the loop there, and report the setup as partial, naming what is missing.
- On the branch path from step 1, commit, push and open the PR now.

## 6. Report

The user reads this report to learn what setup did, so write all of it, in this order:

1. **The outcome, in one sentence.** Say what happened to the config and the final check, e.g.
   "Created `.qa/config.json` for Jira project KAN: `check-config` ok, 0 problems, 1 warning." or
   "Fixed `.qa/config.json`: removed 5 unused keys; `check-config` ok, 0 warnings (was 7)." or
   "Created `.qa/config.json`, partial: `check-config` fails until the project has a QA compose
   file." Put
   where the file is in a later part, not here.
2. **What changed.**
   - For a new file: the complete file.
   - For an existing file: the `key: before → after` lines from step 4, as written. Put the
     full file below them if it is short.
3. **Checks:**
   - `check-config` before → after, and any warnings that remain.
   - The Jira check: ok, the mismatches fixed, or "not checked" and why.
   - The step 2 requirements that aren't met. The fix-only path doesn't check them, so say that
     only `check-config`'s file checks ran.
4. **Where it is:**
   - In the checkout: the path, uncommitted.
   - On the branch path: the branch, the commit, the PR link, and the one command that brings it in
     if there is no PR.
5. **What you do next:**
   - In the checkout: commit `.qa/config.json` and `.gitignore`. The user or the team commits them;
     you don't.
   - The plugin must be installed for this repo:
     `claude plugin install qa-orchestrator@aneskurtovic --scope project`. Check
     `.claude/settings.json` and `.claude/settings.local.json` for `enabledPlugins` first; it may
     already be there.
   - Prove the setup without touching Jira or GitHub: the dry run in
     `${CLAUDE_PLUGIN_ROOT}/docs/dry-run.md`.
   - Then the first real run: `/qa-orchestrator:qa-run <TICKET-KEY>`.
   - Any step 2 requirement that isn't met yet.

If you end with a one-line summary, it repeats part 1: the config outcome first, then where the
file is.
