# Setup

Verified facts: how the plugin installs, the environment it was checked on, the Claude Code
behaviour the guard relies on, the Jira setup it expects, and lessons about memory. Each fact
carries the date it was observed. For the quick start, read the README first.

## Install the plugin

```bash
claude plugin marketplace add aneskurtovic/qa-orchestrator   # or a local path to a clone
# from the target repo's root:
claude plugin install qa-orchestrator@aneskurtovic --scope project   # or --scope local (not committed)
claude plugin details qa-orchestrator@aneskurtovic     # lists skills, agents, hooks
```

`--scope project` writes only `{"enabledPlugins": {"qa-orchestrator@aneskurtovic": true}}` to the
repo's `.claude/settings.json`. Verified 2026-09-29 from both a local-directory marketplace and a
GitHub marketplace; `claude plugin details` then listed 2 skills, 7 agents and 2 hook events
(PreToolUse, SubagentStop). The plugin's hooks load only in sessions whose working directory is
that repo. Inside the repo, the guard also stays dormant unless the session owns an active QA run
(design.md §6). Scopes and team setup: README "Install".

Where the plugin loads from depends on the marketplace source:
- **Local-directory marketplace (plugin development):** the plugin loads **in place** from that
  directory's working tree, so edits take effect in the next session without reinstalling or bumping
  the version. The install still writes a copy to `~/.claude/plugins/cache/` (with a
  `gitCommitSha`), but that copy isn't what loads: verified 2026-09-29 with a probe plugin whose
  skill text was changed after install, committed and uncommitted, and `claude -p` saw each change.
  `~/.claude/plugins/known_marketplaces.json` (`aneskurtovic` → `installLocation`) shows which checkout
  that is. Changes on a worktree or branch go live only after they're merged and that checkout
  pulls.
- **GitHub marketplace:** the plugin is copied into `~/.claude/plugins/cache/`. A new copy
  arrives only when `version` changes, via `claude plugin marketplace update aneskurtovic` or auto-update.

Then, in a Claude Code session in the target repo, run `/qa-orchestrator:setup` to write
`.qa/config.json` (README "Adopt it in a project"), commit it, and run:

```
/qa-orchestrator:qa-run <TICKET-KEY>
```

## Debug: record hook payloads

Start Claude Code with `QA_HOOK_LOG=1` to append every hook payload to
`~/.claude/plugins/data/qa-orchestrator-aneskurtovic/hook-log.jsonl`, then summarize it:

```bash
node hooks/test/summarize-log.mjs
```

## Verified environment

The live runs (2026-09-24 to 2026-10-02) used:

| Component | Version |
|---|---|
| Claude Code (CLI) | 2.1.281 (2.1.284 on 2026-09-29) |
| Node | 24.1.0; the tests also pass on 22 |
| GitHub CLI | 2.87.3 |
| git | 2.49.0.windows.1 |
| Docker | 29.2.1 (checked 2026-09-29) |
| Playwright | `@playwright/test` `^1.61.1` |
| OS | Windows 11 Pro, Git Bash |

## Verified behaviour (2026-09-24 to 2026-10-01)

