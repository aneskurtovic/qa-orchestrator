# Design: how qa-orchestrator works and why

The deep reference. Start with [README.md](../README.md); come here for one section at a time.
Everything below describes what the plugin does today (version 0.3.0). Dated results are marked
with their date.

## 1. What it does

One Jira ticket, start to finish, run from the QA engineer's own Claude Code session:

1. A developer's change is merged to the integration branch (e.g. `stage`) and the ticket reaches
   **Ready for QA**.
2. Agents decide which of the QA team's existing Playwright tests (UI and API) must be **updated,
   added or deleted**, and a second agent reads the code change to **add tests the ticket missed**.
3. A deterministic script merges that into a **test plan**. A critic agent reviews it, and a
   **person approves it**.
4. An agent writes the approved test changes. **Playwright runs the suite**, and an agent
   classifies every failure.
5. An agent writes the QA report and recommends a verdict. The plugin pushes the test changes as a
   **QA pull request** into the integration branch and comments on Jira.
6. **A person** merges the QA PR and sets QA Passed or QA Failed. The plugin can't do either.

The principle: **AI recommends, Playwright executes, humans approve.** The QA suite is the QA
team's own Playwright directory; developer unit and integration tests are never touched.

## 2. How it uses Claude Code

The orchestrator is the **main session** following a skill playbook (`skills/qa-run/SKILL.md`).
Only the main session can stop and ask a person (`AskUserQuestion`), so neither a workflow script
nor an external orchestrator is used.

| Pattern | Claude Code primitive |
|---|---|
| Orchestrator | the main session following the `qa-run` skill |
| Specialised agents | 7 plugin subagents, each with its own `tools` list and fixed `model` |
| Parallel fan-out / fan-in | suite-impact ∥ change-analyst as two `Agent` calls in one message; `merge-plan.mjs` merges them |
| Router | a deterministic rule: `changeType`, the analyst's suggested suites and critical-area flag → which existing suites run |
| Critic with bounded reflection | `qa-critic` rounds, counted by the guard hook (H5) |
| Circuit breakers | preflight health and SHA checks, guard denials, round and test-launch caps |
| Human in the loop | `AskUserQuestion` gates G0–G3 and DELIVER (pre-approvable at G2 for a clean pass); G4 (merge + verdict) happens in GitHub and Jira |
| Shared structured state | the run folder `.qa-runs/<KEY>/<runId>/`, schema-validated JSON |
| Evidence-based decisions | Playwright JSON/HTML reports and traces → triage → feedback |
| Tool permissions | agent `tools:` lists plus a `PreToolUse` hook that reads `agent_type` |
| Deterministic vs AI | runner, plan merge, diff checks and delivery are scripts; judgment is agents |
| Isolation | a git worktree per run and a separate Docker Compose project for the QA stack |

## 3. Where things live

| Location | Contents |
|---|---|
| **This repo** (generic; nothing project-specific) | agents, skills, hooks, scripts, schemas, brief templates, `config/qa.config.example.json`, `config/examples/full-example.json` (a filled-in config with optional keys) |
| **Claude Code user scope** (`~/.claude/`) | the `aneskurtovic` marketplace and the Atlassian MCP server |
| **Target repo, committed** | `.qa/config.json` (the adapter) and, for a project-scope install, `enabledPlugins` in `.claude/settings.json` (a local-scope install puts it in the gitignored `.claude/settings.local.json`) |
| **Target repo, local only** (gitignored) | `.qa-runs/` (run folders, history, memory) and `.qa-worktrees/` (one worktree per run) |

A target repo supports QA runs with:
- A QA Docker Compose file (e.g. `docker-compose.qa.yml`): a stack that runs next to the
  developer's own stack (its own ports, no fixed container names, a throwaway volume, seeded test
  data).
- Optionally, a build SHA reported by the app (e.g. the API's `/health` and a
  `<meta name="app-sha">` in the web client), so preflight can prove the running app is the tested
  commit (`stack.shaCheck`).
