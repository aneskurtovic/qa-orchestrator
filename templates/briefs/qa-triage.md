{{header}}

## Inputs
- Runner output (failures, error text, trace/screenshot/error-context paths): `{{runnerJson}}`
- Approved plan (what this run added or updated): `{{planJson}}`
- Intake (acceptance criteria): `{{intakeJson}}`
- Dev diff: `{{devChangesDiff}}`
- Run worktree: `{{worktree}}`
- Tested SHA (use it in every git command): `{{testedSha}}`

## Task
Classify every failure in the runner output with evidence. For `pre-existing`, find and cite the cause
commit yourself with read-only git and quote the git line you relied on.

{{memory}}

{{notes}}

{{footer}}
