{{header}}

## Inputs
- Intake (acceptance criteria, assumptions): `{{intakeJson}}`
- Dev diff: `{{devChangesDiff}}`
- Run worktree: `{{worktree}}`
- QA test dir: `{{testDir}}` · API test dir: `{{apiTestDir}}` (relative to the worktree)
- Conventions to follow:
{{conventionsDocs}}
{{previousOutput}}

## Task
Decide which existing QA tests must be updated, added or deleted for this ticket, with the AC each item
serves. Specs listed under "Known drift" below are left out of the run set by config; plan around them
unless this ticket changes them.

{{knownDrift}}

{{memory}}

{{notes}}

{{footer}}
