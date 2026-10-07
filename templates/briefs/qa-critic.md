{{header}}

## Inputs
- Jira ticket dump (the source intake read the criteria from): `{{ticketJson}}`
- Intake: `{{intakeJson}}`
- Suite impact: `{{suiteImpactJson}}`
- Change analyst: `{{changeAnalystJson}}`
- Merged plan (what will be written and run): `{{planJson}}`
- Dev diff: `{{devChangesDiff}}`
- Run worktree: `{{worktree}}`
- QA test dir: `{{testDir}}` · API test dir: `{{apiTestDir}}` (relative to the worktree)
{{previousCritics}}

## Task
Review the plan skeptically against the ticket, the acceptance criteria intake drew from it, the code
change and the existing suite.
Approve, or revise with concrete gaps, each addressed to the agent that should fix it. If memory hints
follow, they are earlier critic findings on code this run also touches: check whether this plan
repeats one.

{{memory}}

{{notes}}

{{footer}}