- Anything the suite needs only under test, such as a higher API rate limit, set in the QA stack.
- A committed `.qa/config.json`.

The integration branch (`git.integrationBranch`, e.g. `develop` or `stage`) is where dev PRs merge
and where the QA PR targets; production branches go in `protectedBranches`.

### `.qa/config.json`

`/qa-orchestrator:setup` (`skills/setup/SKILL.md`) writes it. Claude finds most values in the repo
and in Jira, asks the user for the rest, and runs `scripts/check-config.mjs`, which reports missing
required keys, leftover `<…>` placeholders, files that don't exist and keys the plugin doesn't
read. `preflight.mjs start` refuses to start a run while a required key is missing.

`config/qa.config.example.json` holds only the required keys, each a `<…>` placeholder to replace;
`config/examples/full-example.json` is a filled-in one with optional keys. Every other key has a default
in `scripts/lib/config.mjs`, and the scripts and the guard apply the same defaults.

| Key | Required | Default | Read by |
|---|---|---|---|
| `jira.projectKey`, `jira.cloudId` | yes | | the skills (JQL search, every Jira call) |
| `jira.statuses.ready`, `.inQa`, `.review` | yes | | the skills: the ticket must be in `ready`; the run moves it to `inQa`, then `review` |
| `jira.allowedTransitionIds` | yes | | guard H3: the only transitions a run may perform (→ `inQa`, → `review`) |
| `jira.mcpToolPrefix` | | `mcp__atlassian__` | guard H3 |
| `git.integrationBranch` | yes | | preflight, deliver-tests |
| `git.devBranchKeyPattern` | | `(^\|/){KEY}(-\|$)`: the key starts the branch name or follows a `/` | preflight (finds the ticket's merged dev PRs) |
| `git.protectedBranches` | | `main`, `master`; the integration branch is always added | deliver-tests |
| `stack.composeFile`, `stack.project` | yes | | preflight |
| `stack.health` | | `[qa.baseUrl]` | preflight |
| `stack.healthTimeoutSec` | | 180 | preflight |
| `stack.shaCheck` | | none, so no proof of the build under test | preflight |
| `qa.testDir`, `qa.playwrightConfig`, `qa.baseUrl` | yes | | guard H4, runner, merge-plan, validate, preflight |
| `qa.apiUrl` | | none | runner (as `API_URL`) |
| `qa.apiTestDir` | | `qa.testDir` | briefs |
| `qa.protectedFiles` | | none; `qa.playwrightConfig` is always added | guard H4, apply-deletes |
| `qa.env` | | none | runner (extra variables the specs read) |
| `qa.installCommand` | | `npm ci --prefer-offline --no-audit --no-fund` | preflight stack |
| `qa.conventionsDocs` | | none | preflight, which hands them to the agents (the repo's own test guidelines) |
| `qa.capabilities` | | none, so no check | merge-plan |
| `qa.knownDrift` | | none | merge-plan, runner, briefs, memory: specs with known, unfixed breakage stay out of the run set. An entry's optional `tests` (titles) skips only those tests: the spec runs and the runner passes a file-scoped `--grep-invert`, and a title stays skipped unless an update item names that test. Without `tests` the whole spec drops (unless the run changes it), and the plan lists every test it drops |
| `qa.driftProbeEvery` | | 5 | runner, memory: every Nth run, while qa-feedback writes, runs only the tests `qa.knownDrift` skipped (`--drift-probe`, one launch, never part of the verdict). An entry whose tests all pass is suggested for removal; a whole-spec entry with only some failing, for narrowing to `tests`. `0` = never |
| `suites`, `routes` | | none, so every run runs the whole `qa.testDir` | merge-plan |
| `criticalAreas` | | none | the change-analyst brief |
| `limits.maxPlanRevisions`, `.maxTestLaunches` | | 2, 7 (the author's self-checks included: up to three, the third only on the specs that still failed) | guard H5, H7 |

- `suites` names groups of spec files or folders. `routes` maps qa-intake's `changeType` (`ui`,
  `api`, `auth`, `mixed`, `unknown`) to suite names; `mixed` runs every route.
- `criticalAreas` holds path prefixes. When the change-analyst flags a change that touches one,
  merge-plan runs every suite.
- `capabilities` says what the QA suite *can* validate. When it's set, a change type outside it
  gets an explicit coverage limitation, never a silent green.

## 4. Agents

Rules for every agent:
- Its inputs are files in the run folder, listed in a **brief** (`RUN/briefs/<step>.md`) that
  `scripts/brief.mjs` fills from `templates/briefs/<agent>.md`. It doesn't rely on chat history.
- It returns **one fenced JSON block** matching `schemas/<agent>.schema.json`. When it stops, the
  `SubagentStop` hook saves that handback to `RUN/outputs/<step>.md` (the last `SubagentHandback`
  message; agents then sign off with a short summary), so the main session never
  retypes it. The main session runs `validate.mjs --step <step>` (schema plus semantic checks: AC ids
  exist, files are under `qa.testDir`), which writes the clean JSON to `RUN/<name>.json`. The
  semantic checks also run when the schema fails, so one pass lists every error it can reach.
  On failure it re-prompts once with the errors (step `<step>-fix`, whose brief carries the
  schema in full and points at the saved handback `RUN/outputs/<step>.md`, to copy what the
  errors don't name); a second failure → `ESCALATED` and G3 (invalid output), which offers one more
  fix dispatch (`<step>-fix-2`) or stop. A third failure stops the run.
- It never talks to Jira or any MCP server and never writes to git or GitHub (guard H6, H8, H9).
  Intake and change-analyst may read PRs with `gh pr view|diff|list`.

| Agent | Job | Model | Tools |
|---|---|---|---|
| **qa-intake** | extract acceptance criteria, change type, affected areas, blocking ambiguities and assumptions from the ticket and the merged dev change | sonnet | Read, Grep, Glob, Bash† |
| **qa-suite-impact** | ticket-driven: which existing tests to update, add or delete, each item citing an AC | sonnet | Read, Grep, Glob |
| **qa-change-analyst** | code-driven: changed behaviour no test covers → extra scenarios and regression suites (configured suite names only); things seen only in the code → `observations`, which feedback must report as `code-observation` findings | sonnet | Read, Grep, Glob, Bash† |
| **qa-critic** | skeptical review of the merged plan: intake's ACs match the ticket, every AC covered, no update weakens a test; `approve` or `revise` with gaps, each for `qa-intake`, `qa-suite-impact` or `qa-change-analyst` | **opus** | Read, Grep, Glob |
| **qa-test-author** | apply approved updates, write new UI and API specs, self-check them; repair its own mistakes in them | sonnet | Read, Grep, Glob, Edit, Write, Bash† |
| **qa-triage** | classify each failure: `defect`, `flaky-suspected`, `env`, `test-bug`, `test-outdated`, `pre-existing`, `unknown`, with evidence | sonnet | Read, Grep, Glob, Bash† |
| **qa-feedback** | the human-facing report: suite changes and why, AC coverage before/after, results, defects, findings, recommended verdict, QA PR and Jira markdown. It reports the QA work; it isn't a code review | **opus** | Read, Grep, Glob |

† Bash is granted as a whole tool, and **H6** limits the commands per agent: intake and
change-analyst → `gh pr view|diff|list`, `git diff|log|show|status|rev-parse|ls-files`; triage →
`git log|show|blame`; the author → only the runner's self-check. The git commands take
repo-relative paths only (nothing absolute, no `~` or `..`) and no `--no-index`, `--ext-diff`,
`--textconv` or `--output`: git diff compares any two files on disk once a path is outside the
repo, which would reach what H11 keeps out.

## 5. The flow: `/qa-orchestrator:qa-run <KEY>`

`skills/qa-run/SKILL.md` is the playbook; this is its outline. The main session records every step
with `state.mjs`, and every write that matters is done by a script.

```
0. PREFLIGHT (preflight.mjs)
   · validate the key · status: an interrupted run? → 🧑 G0 resume / take over / start new
   · fetch the ticket (Jira MCP) · start: a background job (it may write only inside a linked
     worktree) → ⛔ BLOCKED_BACKGROUND (nothing created, stop) · check the config's required keys,
     take the lock, find merged dev PRs whose head branch names the key
       none → ⛔ BLOCKED_NOT_INTEGRATED (lock released, Jira comment, stop)
     create the worktree on qa/<KEY>-<slug> at the tested SHA (a re-test reuses the open QA PR's
     branch, first removing the previous run's worktree for it if that is clean and fully pushed,
     otherwise it stops), then write active.json last (the guard now applies to this session).
     A start that fails removes what it made: worktree, run folder, lock
   · a re-test of the very commit the previous delivered run tested → 🧑 re-test anyway, or stop
   · stack: install deps, docker compose up, health + SHA proof
       unhealthy or wrong SHA → ⛔ BLOCKED_ENV (Jira comment, run released, Jira status unchanged;
       the worktree goes and an unpushed QA branch with it, also when the Docker daemon is down)
   · claim: Jira → In QA + comment
1. UNDERSTAND → qa-intake            blocking ambiguities or low confidence → 🧑 G1
2. FAN-OUT, one message              qa-suite-impact ∥ qa-change-analyst
3. FAN-IN → merge-plan.mjs           plan.json {changeSet, runSet} + planHash
4. CRITIQUE → qa-critic              revise → re-run only the targeted agent(s), merge again
                                     an intake gap (a ticket requirement it missed) → intake,
                                     then suite-impact, then merge
                                     H5 cap reached → 🧑 G2-escalate (only then; a gap no
                                     revision can close goes to G2 as an open gap)
   🧑 G2 (every run): approve the plan (or approve and deliver if the run passes clean); the
     approval binds to planHash (no stack question: every release tears the QA stack down)
   any step: an agent output still invalid after its <step>-fix → ESCALATED, 🧑 G3 (one more
     fix, back in the step's phase, or stop)
   any gate's Stop: Jira comment, STOPPED, release --forget --teardown (frees the
     machine lock)
5. MAINTAIN + AUTHOR                 apply-deletes.mjs → qa-test-author → test-diff.mjs
                                     an empty change set (no update/add/delete) skips this step
                                     flags (fewer asserts, removed tests, skip/only, out of plan) → 🧑 G3
                                     every later author dispatch (send-back, repair, fix) →
                                     test-diff again; from step 7 on, rerun only its specs
6. RUN → stack --attach-only, run-playwright.mjs     invalid (0 tests) or launch cap (H7) → 🧑 G3
7. TRIAGE → qa-triage (failures only)
   flaky-suspected → rerun once, at any confidence (fails again → triage that attempt; flaky
     twice → unknown; a critical path → 🧑 G3 after the rerun)
   test-bug in an added spec → author repairs it, rerun once
   test-bug in an updated spec / test-outdated / pre-existing → 🧑 G3 (never repaired silently)
   defect → a finding, continue
   env / unknown / critical path → 🧑 G3
8. FEEDBACK → qa-feedback
   known-drift probe while qa-feedback writes (headless: right after it), after stack
     --attach-only: every qa.driftProbeEvery-th run (decided at start: state.json driftProbe; a
     run that isn't due launches nothing), only the skipped drift tests, once; never
     the verdict or the report; memory suggests removing or narrowing an entry (stack down, H7
     denial, no report or nothing ran → not counted, the next run probes)
9. REPORT + DELIVER
   deliver-tests.mjs --check: stale? clean pass? · 🧑 DELIVER: push qa/<KEY>-<slug> and open the QA PR?
     (not asked when G2 pre-approved and the run is clean: QA Passed, 0 defects, attempt 1 with
     0 failures, no G3/G2-escalate, not stale)
     No → nothing pushed, Jira comment without a PR link, the ticket stays In QA, release keeps
     the worktree (its tests are uncommitted; pushing them is the human's)
   no changes (an empty change set on a first run) → no DELIVER, no QA PR
   deliver-tests.mjs: commits approved QA files only, pushes that branch, opens the QA PR
     (draft when the recommendation is QA Failed)
   Jira: comment + transition → QA Review (not after DELIVER No)
   release --teardown, straight after Jira: history + memory, then tidy (§8)
     (timeline steps `deliver` and `jira-report` split REPORTING's time)
🧑 G4 (outside the plugin, always): a person merges the QA PR and sets QA Passed / QA Failed
```

| Gate | When | Enforced by |
|---|---|---|
| Breakers | a background job that can't write the run folder; no merged dev work; stack unhealthy or not the tested commit | `preflight.mjs` exit 3 (`BLOCKED_BACKGROUND`, `BLOCKED_NOT_INTEGRATED`, `BLOCKED_ENV`) |
| G0 | an interrupted run exists for the ticket | `preflight.mjs status` / `resume`; the lock records the owner's process id |
| G1 | the ticket is ambiguous | `AskUserQuestion` |
| G2 | every run, and when the critic round cap is hit | `AskUserQuestion`; approval bound to `planHash`; H4 blocks the author until then; H5 caps rounds |
| G3 | an agent output still invalid after its fix dispatch, flagged test diff, invalid run, launch cap, `test-bug` in an updated spec, `test-outdated`, `pre-existing`, env/unknown/critical failures | `AskUserQuestion`; H4 and H7 enforce |
| DELIVER | before anything is pushed, unless G2 pre-approved a clean pass or there are no QA test changes. Yes or No; No pushes nothing and leaves the ticket In QA | `deliver-tests.mjs` requires G2, and either DELIVER approved or G2's `deliverOnClean` plus a clean pass it checks itself from `runner-1.json`, `feedback.json`, the gates and the merged dev PRs |
| G4 | always, after the run | a person; H1 and H3 deny merge, approve and final Jira statuses |

## 6. The guard: deterministic rules (`hooks/guard.mjs`)

A `PreToolUse` hook (`hooks/hooks.json`) registered for
`^(Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Read|Grep|Glob)$` and `^mcp__`.
A `SubagentStop` hook (`hooks/record.mjs`) records agent telemetry and saves the agent's handback
(§4). It never blocks.

**Scope: two layers, both needed.**
1. **Install scope.** The plugin is installed at project (or local) scope in the target repo, so the
   hooks load only in sessions opened there.
2. **Run ownership.** Inside the target repo every session still loads the hooks. The guard allows
   everything (exit 0, no output) unless the project's `.qa-runs/active.json` names this
   session's `session_id`. Any error while checking also allows: a guard bug must never block
   normal work. Once the session owns an open run, a missing `.qa/config.json` blocks (below)
   instead of making the guard dormant, so moving the config away doesn't switch it off. A
   released run (below) goes dormant then instead, so a checkout without the config can't lock the
   session out of `release --forget`. Subagents share the parent's `session_id`, so ownership
   covers the whole run. After release the file stays with `closed: true`: that session
   still owns it, but only H1–H3 apply (no merge, no approval, no final Jira status), until
   `release --forget` removes the file.

Once ownership is proven, the guard loads the run context (config, active run, plan, state,
`counters.log`) and decides. Any error from there on blocks the call (exit 2, fail closed). A denial
names the rule and a readable reason, and is logged to `RUN/events.jsonl`.

Shell rules apply to Bash and PowerShell alike. Deny rules scan the **whole command text**, so a
guarded verb is caught inside `bash -c`, `pwsh -Command`, `eval`, `node -e`, or after `&&`, `;`,
`|`, `git -C <path>`, `git -c k=v` or `VAR=x`. They also run on a copy with quotes, backticks and
backslash escapes removed, so `git "push"` and `git pu\sh` count as a push. Subagent allowlists
are the opposite: the whole command must match, with no shell metacharacters outside quotes. Quoted
text is an argument (`git log -S"setTimeout("` is fine), except that `$` and backticks are refused
inside double quotes too, since the shell expands them there.

| # | Tools | Applies to | Denies | Why |
|---|---|---|---|---|
| H1 | Bash, PowerShell, GitHub MCP | everyone in the run | `gh pr merge`, `gh pr review --approve`, `gh api …/merge` or `/reviews`, `git merge/rebase`; GitHub MCP tools other than reads | merging and approving are human-only (G4) |
| H2 | Bash, PowerShell | everyone in the run | any `git push`; only `deliver-tests.mjs` pushes, and only `qa/<KEY>-<slug>` | the integration and release branches can deploy |
| H3 | Atlassian MCP tools | main session; other connectors: everyone | the configured Jira MCP (`jira.mcpToolPrefix`, default `mcp__atlassian__`): everything except reads, a comment on the run's ticket, and `transitionJiraIssue` on the run's ticket with a `transitionId` from `allowedTransitionIds`. `transitionName`, `executeWrite`, `executeDestructive`, issue create/edit and Confluence writes are denied. Any other MCP tool whose name has `atlassian`, `jira` or `confluence` in it (e.g. the claude.ai connector `mcp__claude_ai_Atlassian_Rovo__*`): everything, reads included | final Jira statuses are human-only, the generic execute tools could reach any operation, and a second connector would skip these checks |
| H4 | Edit, Write, MultiEdit, NotebookEdit | `qa-test-author` | writes before G2 approval; paths outside `qa.testDir`, in `protectedFiles` (always including `qa.playwrightConfig`), or not in the approved change set (repair mode: added files only); adding `.skip(`/`.only(`/`.fixme(`; a `Write` over a spec that existed at run start (use Edit) | the suite changes only as approved and is never weakened |
| H4 | same | main session, other agents | the main session writing the run worktree or `.qa/`; any write by the other agents | only the author changes tests |
| H5 | Agent, Task, SendMessage | main session | a critic dispatch past `1 + maxPlanRevisions` rounds; producer re-dispatches past the cap (every dispatch counts, a redo after a turn-limit stop included: kept as is on 2026-10-02); a `model` override or `run_in_background` on a plugin agent; any Agent call from a subagent; any `SendMessage` while the run is open (continuing an agent would skip the brief, validation and counters) | reflection is bounded by the hook, not by the model's narration |
| H6 | Bash, PowerShell | subagents | PowerShell at all; Bash outside the agent's whole-command allowlist (§4) | per-agent command scoping; agent frontmatter can't express it |
| H7 | Bash, PowerShell | everyone in the run | a test launch once `maxTestLaunches` (7) is used. A launch is `node` on the plugin runner (also through a shell variable, `node "$S/run-playwright.mjs"`) or `playwright test`; reading or grepping the runner isn't | one retry budget, including self-checks |
| H8 | `mcp__*` | subagents | always | only the main session talks to MCP servers |
| H9 | Bash, PowerShell | everyone in the run | `git add/commit/rm/mv/reset/restore/checkout/switch/stash/cherry-pick/revert/tag`; `gh pr create/edit/close/reopen/comment/ready` | git and PR writes happen only inside the scripts, which check the plan, the gates and the paths |
| H10 | Edit/Write, Bash, PowerShell | everyone in the run | Edit/Write: writing run control files (plan, state, baseline, counters, active run, lock) or run data (events, metrics, progress, dashboard, history, memory, the agent handbacks in `outputs/`). Shell: any command that names one of them, `.qa/config.json`, or the `.qa/` or `.qa-runs/` folder itself (paths inside `.qa-runs/<KEY>/` are fine), reads included (read them with the Read tool), unless it's a single `node <plugin>/scripts/*.mjs` call with no chaining, pipe, redirect or command substitution outside quotes | run state changes only through the scripts, and moving or deleting the config or those folders would end run ownership |
| H11 | Read, Grep, Glob | subagents | paths outside the run worktree, the run folder and the plugin; Grep, or a Glob without an absolute pattern, that has no explicit `path`; `..` in a pattern | the worktree is a clean checkout, so untracked secrets such as `.env` aren't reachable from injected ticket text |

`counters.log` is append-only, one JSON line per counted event, so two hooks firing at once during
the fan-out can't lose a count.

## 7. Triggers

A run starts only from `/qa-orchestrator:qa-run <KEY>` in a Claude Code session opened in the
target repo, interactive or headless (`claude -p`). The skill sets
`disable-model-invocation: true`: Claude can't start it on its own, only the typed command can.

A Jira @mention trigger isn't used: Jira Automation would need a public endpoint, and a cloud
routine runs on a fresh clone without the local QA stack.

## 8. The run folder

Everything lives in the target repo's main checkout, gitignored:

```
.qa-runs/
  .lock                 the machine lock: run, session, owner process id
  active.json           the active run; the guard's ownership check reads it
  history.jsonl         one line per released run
  memory.json, MEMORY.md  lessons learned on release, shown as hints at G2
  <KEY>/latest          the ticket's latest runId
  <KEY>/<runId>/        one run (RUN):
    state.json            written by state.mjs (steps, phases, gates), and by preflight.mjs and
                          deliver-tests.mjs for their own fields; every state.mjs write
                          regenerates progress.md, dashboard.html and metrics.json
    counters.log          guard-owned, append-only
    ticket.json, dev-changes.json, dev-changes.diff, config.snapshot.json, suite-baseline.json
    briefs/, notes/       what each agent was given
    outputs/<step>.md     what each agent handed back (SubagentStop hook; H10-protected)
    intake.json, suite-impact.json, change-analyst.json, critic-<n>.json, plan.json,
    test-author.json, test-diff.json, qa-tests.patch, triage.json, feedback.json, qa-pr.md
    previous-feedback.json  re-test only: the previous run's feedback.json, copied by brief.mjs
    runner-<n>.json (+ .raw.json), playwright-report-<n>/, test-results-<n>/ (until release)
    runner-self-<n>.json, playwright-report-self-<n>/, test-results-self-<n>/  (author self-checks)
    drift-probe.json (+ drift-probe.raw.json), playwright-report-drift/, test-results-drift/
                                       (the known-drift probe, when it ran)
    events.jsonl          agent time and tokens (SubagentStop) and guard denials
.qa-worktrees/<runId>/  the run's git worktree on qa/<KEY>-<slug> (until release, unless it holds work)
```

The G2 approval binds to the `planHash` of `plan.json` at that moment; any later plan edit
invalidates it. An interrupted run resumes at its recorded phase (G0). Runs made before 0.2.0 have
no `briefs/`, `notes/`, `events.jsonl`, `progress.md`, `dashboard.html` or `metrics.json`.

`metrics.json` counts every minute once, as agent, work, human wait or interrupted, in the phase
it fell in (the `metrics.mjs` header has the rules). Agent time is when an agent actually ran: the
recorder's interval, else the timeline step's brief-to-record span. Parallel agents count once,
and an agent that ran before a gate was answered isn't waiting (`time.method: "intervals"`). A
wait phase stops counting as waiting once its gate is answered. Older runs with no recorded
intervals keep the gap method (`"gaps"`).

**Release tidies a finished run** (`AWAITING_HUMAN_REVIEW`, `STOPPED`, `BLOCKED_*`; a run released
at a gate resumes later and is left alone). Finished runs grow large: a worktree with its own
`node_modules` (hundreds of MB), and every trace stored twice, because Playwright's HTML report
embeds a copy of each attachment (one long failing test's `trace.zip` can pass 400 MB). So release:
- deletes `test-results-<n>/` wherever `playwright-report-<n>/` exists. The report holds the same
  traces and screenshots, and the feedback report cites the report, not those paths. Triage reads
  `test-results-<n>/` during the run, before release.
- removes the worktree when that loses nothing (no uncommitted changes, every commit on
  `origin/<qa branch>`, or, for a branch never pushed, on origin already: a run that changed no
  test, or one stopped before the author wrote anything) and `docker compose -p <stack.project> ps -q`
  lists no container, or fails saying the Docker daemon isn't running. The QA stack mounts files
  from the worktree (e.g. a seed SQL file), so a stack kept running keeps it, and so does any other
  docker failure. With the worktree goes a QA branch that was never pushed, so the next run on the
  ticket isn't moved to `-2`. The QA PR is where the tests are reviewed.
  Otherwise it keeps the worktree and deletes only its
  `node_modules` (the stack step installs them again when missing). The worktree is renamed to
  `<runId>.removing` before it's deleted: on Windows a folder in use fails the rename whole,
  instead of being left half-deleted and still registered with git.
- records no history line or memory for a run in which no agent was dispatched.

`preflight.mjs prune --project <dir>` does the same for every finished run already on disk, and
deletes run folders that have no `state.json` (a start that failed before start cleaned up after
itself). It refuses while a run holds the lock. It deletes no whole run: `state.json`,
`feedback.json` and `<KEY>/latest` are read later (re-test, resume, memory), and the rest is small.

## 9. Claude Code facts the design relies on

Rows marked *docs* come from the Claude Code or Playwright documentation as read on 2026-09-23/24; the others
were observed live on Claude Code 2.1.281–2.1.284 (2026-09-24 to 29), with the payloads in
[setup.md](setup.md).

| Fact | Consequence |
|---|---|
| *docs* Subagents can't use `AskUserQuestion` | every gate lives in the main session |
| *docs* Background subagents keep every MCP tool | "only the main session writes to Jira" is enforced by hook (H8) |
| *docs* Agent `tools:` takes bare tool names; there's no per-command Bash scoping in frontmatter | command scoping is H6, keyed on `agent_type` |
| Hooks fire inside subagents with `agent_id` + `agent_type` (`qa-orchestrator:<name>`), and subagents share the parent's `session_id` | per-agent rules and session-scoped ownership work |
| *docs* Plugins can't ship permission rules | enforcement is hooks; a team can add its own deny rules as a second layer |
| *docs* `PreToolUse` can deny with a reason, or block with exit 2 (denials seen live in the dry run) | readable denials; fail closed inside a run |
| Plugin skills are namespaced (`/qa-orchestrator:qa-run`) | no clash with the target repo's own commands |
| A local-directory marketplace loads the plugin in place from its working tree; a GitHub marketplace install is a copy in the cache (both 2026-09-29) | see README "Install" for updates |
| *docs* Playwright's `request` fixture needs no browser | API specs live in the QA dir and run in the same Playwright config |
| *docs* `--reporter=json` goes to stdout unless `PLAYWRIGHT_JSON_OUTPUT_NAME` is set | the runner sets per-attempt output paths and `--retries 0`; flakiness is judged by a controlled rerun |

## 10. Limits, stated honestly

- The guard is a **workflow control, not a security boundary.** Text scanning can be evaded by a
  determined program (e.g. building `"git " + "push"` at runtime, or a shell glob such as
  `mv .q* x` that never names the folder), and the plugin is locally
  editable. Branch protection on the real branches is the other layer.
- G2 is recorded by `state.mjs gate`, which the model runs after `AskUserQuestion`. The script binds
  it to the plan on disk, but it can't prove a person answered.
- One machine at a time: the lock doesn't coordinate across machines.
- The QA stack is built locally from the tested SHA; a deployed environment isn't tested.
- Playwright reports stay on the QA engineer's machine, so links in the QA PR and Jira point at
  local paths.

