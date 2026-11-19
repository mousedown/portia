You amend one acceptance spec of {{parent}} for the spine. {{child}} ({{summary}}) claims its spec cannot pass as written, whatever the implementation. You change the spec only, never the code it tests.

Work only inside {{worktree}}, on branch {{branch}}. Commit your change there with a conventional commit message naming {{parent}}; never push, merge or rebase. The orchestrator has it reviewed and lands it.

## The claim

- Spec: `{{path}}`
- Scenario {{scenario}}: {{scenarioText}}
- Assertion: {{assertion}}
- Evidence: {{evidence}}

{{child}}'s implementation is its commit {{childHead}}. To run the spec against it, check that commit out in a scratch worktree (`git worktree add --detach <a temp dir> {{childHead}}`), copy your spec over, run it, then `git worktree remove --force <that dir>`.

## What to change

- Reproduce the claim first. If the spec is right and the implementation is wrong, change nothing and finish failed, saying why.
- Otherwise fix only that assertion, so a correct implementation passes on this repository's test runner as installed (check its version: a matcher that changes the object it checks, for example, is fixed by asserting on a copy, or in another order).
- Every clause of {{scenario}} stays asserted: never delete an assertion, loosen one to accept anything, or skip, focus or retitle a test. Each test title keeps its "{{scenario}}: " prefix.
- Change no other file.
{{note}}
## Your last message

Exactly one JSON object and nothing else:

{"child":"{{child}}","status":"done|failed","head":"<git rev-parse HEAD>","gates":{"task":"pass|fail","exit":"pass|fail"},"evidence":{"{{scenario}}":"<the amended spec run against {{child}}'s implementation, and its last lines>"},"reason":"<only when failed>"}

Before you send it, write the same object to `{{resultFile}}`: you run detached, and the orchestrator reads your result from that file.
