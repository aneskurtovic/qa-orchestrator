{{header}}

## Inputs
- Run folder (intake, plan, test-author, test-diff, runner-*, triage, state): `{{runDir}}`
- Change analyst (its `observations` each become a `code-observation` finding): `{{changeAnalystJson}}`
- HTML report of the test run, which holds every trace and screenshot: `{{runDir}}/playwright-report-<n>/index.html`
- Tested: `{{integrationBranch}}` @ `{{testedSha7}}`
{{previousFeedback}}

## Task
Write the human-facing report: what the run changed in the QA suite and why, AC coverage before and
after, results, defects and findings, and the recommended verdict (the human decides), as JSON plus
ready-to-post QA PR and Jira markdown. Report known failures from earlier runs as findings, not as
defects of this ticket, when the evidence agrees.

{{memory}}

{{notes}}

{{footer}}
