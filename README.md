# qa-orchestrator

A Claude Code plugin that runs a multi-agent QA workflow for one Jira ticket.

- Seven narrow agents maintain the repo's Playwright UI and API suite for the change (update, add
  and delete tests). Playwright runs the suite, and the agents analyse the results.
- A person approves the plan, merges the QA pull request and sets the final Jira status.
- Deterministic scripts and a hook guard enforce the rules the agents can't talk their way around.

## Docs

| File | Read it when |
|---|---|
| this README | you want to install the plugin and run it on a project |
| [docs/design.md](docs/design.md) | you want to know how it works and why: agents, flow, gates, guard rules |
| [docs/setup.md](docs/setup.md) | you need a verified fact: versions, hook payloads, the Jira setup, memory tips |
| [docs/dry-run.md](docs/dry-run.md) | a project has its `.qa/config.json` and you want to check the setup safely |
| [docs/demo/](docs/demo/) | you want the big picture: an intro deck (`qa-orchestrator-demo.pptx`) and the full workflow map (`workflow.html`) |
| [CLAUDE.md](CLAUDE.md) | you're changing this repo (commands, architecture, which files change together) |

Every doc describes what is true today.

## Install (per project)

Install the plugin **into the project that uses it**, not for your whole machine. The plugin's
skills, agents and guard hooks then load only in Claude Code sessions opened in that repo.

```bash
# once per machine
claude plugin marketplace add aneskurtovic/qa-orchestrator
claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v2/mcp   # then /mcp to log in

# once per project, run from the project root
claude plugin install qa-orchestrator@aneskurtovic --scope project
```

Pick one of the plugin's install scopes:

| Scope | Written to | Loads in | Use it when |
|---|---|---|---|
| `project` (recommended) | `<repo>/.claude/settings.json`, committed | that repo, for everyone who clones it | the team adopts the workflow |
| `local` | `<repo>/.claude/settings.local.json`, gitignored | that repo, only for you | trying it out, or the repo's `.claude/settings.json` is off limits |
| `user` | `~/.claude/settings.json` | every repo on your machine | avoid it: the plugin is only useful where `.qa/config.json` exists |

Always pass `--scope`: without it, `claude plugin install` defaults to `user`.

For a team, commit the marketplace next to the enabled plugin in `.claude/settings.json`. Once a
teammate trusts the folder, Claude Code registers the marketplace and enables the plugin. If the
folder isn't trusted, or the plugin doesn't appear, run the `install` command above.

```json
{
  "extraKnownMarketplaces": {
    "aneskurtovic": { "source": { "source": "github", "repo": "aneskurtovic/qa-orchestrator" } }
  },
  "enabledPlugins": { "qa-orchestrator@aneskurtovic": true }
}
```

There is no "system" install scope (`--scope` takes only `user`, `project` or `local`). An organisation that wants to force the plugin on or off does it
through managed settings (`enabledPlugins`), which IT distributes.

Updates: installed copies come from the GitHub marketplace and change only when the plugin's
`version` changes. Get the new version with `claude plugin marketplace update aneskurtovic` (or
auto-update), then start a new session.

Node ≥ 22, git, the GitHub CLI (`gh auth login`) and Docker are required. The plugin has no npm
dependencies.

## Adopt it in a project

Nothing in the plugin is project-specific. A project opts in with one committed file,
`.qa/config.json`, and Claude writes it for you:

1. Install the plugin in the project (see Install) and open Claude Code in the project root.
2. Run `/qa-orchestrator:setup`. Claude finds most values in the repo (the Playwright config and
   test folder, the app URL, the install command, the branches, the compose file), looks up the
   Jira values through the Atlassian MCP, and asks you for the rest. It writes `.qa/config.json` and
   the `.gitignore` entries, then checks the file with `scripts/check-config.mjs`. It shows the
   file (or, for an existing one, each key's before → after) and writes only after you say yes. It
   ends with a report: what changed, the checks, where the file is, what to do next. Its
   instructions allow only Jira reads and those two file writes. Unlike during a QA run, no guard
   enforces this. Run it in a normal session in your checkout. In a background job or a worktree,
   the file can't land in your checkout. Setup then asks you, and only if you choose the branch
   option does it commit those two files, push, and open a PR into the integration branch.
3. Commit `.qa/config.json`, `.gitignore` and, for a project-scope install, `.claude/settings.json`.
4. Check the setup safely with the [dry run](docs/dry-run.md), then start a real run:
   `/qa-orchestrator:qa-run <TICKET-KEY>`. Start it in an interactive session in your checkout, not
   in a background job. A background job may write only inside a linked git worktree, and the run
   folder `.qa-runs/` is in the checkout, so preflight refuses it (`BLOCKED_BACKGROUND`) unless the
   repo sets `"worktree": {"bgIsolation": "none"}`.

What the project needs. Setup checks these and tells you what's missing:
- A Playwright suite whose config reads `process.env.BASE_URL` (and `API_URL` for API tests). The
  plugin passes the QA stack's URLs to Playwright that way.
- `@playwright/test` installed at the repo root (a workspace dependency hoisted there counts).
- A Docker Compose file that starts the app **next to** a developer's own stack: its own ports, no
  fixed container names, a throwaway volume, seeded test data.
- A Jira project with a status for each step: ready for QA, in QA, QA review.

**`jira.allowedTransitionIds`.** In Jira, a ticket moves from one status to the next through a
*transition*, and each transition has an id. A QA run may use only two: → *In QA* and →
*QA Review*. The guard blocks every other transition, so the AI can never close a ticket. Setup
looks the two ids up for you.

To write the file by hand instead, start from
[config/qa.config.example.json](config/qa.config.example.json). It has only the required keys, and
every value is a `<…>` placeholder to replace. [config/examples/full-example.json](config/examples/full-example.json) is a
filled-in one with optional keys, and [docs/design.md](docs/design.md) §3 lists every key with its default.
Then run `node <plugin>/scripts/check-config.mjs --project <repo>`.

## What the guard enforces during a run

The guard loads only in repos that installed the plugin (above), and even there it stays dormant in
every session that doesn't own an active run. During a run:

- Merging, approving and final Jira statuses stay human-only (H1, H3). This still applies after the
  run hands over to the human. Jira is reached only through the configured connector; any other
  Atlassian connector in the session is denied (H3).
- No direct git pushes or commits. Only the plugin's scripts push the run's `qa/<KEY>-<slug>`
  branch and open the QA PR (H2, H9).
- The test author edits only the approved QA files, never product code or the Playwright config,
  and never adds `.skip`/`.only` (H4).
- Plan revisions and test launches are capped by hook-owned counters (H5, H7). An agent can't be
  continued by message during a run (H5), so every dispatch goes through a brief and is counted.
- Subagents get whole-command shell allowlists (H6; quoted arguments may hold `(` or `|`, never `$`
  or backticks), no MCP (H8), and reads limited to the run worktree, the run folder and the plugin
  (H11).
- Run state, run data and memory are written only by the plugin's scripts and hooks, and the
  `.qa/config.json` and the `.qa/` and `.qa-runs/` folders can't be moved or deleted from the
  shell during a run (H10).

Full table: [docs/design.md](docs/design.md) §6.

## Following a run, run data and memory

All of it is generated from the run files by the plugin, never written by the model. `RUN` is the
run folder, `.qa-runs/<KEY>/<runId>/` in the target repo.

| What | Where | How it's made |
|---|---|---|
| Live view | `RUN/dashboard.html` (reloads every 15 s while live), `RUN/progress.md` | rebuilt after every recorded step |
| Agent time and tokens | `RUN/events.jsonl` | `SubagentStop` hook reads each agent's transcript; works for background dispatches too. Guard denials land here as well |
| Run metrics | `RUN/metrics.json` | active time (agents vs orchestration), human wait and interruptions per phase; tests, triage, critic rounds |
| History | `.qa-runs/history.jsonl` | one line per run, written on release. `node scripts/metrics.mjs history --project <repo>` gives medians per phase |
| Step briefs | `RUN/briefs/<step>.md` | `brief.mjs` fills `templates/briefs/<agent>.md` from the run: inputs, tested SHA, self-check command, memory hints |
| Memory | `.qa-runs/memory.json` + `MEMORY.md` | learned on release from triage, critic gaps and guard denials. Hints are unverified and cited, expire after 6 runs unseen, and are shown at G2. A critic gap goes only to a run that touches a file its run touched (the dev diff and the plan), and a known failure already in `qa.knownDrift` isn't handed out. A known failure is dropped once its spec runs clean, and a cause triage only guessed (confidence under 0.7) isn't stored. Memory only *suggests* config changes: adding a `qa.knownDrift` entry, or removing or narrowing one whose tests passed in the known-drift probe (every `qa.driftProbeEvery`-th run) |

Memory and history stay on the machine that ran the QA (`.qa-runs/` is gitignored).

**Disk.** Release tidies a finished run. It deletes `RUN/test-results-<n>/`, whose traces and
screenshots the HTML report `RUN/playwright-report-<n>/` already holds, and it removes the run's
worktree (with its `node_modules`) when every commit is on origin (the pushed QA branch, or the integration branch for a run that
changed no test), nothing is
uncommitted and the QA stack is down. Otherwise it keeps the worktree without `node_modules`. For runs from before this
existed: `node scripts/preflight.mjs prune --project <repo>` (design §8). A run with no
`events.jsonl` (made before the recorder hook existed) can be backfilled from Claude Code's
transcripts:
`node scripts/metrics.mjs --run <runDir> --out <file> --transcripts ~/.claude/projects/<project-folder>`.

## Develop

```bash
npm test                          # guard + script tests (node --test); CI runs them on PRs and on main
claude plugin validate .
QA_HOOK_LOG=1 claude …            # log raw hook payloads (docs/setup.md)
```

## License

[MIT](LICENSE)
