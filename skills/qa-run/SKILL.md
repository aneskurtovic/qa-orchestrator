---
name: qa-run
description: Run the multi-agent QA workflow for one Jira ticket whose dev work is merged to the integration branch. It maintains the QA team's Playwright UI/API suite for the change, runs it and hands the human a QA PR and report. Invoke as /qa-orchestrator:qa-run <TICKET-KEY>.
argument-hint: <TICKET-KEY>
disable-model-invocation: true
---
# qa-run

Ticket: `${ARGUMENTS}`

You are the orchestrator. You follow this playbook step by step. You delegate judgment to the
`qa-orchestrator:*` agents, you run deterministic work through the plugin scripts, you ask the human
at every gate with `AskUserQuestion`, and you are the only one who talks to Jira. The plugin's guard
enforces the rules below. If a call is denied, read the reason, don't retry it another way, and
escalate to the human when the reason says so.

Jira (Atlassian Remote MCP; every call passes `cloudId` from `.qa/config.json` `jira.cloudId`). Use
only the tools under `jira.mcpToolPrefix`: the guard denies any other Atlassian connector in the
session (H3), reads included.
- read an issue: `getJiraIssue`; search: `searchJiraIssuesUsingJql`
- list transitions: `executeRead` with `{ name: "listJiraIssueTransitions", cloudId, inputs: { issueIdOrKey } }`
- list comments: `executeRead` with `{ name: "listJiraIssueComments", cloudId, inputs: { issueIdOrKey } }`
  (`getJiraIssue` only reports how many there are)
