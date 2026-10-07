{{header}}

## Inputs
- Dev diff: `{{devChangesDiff}}`
- Merged dev work (PRs, merge SHAs): `{{devChangesJson}}`
- Run worktree: `{{worktree}}`
- QA test dir: `{{testDir}}` (relative to the worktree)
- Critical areas (config): {{criticalAreas}}
- Suites (config; the only names `suggestedSuites` takes): {{suiteNames}}
{{previousOutput}}

## Task
Read the change itself, not the ticket. Find changed behaviour that no QA test covers and propose the
extra UI/API scenarios and regression suites, each with a code reference.

{{memory}}

{{notes}}

{{footer}}
