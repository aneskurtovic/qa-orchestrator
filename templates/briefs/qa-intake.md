{{header}}

## Inputs
- Jira ticket dump: `{{ticketJson}}`
- Merged dev work for the ticket (PRs, merge SHAs): `{{devChangesJson}}`
- Dev diff: `{{devChangesDiff}}`
- Run worktree (the tested commit, read-only for you): `{{worktree}}`
{{previousOutput}}

## Task
Extract the acceptance criteria, the change type, the affected areas, blocking ambiguities and the
assumptions you had to make. Ambiguities are only questions that block testing; everything else is an
assumption with the interpretation you chose and its basis.

{{memory}}

{{notes}}

{{footer}}