| Question | Observed |
|---|---|
| Spawn tool seen by `PreToolUse` | `Agent`, `tool_input = {description, prompt, subagent_type, run_in_background}` |
| Plugin agent id | `subagent_type: "qa-orchestrator:qa-intake"` |
| Subagent identity on its own tool calls | `agent_id` + `agent_type: "qa-orchestrator:qa-intake"`; absent on main-session calls |
| Subagent `session_id` | same as the parent session |
| `SubagentStop` extras | `last_assistant_message`, `agent_transcript_path`, `stop_hook_active` |
| Where the handback is | since 2026-09-29, every plugin agent sends its fenced JSON as a `SubagentHandback` tool call (`input.message`), then writes a short summary ("Done.", "Report delivered."), which is what `last_assistant_message` holds. Earlier, the last text message was the fenced JSON. The recorder takes the last `SubagentHandback` message, else the last fenced-JSON text |
| Skill invocation | `/qa-orchestrator:qa-run PROJ-1`; `${ARGUMENTS}` substituted; bad key rejected |
| Always-on context cost | about 610 tokens per session with 0.2.0 (`claude plugin details`, 2026-09-29) |
| Session id visible to scripts | `CLAUDE_CODE_SESSION_ID` in the Bash env **equals** the hooks' `session_id` |
| `CLAUDE_PROJECT_DIR` | set for hook processes (the project root); **not** set for Bash tool commands, so scripts take `--project` |
| Guard dormancy | with the guard installed, a normal session in the target repo (no active run) ran unaffected |
| Headless slash command | `claude -p "/qa-orchestrator:qa-run PROJ-1"` arrives as a user `<command-name>` expansion, not a model Skill call, so `disable-model-invocation: true` doesn't affect headless runs (2026-09-26) |
| Subagent transcripts | `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl` + `.meta.json` (`agentType`, `description`, `requestShape`: `foreground`/`background`). Every assistant line carries its API message's `usage`, repeated per content block, so count each `message.id` once |
| Agent tool result | sync: `totalDurationMs`, `totalToolUseCount`, `totalTokens` (= context size at the last turn, **not** tokens used), `usage` (last turn only). Async: `isAsync: true, status: "async_launched"`, no numbers. Hence the recorder reads the transcript on `SubagentStop` |
| Background job writes | a background job (`CLAUDE_JOB_DIR` set, CLI 2.1.284) rejects Write/Edit outside a linked git worktree: "This background session hasn't isolated its changes yet… (To disable this guard for this repo, set `"worktree": {"bgIsolation": "none"}` in .claude/settings.json.)". Bash is not affected. Preflight therefore refuses such a session (`BLOCKED_BACKGROUND`) |
| Background dispatch in practice | the Agent tool dispatched plugin agents in the background without `run_in_background`. Cause (Claude Code docs, sub-agents "Run subagents in foreground or background", checked 2026-09-29): **fork mode**, on by default in interactive sessions since v2.1.232, runs every subagent in the background and removes the Agent tool's `run_in_background` parameter; the result arrives as a task notification. It is off in `claude -p`, and `-p` also stays open until background work finishes (up to 10 min of idle waiting, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` forces the foreground, but for everything in the session. The playbook therefore ends the turn and waits for the notification |
| Continuing an agent | a subagent stopped at `maxTurns` returns a partial result that invites `SendMessage`; a continued run fires `SubagentStop` again under the same `agent_id`. The guard denies `SendMessage` during a run (H5) |
| Agent turn use | a critic walking server code one call per turn used all of a 14-turn limit and returned nothing, hence 20; triage used all 24 turns on 3 failures, hence 30. Fork-mode agents hand back with a `SubagentHandback` call; some got `[handback-send-enforce]` and re-sent their JSON |
| Two `SubagentStop`s per agent | an agent may first end its turn with the JSON as plain text (stop 1); `[handback-send-enforce]` then makes it call `SubagentHandback` (stop 2, same `agent_id`, cumulative tokens and duration). `events.jsonl` gets a line for each stop. `metrics.mjs` keeps the latest line per `agentId`, so neither time nor tokens are counted twice |
| Playwright output size | the HTML reporter copies every attachment into `playwright-report-<n>/data/`, so each `trace.zip` exists twice (one long failing test's trace was 427 MB, twice). Release deletes `test-results-<n>/` (design §8) |
| Target pre-push hooks | `deliver-tests` pushes through the target repo's own git hooks; a full pre-push gate (lint, type checks, unit tests) took over 5 minutes in one run, hence the playbook's 600 s timeout for delivery |

## Jira (verified 2026-09-24)

- MCP: `claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v2/mcp`, then `/mcp` → OAuth.
- The server exposes 21 tools, all prefixed `mcp__atlassian__`: `addGraphContext`, `addOrEditJiraIssueComment`,
  `atlassianUserInfo`, `createConfluenceContent`, `createJiraIssue`, `discover`, `editJiraIssue`,
  `executeDestructive`, `executeRead`, `executeWrite`, `getAccessibleAtlassianResources`,
  `getConfluenceContent`, `getGraphContext`, `getGraphObject`, `getJiraIssue`, `getLoomVideo`, `search`,
  `searchConfluence`, `searchJiraIssuesUsingJql`, `transitionJiraIssue`, `updateConfluenceContent`.
- `transitionJiraIssue(cloudId, issueIdOrKey, transitionId? | transitionName?, fields?, …)`. The guard
  accepts only `transitionId` from `jira.allowedTransitionIds`, on the run's own ticket.
- Listing transitions isn't a direct tool: `discover` finds `listJiraIssueTransitions`, which runs via
  `executeRead` as `{ name, cloudId, inputs: { issueIdOrKey } }`. The hook sees `name`, `cloudId` and `inputs`.
- **Security note:** the generic `executeWrite`/`executeDestructive` tools can reach any Jira operation, so
  the guard treats Jira as an allowlist (reads, a comment on the run ticket, configured transitions)
  rather than a denylist.
- Hook input for MCP calls also carries `mcp_server` (observed 2026-09-24; the guard doesn't use it).
- **Example workflow** (a team-managed project). Statuses: To Do, Ready For QA, In QA, QA Review,
  Done. In a team-managed project every transition can be global, so the Jira workflow may enforce
  no order; the guard does.

  | Transition id (example) | → Status | Who may use it |
  |---|---|---|
  | 11 | To Do | human (QA Failed → back to dev) |
  | 21 | Ready For QA | human / dev |
  | **31** | In QA | QA run (claim) |
  | **41** | QA Review | QA run (report) |
  | 51 | Done | human (QA Passed) |

  `allowedTransitionIds: ["31", "41"]`. A workflow needs no "QA Passed"/"QA Failed" statuses: at G4
  a person moves a passed ticket to Done and a failed one back to To Do. The plugin never sets
  these, so the config doesn't name them. Your ids will differ: `/qa-orchestrator:setup` looks them up.

## Memory: keep QA sessions lean (found 2026-09-24)

An end-to-end run was killed by Claude Code for low system memory. The cause was not the plugin:
- **Leaked MCP containers.** Every Claude session starts every configured MCP server. Docker-based
  servers that fail to connect (`docker run -i --rm …`) can keep running after the session gives
  up. After about 17 sessions there were 34 of them, ~2.5 GB inside Docker's WSL VM.
- **Docker's WSL VM (`vmmemWSL`) keeps page cache** and returns it to Windows slowly.

Remedies:
- Stop leaked containers: `docker stop $(docker ps -q --filter ancestor=<mcp-image>)`.
- Release the VM's cache without touching containers:
  `wsl -d docker-desktop -u root sh -c "sync; echo 3 > /proc/sys/vm/drop_caches"`.
  This took vmmemWSL from 5.0 GB to 1.9 GB.
- **Scripted or headless QA runs load only the MCP server they need:**
  `claude -p "/qa-orchestrator:qa-run KEY" --strict-mcp-config --mcp-config atlassian-only.json`
  with `config/mcp/atlassian-only.json` from this repo.
  The existing OAuth login is reused, and no extra containers or node processes start (verified).
- Optionally cap the VM in `%UserProfile%\.wslconfig` (`[wsl2]` `memory=8GB`), then `wsl --shutdown`.
  That restarts Docker.

## Tests

```bash
npm test        # guard + scripts: node --test, no dependencies; CI runs it on Windows
```
