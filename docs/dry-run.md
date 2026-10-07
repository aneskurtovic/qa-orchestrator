# Dry run: check a project's setup without Jira or GitHub

Use this once a project has its `.qa/config.json` (written by `/qa-orchestrator:setup` or by hand).
It proves preflight, the QA stack, the SHA
check, the Playwright runner and the guard against the real project, with **no Jira and no GitHub
writes** and no ticket.

Run it from a Claude Code session opened in the project root, with the plugin installed there. The
session's `CLAUDE_CODE_SESSION_ID` ties the run to it, so the guard switches on for this session
only. Replace the placeholders with absolute paths: `P` = the project root, `S` = the plugin's
`scripts` folder, `<runDir>` = the `runDir` that step 1 prints.

Before you start: Docker is running and the QA compose project has no containers
(`docker compose -p <stack.project> ps` is empty).

| # | Command | Expect |
|---|---|---|
| 1 | `node S/preflight.mjs start --project P --key PROJ-0 --no-dev-check --ref main` | `ok: true`, a `qaBranch` like `qa/PROJ-0-smoke-xxxx`, `testedSha` = `origin/main`. `P/.qa-runs/active.json` names this session |
| 2 | Ask Claude to run `git push origin main` | **denied, H2**: the guard is live for this session |
| 3 | Ask Claude to run `gh pr merge 1` | **denied, H1** |
| 4 | `node S/preflight.mjs stack --project P --run <runDir>` | deps install in the worktree, compose builds and starts, and every `shas` value = `testedSha`. Note the time |
| 5 | `node S/run-playwright.mjs --run <runDir> --project P --attempt 1 --files <two existing specs, comma-separated>` | `status: completed` with their tests passing; `<runDir>/playwright-report-1/index.html` exists and matches `runner-1.json` |
| 6 | the same with `--attempt 2` and one spec written with backslashes | backslashes are normalized; the spec runs |
| 7 | the same with `--attempt 3 --files <a spec path that doesn't exist>` | `status: invalid` (0 tests), **not** passed |
| 8 | step 5's command again, with `--attempt 4`, `5`, … until a launch is denied | launches run until `maxTestLaunches` are used (default 7: attempts 4–7 run, attempt 8 is **denied, H7**). The invalid launch in step 7 counts toward it |
| 9 | `node S/preflight.mjs release --project P --run <runDir> --teardown --forget` | the QA containers and volume are gone, `active.json` and `.lock` are gone, the dev stack's data is untouched |
| 10 | `node S/preflight.mjs cleanup --project P --run <runDir> --delete-branch` | the worktree folder is gone, `git worktree list` shows only the main checkout, the never-pushed smoke branch is deleted, `git status` is clean |

Use `preflight.mjs cleanup` rather than `git worktree remove`: on Windows the plain command can fail
with "Directory not empty" when the worktree holds an npm workspace link.