- comment: `addOrEditJiraIssueComment` (only on this run's ticket)
- transition: `transitionJiraIssue` with **`transitionId`** from `jira.allowedTransitionIds`, never
  `transitionName`. The guard allows only those ids on this run's ticket; `executeWrite`,
  `executeDestructive`, `createJiraIssue` and `editJiraIssue` are denied during a run.

Notation:
- `PROJECT` = the absolute path of the repo root (the current working directory, which holds
  `.qa/config.json`).
- `S` = `"${CLAUDE_PLUGIN_ROOT}/scripts"`. Write the path out in every command
  (`node "<plugin root>/scripts/state.mjs" …`), never as a shell variable: the guard recognises a
  plugin script by its path, and `S=…; node "$S/…"` is a chained command it can't exempt from H10.
- `RUN` = the `runDir` from preflight.
- The same goes for `RUN` and `PROJECT`: write the paths out in every command. No `R=…`/`P=…`
  variables, and one plain command per call, with no `&&`, `;` or pipes. Chained calls
  have been denied by H10 because they named `plan.json`.
- Run every plugin script in the **foreground** and wait for its result. Never use background
  execution for them: a session that ends while `deliver-tests` or the runner is still running
  leaves the run half-delivered. Pass `timeout: 600000` (the Bash maximum) to `preflight.mjs stack`,
  `run-playwright.mjs` and `deliver-tests.mjs`. A shorter timeout moves the command to the
  background: a delivery can take over 5 minutes when the target has a pre-push hook.
- **Waiting for agents.** Never pass `run_in_background` (the guard denies it). In an interactive
  session Claude Code's fork mode runs every agent in the background anyway: the call returns "Async
  agent launched", and the result arrives later as a task notification. Then say which agent you are
  waiting for, end your turn, and do nothing else until the notification: no next step, no other
  dispatch. The one exception is the known-drift probe while qa-feedback runs (step 8). With a
  parallel fan-out, wait for both results. Headless (`claude -p`) has fork mode
  off, so dispatches wait in place. Apart from that, end a turn only at a gate (AskUserQuestion) or
  when the playbook says stop.
- **Never continue an agent by message.** An agent that stopped at its turn limit ("partial result")
  or returned no valid JSON goes through the validation fix path below. `SendMessage` is denied
  during a run (H5): it would skip the brief, the validation and the counters. A fix dispatch of
  the critic or a planner counts like any other, so it can bring G2-escalate a round earlier.
- **Stop.** A gate option "Stop", or "the run stops": comment the reason on the Jira issue, then
  `node S/state.mjs phase --run RUN STOPPED`, then
  `node S/preflight.mjs release --project PROJECT --run RUN --forget --teardown`. Without the release the
  machine lock stays held, and the next ticket's preflight refuses to start. A gate that says
  otherwise (the unchanged-commit Stop posts nothing to Jira) wins. Preflight's breakers and
  errors in step 0 aren't this: they say what to do, and the script has already released the run
  or created nothing.
- **After any later author dispatch** (a send-back from step 5, a repair, a fix of an updated
  spec, an accepted `test-outdated` change, a pre-existing fix): validate its output, run
  `test-diff` again and handle its flags as in step 5 (a flag the human already accepted at G3
  isn't asked again). `test-diff` also rewrites `qa-tests.patch`, which the feedback report
  quotes. In step 5 (a send-back, a restored spec) nothing has run yet, so continue to step 6,
  whose attempt 1 runs the whole run set. From step 7 on, rerun only the specs it changed, within
  the budget.
- **Restoring a damaged spec.** If a pre-existing spec lost a test the approved plan doesn't
  remove (test-diff flag `tests-removed` already leaves the plan's removals out, or you see it
  yourself), never use `git checkout`/`git restore` (H9) or write the worktree (H4).
  Run `node S/restore-spec.mjs --run RUN --project PROJECT --file <repo-relative spec>`. It puts back
  the run-start content. Then re-dispatch `qa-test-author` (phase `MAINTAINING`, not repair mode)
  to re-apply its planned change to that file with Edit, never Write.
- Every script prints JSON. Exit 0 = ok, 1 = failure, 2 = usage error, 3 = a breaker or check fired
  (read the JSON).
- After EVERY step, record it:
  `node S/state.mjs timeline --run RUN --step <step> [--agent <a> --model <m>] --outcome <ok|…>`,
  and use `node S/state.mjs phase --run RUN <PHASE>` where the playbook says so.
- Dispatch agents WITHOUT a `model` parameter; the guard denies overrides. Their models (for the
  timeline's `--model`): qa-intake sonnet · qa-suite-impact sonnet · qa-change-analyst sonnet ·
  qa-critic **opus** · qa-test-author sonnet · qa-triage sonnet · qa-feedback **opus**.
- **Every dispatch goes through a brief.** Build it with
  `node S/brief.mjs --run RUN --project PROJECT --agent <qa-agent> --step <step> [--note-file RUN/notes/<step>.md]`
  and dispatch the agent with exactly the `prompt` it prints. The brief (`RUN/briefs/<step>.md`) holds
  the inputs as absolute paths, the tested SHA, the self-check command and the memory hints for that
  agent, so never retype them into the prompt. Anything only you know for this dispatch (critic gaps
  for a revision, validation errors to fix, the human's G1 answers, a repair's failure and trace) goes
  in a note: Write it to `RUN/notes/<step>.md` first and pass `--note-file`. Step names are the ones
  used below (`intake`, `suite-impact`, `critic-2`, `suite-impact-rev1`, `repair-3`, …).
- Agent output: **never retype it.** When an agent stops, a hook saves its handback to
  `RUN/outputs/<step>.md` (the guard denies writing there, H10). Run
  `node S/validate.mjs <agent-name> RUN/<name>.json --run RUN --project PROJECT --step <step>`: it
  reads that file and writes the clean JSON to `RUN/<name>.json`. `<step>` is the dispatch's own
  step, so a fix dispatch validates with `--step intake-fix`. Exit 3 (`missing`: the hook saved
  nothing) → save the agent's JSON to `RUN/<name>.json` with Write and run the same command without
  `--step`. On exit 1, send the
  errors back to the same agent once (a note with the errors, a new brief with step `<step>-fix`, a new
  dispatch; a `-fix` brief carries the agent's schema in full). A result with no fenced JSON block (a
  partial result at the turn limit, or a summary instead of the JSON) is treated the same way: the
  note says what is missing, and quotes what the partial result already established (per failure,
  per file) so the new dispatch starts from it instead of redoing it.
- **G3 (invalid output)**: the `-fix` output fails validation too. Phase `ESCALATED`. Show the
  errors exactly as validate printed them and how many dispatches the step has had. Don't predict
  that a fix will be the last one. AskUserQuestion:
  - "One more fix dispatch": `state.mjs gate --run RUN --id G3 --decision refix`, then set the
    phase back to the step's own (e.g. `FEEDBACK`; `ESCALATED` is a waiting phase), a note with
    the new errors, brief step `<step>-fix-2`, dispatch, validate. It is offered once per step: if
    `<step>-fix-2` still fails, the run stops as below.
  - "Stop" (see Stop above).
- Each step's result is in `RUN/progress.md` (and `dashboard.html`), which every `state.mjs` write
  regenerates. Between steps, say in one line what is running next; the gates and the final
  summary carry the facts the human needs.
- **Gates are the human's decision.** Ask each one with exactly the options this playbook lists, in
  its order, and mark none as recommended. Give the facts the human needs in the question, not your
  preference. Only a free-text "Other" answer may add something the options don't cover.
- **Run data is generated, never written by you.** After every `state.mjs` call the plugin rebuilds
  `RUN/progress.md`, `RUN/dashboard.html` and `RUN/metrics.json`; a hook records each agent's time and
  tokens in `RUN/events.jsonl`. The guard denies writing them (H10). Tell the human the dashboard path
  once, after preflight.

## 0. Preflight

1. Validate `${ARGUMENTS}` against `^[A-Z][A-Z0-9]+-\d+$`. If it doesn't match, reply
   "Invalid ticket key. Usage: /qa-orchestrator:qa-run PROJ-1" and stop.
2. `node S/preflight.mjs status --project PROJECT --key KEY`.
   - If `latest.resumable`: ask G0 "Resume the <phase> run from <runId>, or start a new run?"
     Resume → `node S/preflight.mjs resume --project PROJECT --key KEY` and continue at the step
     that phase belongs to.
   - If the latest run is unfinished but not waiting at a gate, or its `lock` names another session
     (a session was closed or hit a usage limit mid-step), look at `lock.ownerAlive`:
     - `false` (that session's Claude process has ended): ask G0 "Run <runId>
       was interrupted in <phase>; its session has ended. Resume it here, or start a new run?"
       Resume → `node S/preflight.mjs resume --project PROJECT --key KEY` (no `--takeover` needed).
     - `true` or `null` (the process still runs, which includes a /clear'ed session, or unknown): ask G0 "Run <runId> was interrupted in <phase>
       by session <id>. Is that session closed? Take the run over here?" Yes →
       `node S/preflight.mjs resume --project PROJECT --key KEY --takeover`.
   - If `lock` is held by a different run: tell the user and stop.
   - After any resume, **continue at the recorded phase; don't redo finished sub-steps.** The resume
     JSON lists `outputs` (step files already in RUN), `saved` (steps whose handback the hook saved)
     and `stepsInPhase` (timeline entries since the phase began). Re-run `validate.mjs` on each agent
     output of that phase, with `--step` for a step in `saved` that has no output file yet. Valid →
     keep it and skip that dispatch. Missing or invalid → redo it. Scripts whose outputs exist (`plan.json`,
     `test-diff.json`, `runner-<n>.json`) are rerun only if an input they depend on was redone. In
     `EXECUTING`/`TRIAGING` the stack must still be re-proven (`stack --attach-only`, step 6).
3. Jira: fetch the issue with the Atlassian MCP (summary, description, acceptance criteria, status,
   comments). Its status must be the config's `jira.statuses.ready` (or `inQa` when resuming);
   otherwise ask the human.
4. `node S/preflight.mjs start --project PROJECT --key KEY`.
   - Exit 3 `BLOCKED_BACKGROUND` (also from `resume`): this session is a background job, which can't
     save the run's outputs. Tell the user the reason exactly as printed (it names both ways to start
     the run) and stop. Don't post to Jira and don't work around it: nothing was created.
   - Exit 3 `BLOCKED_NOT_INTEGRATED`: post a Jira comment with the reason, tell the user, stop.
   - Exit 2 with "already in progress" or "already exists": tell the user, stop.
   - If `retest` is set, this ticket was QA'd before and its QA PR #`retest.previousPr` is still open
     (typically QA Failed → dev fix → Ready for QA again). The worktree is that QA branch, with the
     new integration commit merged in. The earlier QA tests are now *existing* tests, so plan
     updates against them. Delivery updates that same PR. Tell the human it's a re-test.
     Preflight frees the QA branch itself when the previous run's worktree still holds it and
     nothing would be lost (`freedWorktree` in the output: say which run's worktree it removed). If
     that worktree has uncommitted or unpushed work, preflight stops with exit 2 and says so: tell
     the human and stop. Don't clean it up yourself.
   - If `unchanged` is set, the integration branch is still at the commit that run
     `unchanged.previousRunId` tested: no dev fix has been merged since. AskUserQuestion "Nothing new
     on `<integration branch>` since run <id> (<sha7>). Re-test anyway?" with the options "Stop" and
     "Re-test anyway". Stop → `node S/state.mjs phase --run RUN STOPPED`, then
     `node S/preflight.mjs release --project PROJECT --run RUN --forget`. Nothing goes to Jira.
   - Show any `warnings` (e.g. a missing conventions doc) and continue. Keep `conventionsDocs`
     (absolute paths in the worktree) for steps 2 and 5.
5. Save the Jira issue as `RUN/ticket.json` (Write). Record the title:
   `node S/state.mjs set --run RUN ticket '{"key":"KEY","title":"<summary>","url":"<url>"}'`. The URL
   is `<site>/browse/KEY`, with the site `url` that `getAccessibleAtlassianResources` returns for
   `jira.cloudId`. Never guess the host.
6. `node S/preflight.mjs stack --project PROJECT --run RUN` (installs deps, builds and starts the QA
   stack, proves the running app is the tested commit). It runs before the claim, so a run that
   can't start its stack leaves the issue in its status (otherwise a claimed run that stopped on, say, a closed
   Docker Desktop would leave the issue In QA for the retry to find).
   - Exit 3 `BLOCKED_ENV`: post a Jira comment with the reason, tell the user, stop. The script has
     already released the run.
7. Claim: transition the issue to "In QA" (the id in `jira.allowedTransitionIds` whose target is
   `jira.statuses.inQa`). Comment "🤖 QA run <runId> started. Testing <integration branch> @ <sha7>".
   Skip both if the issue is already In QA.

## 1. Understand: qa-intake

Phase `UNDERSTANDING`. Brief step `intake`, dispatch `qa-orchestrator:qa-intake`. Save and validate →
`RUN/intake.json`.

**G1** if `confidence < 0.7` or `ambiguities` is non-empty (blocking questions only;
`assumptions` do not stop the run, they are shown at G2): AskUserQuestion listing the ambiguities,
with the options:
- "Answer now": write the answers to `RUN/notes/intake-2.md` and re-run intake (brief step `intake-2`
  with that note).
- "Post questions to Jira and stop": comment the questions, phase `AWAITING_ENGINEER`, then
  `release`.
- "Proceed anyway": note it with `state.mjs gate --id G1`.

## 2. Fan-out: "Do we have tests to update/add/delete?" ∥ "Analyse the code and add what we missed"

Phase `PLANNING`. Build both briefs (steps `suite-impact` and `change-analyst`), then in **one
message** dispatch `qa-orchestrator:qa-suite-impact` and `qa-orchestrator:qa-change-analyst` in
parallel. Save and validate → `RUN/suite-impact.json` and `RUN/change-analyst.json`.

## 3. Fan-in: "Prepare the test plan: what should run"

`node S/merge-plan.mjs --run RUN --project PROJECT` → `RUN/plan.json` + `planHash`. Exit 1 lists the
plan's problems. Send them to the responsible agent (one revision: the problems as a note, brief step
`<agent>-fix`), then merge again.

## 4. Critique: qa-critic (bounded)

Brief step `critic-<round>`, dispatch `qa-orchestrator:qa-critic`. Save and validate →
`RUN/critic-<round>.json`.
- `revise`: re-dispatch only the agents named in `gaps[].target`. For each, write its gaps to
  `RUN/notes/<agent>-rev<round>.md` and brief step `<agent>-rev<round>` with that note, `<agent>`
  without the `qa-` prefix, e.g. `suite-impact-rev1` (the brief points the agent at its previous
  output). Save, validate, merge-plan again, critique again.
- A gap with target `qa-intake` (a requirement the ticket states that intake missed or misread):
  re-dispatch intake first (note `RUN/notes/intake-rev<round>.md`, brief step
  `intake-rev<round>`), validate → `RUN/intake.json`, and report it. If it now has `ambiguities`
  or `confidence < 0.7`, G1 as in step 1 ("Answer now" re-runs it as step `intake-rev<round>-2`).
  Then re-dispatch `qa-suite-impact` (step
  `suite-impact-rev<round>`, its note naming the new or changed ACs plus its own gaps, if any)
  even when no gap targets it: it owns every AC's disposition. The change analyst reads the code,
  not the ticket, so it goes again only when a gap targets it. Then merge and critique as above.
- The guard counts rounds. When critic round `1 + limits.maxPlanRevisions` still says `revise`, don't
  prepare another revision: go straight to **G2-escalate** with the open gaps. Do the same when a
  dispatch is denied with **H5**. Escalate only in those two cases. If you judge that no revision
  can close a gap (it asks for something the plan has no place for), go to G2 proper and list the
  gap as open there, so the human still has "Change something". G2-escalate's options are:
  - "Approve as is"
  - "Approve and hand the open gaps to the test author": use this when the gaps are about HOW to
    test, not WHAT. Record it as G2 approved, with a note, and pass the gaps to qa-test-author as
    mandatory notes.
  - "Stop"

  A run that went through G2-escalate is never a clean pass, so DELIVER is always asked after it.

**G2 (always)**: phase `AWAITING_PLAN_APPROVAL`. Show the human:
- the AC → disposition table, with the `why` of each `manual` AC (its manual procedure)
- change-analyst's `observations` (file:line, note): seen only in the code, no test checks them; the
  feedback report carries each one as a `code-observation`
- every **update** (file, AC, intended change)
- every **delete** (file, evidence)
- every **add** (file, kind ui/api, source ticket/code), saying "into an existing spec" when `intoExisting` is set
- the run set size, the limitations and any open critic gaps
- `knownDriftSkipped`: what `qa.knownDrift` leaves out of the run (file, reason, and every title in
  `tests`). `wholeFile: true` drops the whole spec, healthy tests included; otherwise only those tests
  are left out and the rest of the spec runs. Approving the plan approves these skips.
- intake's `assumptions` (each with the interpretation chosen and its basis), so the human can
  overrule one before tests are written
- the memory hints this run's agents were given: `node S/memory.mjs used --run RUN`, and print its
  `table` as is (type, subject, summary, runs seen), not a count. A hint the human says is wrong →
  `memory.mjs forget --project PROJECT --id <id>`
- when the change set is empty (no update, add or delete: every AC is `existing` and nothing was
  missed): "No QA test changes. The run only runs the existing tests." On a first run, add "and
  there will be no QA PR". A re-test still delivers: it updates the open QA PR.

Then one AskUserQuestion with the plan question (on a first run with an empty change set, leave out
"Approve, and deliver if the run passes clean": there is nothing to deliver):
- "Approve plan" → `node S/state.mjs gate --run RUN --id G2 --decision approved` (binds the approval
  to the current planHash)
- "Approve, and deliver if the run passes clean" → the same with `--deliver-on-clean`. Say what
  clean means: QA Passed with no defects, no failure on the first test run, no G3, and no new dev
  work merged during the run. Then the QA PR goes out and Jira moves to QA Review without asking
  again. Anything else and DELIVER is asked as usual.
- "Change something" → take the instructions, re-dispatch the relevant agent, merge, re-ask G2
- "Stop" → see Stop in the notation

There is no stack question: every release tears the QA stack down (the user's decision,
2026-10-01). The QA stack is its own Compose project (`stack.project`), so the developer's own
stack is never touched. The next run builds it again in preflight (about 3 minutes).

"Approve plan" approves the plan as hashed, nothing more. A problem you find in it yourself goes in
the G2 facts as an open gap, and "Change something" is how it gets fixed. Don't pass it to the
test author as a note afterwards (for example a step order the critic missed): the author's note
carries only G2-escalate's open gaps.

## 5. Maintain + author: "Update them" + "Prepare automated tests"

Phase `MAINTAINING`. An empty change set (no update, add or delete) skips this step: there is
nothing for the author to write, and a self-check with no files is denied (H6). Record
`node S/state.mjs timeline --run RUN --step test-author --outcome skipped` and go on to step 6. A
later G3 that adds an update item (an accepted `test-outdated` change, a pre-existing fix) dispatches
the author as usual.
1. `node S/apply-deletes.mjs --run RUN --project PROJECT` (approved deletions only).
2. Brief step `test-author` (it computes the self-check command from the plan's change set and
   names the pre-existing specs the author may only Edit). If G2 escalated with open gaps "for the
   test author", put them in its note. Dispatch `qa-orchestrator:qa-test-author`. Save and validate →
   `RUN/test-author.json`.
3. `node S/test-diff.mjs --run RUN --project PROJECT`. Exit 3 = flagged (fewer assertions, a
   pre-existing test removed, a skip/only/fixme, a file outside the plan, a planned change
   missing). For `tests-removed`, first restore the file (see "Restoring a damaged spec" above) and
   send it back to the author, then run test-diff again. **G3** for whatever is still flagged: show
   the flagged files from `RUN/test-diff.json` (with `testsRemoved` titles), then AskUserQuestion:
   - "Accept these changes": `state.mjs gate --id G3 --decision accepted-diff`
   - "Send back to the author": re-dispatch it with the flags, once, then as in "After any later
     author dispatch"
   - "Stop"

## 6. Run: "Run them"

Phase `EXECUTING`. First `node S/preflight.mjs stack --project PROJECT --run RUN --attach-only`. It
re-proves the stack is healthy and running the tested commit; this matters most after a resume or a
takeover. Exit 3 → BLOCKED_ENV handling as in step 0.6. Then
`node S/run-playwright.mjs --run RUN --project PROJECT --attempt 1`. It writes
`RUN/runner-1.json`, `RUN/playwright-report-1/` and `RUN/test-results-1/`.
- `status: "invalid"` (no tests, a collection error, a crash) → **G3**. Never report it as passed.
- A denial with **H7** (test budget used up) → **G3**, with the budget shown.

## 7. Triage (only if there are failures): "Analyse results"

Phase `TRIAGING`. Brief step `triage` (or `triage-<n>` after a rerun) with `--attempt <n>`, dispatch
`qa-orchestrator:qa-triage`. Triage checks `causeCommit` itself with read-only
`git log|show|blame <sha> -- <file>`; don't re-verify it unless its evidence lacks the git output.
Save and validate → `RUN/triage.json`. Then per failure. When a failure matches more than one rule
below, the narrowest options win: `unknown`, `confidence < 0.6` and a failure in one of
`change-analyst.json` `criticalPaths` allow only "Continue with findings" or "Stop" (plus the `env`
option), whatever the classification. One exception: a `flaky-suspected` failure gets its rerun
first, whatever its confidence, because a rerun only gathers evidence (the user's decision,
2026-10-02). The rule then applies to what the rerun shows.
- `flaky-suspected`: rerun only those specs once:
  `run-playwright.mjs … --attempt <n+1> --files <specs>`. Passes → flaky (report it), except that a
  failure in `criticalPaths` still goes to **G3** below, with the rerun's result shown. Fails →
  triage that attempt (brief step `triage-<n+1>`, `--attempt <n+1>`, validated into
  `RUN/triage-<n+1>.json`, so `triage.json` keeps the first pass) and follow its new
  classification in the final one you record below. A second `flaky-suspected` for the same test
  is `unknown`. An H7 denial of the rerun → **G3**, with the budget shown.
- `test-bug` on a spec added this run (in `changeSet.add`): phase `REPAIRING`. Write the failure
  and its trace path to `RUN/notes/repair-<k>.md`, brief step `repair-<k>` with `--files <spec>`
  and that note (the brief picks the next free self-check number), and dispatch the author. Then as in "After any
  later author dispatch" (the rerun is once). Still failing → `unknown`.
- `test-bug` on a spec that existed before the run and was updated this run (in
  `changeSet.update`): repair mode can't touch it (H4 allows only added files there), and its
  other tests are the suite's existing coverage, so **G3**: show the failure, triage's evidence
  and what the approved update item said, then AskUserQuestion:
  - "Let the author fix it": `state.mjs gate --id G3 --decision fix-updated-spec`, phase
    `MAINTAINING`, then the same note, brief (step `fix-<k>`) and dispatch as for a repair. The
    author changes that spec with Edit only, within the approved update. Then as in "After any
    later author dispatch" (a dropped existing test is what test-diff catches; the rerun is
    once). Still failing → `unknown`.
  - "Continue with findings": report it as a test problem in this run, not a product defect.
  - "Stop"
- `test-outdated` (a pre-existing spec, not in the plan): **never repair it silently. G3**: show the
  AC, the failure and `proposedTestChange`, then AskUserQuestion:
  - "Accept the test change": add an `update` item for that spec to `RUN/suite-impact.json` (cite
    the AC), `merge-plan`, then `state.mjs gate --id G2 --decision approved --note "via G3 test-outdated"`.
    The author updates it (brief step `fix-<k>`), then as in "After any later author dispatch".
  - "It's a defect": treat it as a defect.
- `pre-existing` (a pre-existing spec broken by earlier merged work, not by this ticket) → **G3**:
  show the `causeCommit` and the `proposedTestChange`, then AskUserQuestion:
  - "Continue with findings": it's reported as a pre-existing failure and doesn't count against
    this ticket's verdict. Suggest a follow-up maintenance ticket.
  - "Fix it in this run": add an `update` item citing the cause, `merge-plan`, re-approve G2
    (`--note "via G3 pre-existing"`), then the author updates it (brief step `fix-<k>`), then as
    in "After any later author dispatch".
  - "Stop"
- `defect`: keep the evidence and continue. It's a finding, not a stop.
- `env`, `unknown`, `confidence < 0.6`, or a failure in `change-analyst.json` `criticalPaths`
  (a `flaky-suspected` one only after its rerun) → **G3**: "Continue with
  findings" or "Stop". For `env` failures there is a third option: "Environment fixed → re-run
  the failed specs". The human fixes the cause (stack, config, `qa.env`), then you run
  `stack --attach-only` and `run-playwright.mjs … --attempt <n+1> --files <failed specs>`, which
  counts against the test budget, and triage again if anything still fails.

Record the final classification with `node S/state.mjs set --run RUN triage '<json array>'`.

## 8. Feedback: "Provide feedback to human"

Phase `FEEDBACK`. Brief step `feedback`, dispatch `qa-orchestrator:qa-feedback`. On a re-test the
brief also points at the previous run's `feedback.json`, so the report shows what changed since the
last verdict (e.g. "AC1: defect → pass"). Save and validate → `RUN/feedback.json`.

**The known-drift probe runs while the feedback agent writes**, so it never runs after the report
is out. That's the only time in the run when an agent takes minutes and the stack is idle. Run after the PR and the Jira update, it can hold the release for minutes. So, as soon as
the dispatch returns "Async agent launched" (headless: as soon as feedback returns, before
step 9):
1. Only when `driftProbe.due` in `RUN/state.json` is true (preflight start decided it: every
   `qa.driftProbeEvery`-th run) and `plan.json` has `knownDriftSkipped` entries. Otherwise record
   the step as `skipped` (item 4) and run nothing: the guard counts every runner call as a test
   launch, even one that only finds the probe isn't due.
2. `node S/preflight.mjs stack --project PROJECT --run RUN --attach-only`. Exit 3 → skip the
   probe.
3. `node S/run-playwright.mjs --run RUN --project PROJECT --drift-probe`. It checks again whether
   the probe is due, and then runs only the skipped tests, once.
4. Record `node S/state.mjs timeline --run RUN --step drift-probe --outcome <ran|skipped>`, then
   wait for the feedback notification as usual.

Its result never changes the verdict, the report or anything posted, and the feedback agent doesn't
read it. At release, memory turns it into a suggestion. An H7 denial here means skip the probe,
never G3.

## 9. Report and deliver (you only, in this order)

Phase `REPORTING`. Don't copy the report into a file: `deliver-tests.mjs` writes the QA PR body
(`RUN/qa-pr.md`) from `feedback.json` itself.
1. `node S/deliver-tests.mjs --run RUN --project PROJECT --check` (read-only). It lists the merged
   dev PRs for KEY again: `stale: true` means new dev work merged after the tested commit, so
   prefix the verdict with "⚠ STALE: new dev work merged during the run" and say it in every
   message below. It also says whether this is a clean pass (`clean`, with `reasons` when not),
   whether G2 pre-approved delivery for one (`preApproved`), and whether there is anything to
   deliver (`changes`).
2. **No changes** (`changes: false`: a first run whose change set stayed empty): there is nothing to
   push, so no DELIVER gate and no `deliver-tests.mjs`. Say "No QA test changes, so no QA PR",
   record `node S/state.mjs timeline --run RUN --step deliver --outcome no-changes`, and go to 3.
   **DELIVER gate** otherwise, unless `preApproved` and `clean` are both true. Then say "Delivering without
   asking: approved at G2 for a clean pass" and go straight to `deliver-tests.mjs` below. Otherwise
   AskUserQuestion "Push `<qa branch>` and open the QA PR into `<integration branch>`? (draft if
   QA Failed)" with the options "Yes" and "No", and when G2 pre-approved, give `reasons` as why it
   is asked after all.
   - "No" (the user's decision, 2026-10-02): nothing is pushed and there is no QA PR.
     `node S/state.mjs gate --run RUN --id DELIVER --decision declined`, then
     `node S/state.mjs timeline --run RUN --step deliver --outcome declined`, and go to 3. Release
     keeps the worktree, since its tests are uncommitted. Pushing them later is the human's job.
   - "Yes" → `node S/state.mjs gate --run RUN --id DELIVER --decision approved`, then
     `node S/deliver-tests.mjs --run RUN --project PROJECT`. It checks the same conditions again
     itself and delivers only with a DELIVER approval or a G2 pre-approval of a clean pass. It
     commits only approved QA files, pushes the QA branch only (never forced), and opens the QA PR
     once, as a draft when the recommendation is QA Failed. On a re-test it updates the open QA PR
     instead: it adds a comment with the new verdict, replaces the description, and flips draft ↔
     ready. Then record `node S/state.mjs timeline --run RUN --step deliver --outcome <ok|…>`.
3. Jira: re-read the issue, and list its comments: `getJiraIssue` only counts them, so use
   `executeRead` with `{ name: "listJiraIssueComments", cloudId, inputs: { issueIdOrKey } }`. Keep
   the comment bodies in the response (no `responseFields` that leave out `body`): the marker below
   is in the body. If a
   human already moved it past In QA, don't transition; just comment.
   Otherwise:
   - Comment `feedback.jiraMarkdown` + the QA PR link + `<!-- qa-run:<runId> -->`. Skip if a comment
     with that marker exists. In place of the link: with no changes, "No QA PR: the existing QA
     tests cover this ticket, and the run changed none."; after DELIVER "No", "QA tests not
     delivered (declined at DELIVER). They are kept, uncommitted, in `<worktree>`."
   - Transition to QA Review (the allowed id whose target is `jira.statuses.review`). Not after
     DELIVER "No": the ticket stays In QA, since there is nothing to review yet.

   Then record `node S/state.mjs timeline --run RUN --step jira-report --outcome <ok|…>`, so the
   dashboard splits REPORTING into the push and the Jira update. Go straight on to 4: the run's
   work is done.
4. `node S/state.mjs phase --run RUN AWAITING_HUMAN_REVIEW`, then
   `node S/preflight.mjs release --project PROJECT --run RUN --teardown`. The machine lock is freed.
   This session keeps the human-only rules (no merge, no push, no final Jira status) until it ends.
   Release also records the run: its line in `.qa-runs/history.jsonl` (`history` in the output) and
   its lessons in `.qa-runs/memory.json` (`memory`, with any `suggestions` for the human).

Release also tidies the finished run (`tidy` in the output). It deletes `RUN/test-results-<n>/`,
because `RUN/playwright-report-<n>/` holds the same traces and screenshots. It removes the worktree,
`node_modules` included, when that loses nothing (no uncommitted changes, every commit on origin:
on the pushed QA branch, or already on the integration branch for a run that changed no test) and
the QA stack is down, since the stack mounts files from the worktree.
Otherwise it keeps the worktree without `node_modules` and says why; report that.
The QA PR is the place to review the tests. `node S/preflight.mjs cleanup --project PROJECT --run RUN`
removes a kept worktree once the human is done with it, and never deletes a pushed QA branch.
`node S/preflight.mjs prune --project PROJECT` tidies every finished run already on disk.

## G4: the human decides (never you)

End with a short summary:
- the verdict recommendation
- the QA PR link (or why there is none: no changes, or DELIVER "No")
- after DELIVER "No": the kept worktree and its uncommitted tests. Pushing them is the human's
  job, and `preflight.mjs cleanup` drops them. The next run on this ticket starts a new QA branch
  (`-2`) from the integration branch, without them
- defects, and the report that shows them
- `RUN/playwright-report-<n>/index.html` (traces and screenshots are in it) and `RUN/dashboard.html`
- every change-analyst observation, as the report lists it
- the run's active time and tokens (from release's `history`), and memory `suggestions`, if any
  (a known-drift entry whose tests passed in the probe is one: removing it is the human's change)

Then say the next steps are the human's: review and merge the QA PR, and set QA Passed or QA Failed
in Jira. If asked to merge, approve or set a final status, refuse and explain that it's the human's
decision. The guard denies it anyway.
