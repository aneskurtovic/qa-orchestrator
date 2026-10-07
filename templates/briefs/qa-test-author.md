{{header}}

## Inputs
- Approved plan (implement its changeSet exactly): `{{planJson}}`
- Run worktree (write the specs here): `{{worktree}}`
- QA test dir: `{{testDir}}` · API test dir: `{{apiTestDir}}` (relative to the worktree)
- Conventions to follow:
{{conventionsDocs}}

## Task
First Read the conventions docs above, in the same turn as the plan (runs have skipped them).
Then implement the plan's changeSet. Specs that existed at run start ({{existingSpecs}}) are changed with Edit
or MultiEdit only, never a whole-file Write. Then self-check in the foreground (Bash timeout 600000) and
wait for its JSON:

```
{{selfCheckCommand}}
```

{{memory}}

{{notes}}

{{footer}}
