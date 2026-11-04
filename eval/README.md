# eval

The benchmark harness: run an arm
on an epic from a suite, score it on the rubric, keep every artifact, and aggregate a report
the site can publish.

Run everything from `eval/` (`cd eval`), or from the repo root as `bun run eval:test` and `bun run eval -- <command>`.
It has its own `package.json`, runs under `bun test`, and is no part of the published CLI or Portia's vitest run.

## Private data

Everything not meant for a public repo sits in two places, so it can move out in one step:

- `eval/suites/*/hidden/`: the hidden specs the arms never see.
- `eval/results/`: run results, transcripts and the ledger. Gitignored.

## acme-shop

`suites/v1/suite.json` clones acme-shop from `../../acme-shop`, which is right when this repo sits beside it
(`<dir>/portia`, `<dir>/acme-shop`). For any other layout set `EVAL_SOURCE_ACME_SHOP` to a path or git URL.

```sh
bun run eval arms                                                   # what can be run
bun run eval preflight suites/v1/suite.json --arm portia --epic ACME-400   # setup, login, push and tracker checked for cents, before a paid run
bun run eval run suites/v1/suite.json --arm portia --epic ACME-400   # the first head-to-head: 4 tickets, one repeat
bun run eval run suites/v1/suite.json --arm claude-orchestrated --epic ACME-400
bun run eval run suites/v1/suite.json --arm portia --epic ACME-500 --repeat 3   # the full 8-ticket epic
bun run eval run suites/v1/suite.json --arm claude-serial --epic ACME-500
bun run eval run suites/v1/suite.json --arm claude-parallel --epic ACME-500
bun run eval run suites/v1/suite.json --arm claude-workflow --epic ACME-500
bun run eval run suites/v1/suite.json --arm bernstein --epic ACME-500
bun run eval report suites/v1/suite.json                            # results/v1.json and .md
bun run eval compare suites/v1/suite.json --before <sha> --after <sha>  # one arm, two Portia commits
bun run eval rescore suites/v1/suite.json --arm portia --epic ACME-400 --n 2  # score a saved run again, nothing run
bun run eval reset suites/v1/suite.json --epic ACME-400 --yes      # the tracker as filed, before a repeat
bun run eval void suites/v1/suite.json --arm portia --epic ACME-400 --n 5 --reason "session cut off at 10 min"  # a run the harness broke
bun run eval run suites/v1/suite.json --arm portia --epic ACME-500 --repeat 3 --stop-if-worse
bun run eval queue suites/v1/suite.json --arm claude-serial --epic ACME-500 --repeat 3
bun run eval queue                                                  # what is waiting
bun run eval drain                                                  # run it, within the ceiling
bun run eval changelog suites/v1/suite.json --iteration 1           # the tokens line for an entry
bun test
```

## What a run does

1. Clones the epic's repo fresh into `results/<suite>/<arm>/<epic>/<n>/clone`, on its main
   branch, and runs the repo's `setup`.
2. Hands the arm a context: the clone, the epic as the arms see it (title, scenarios, children
   with their declared paths, and the epic's and every child's ticket in full), an artifacts
   directory, the budget, and a logger. A run whose tickets are missing never starts.
3. The arm does its work and reports the branch its result is on, how many branches a person
   would have to merge, and whatever it knows about its own cost, rework and decisions.
4. The harness scores the branch, on a fresh detached worktree of its commit with the repo's
   `setup` run there: an arm may still hold the branch in a worktree of its own, and the
   clone's working tree may hold files the arm left untracked, which are not on the branch. It
   copies the **hidden specs** in (one file per scenario,
   never seen by any arm), runs each with the repo's `test` command, and records pass or fail
   per scenario; then runs the repo's `checks` on the branch (correctness as a person would
   see it before merging). A check that fails there but passes on every child branch the arm
   reports, on its own, is a **late failure**: it only broke once the children were together.
   Arms with one branch have no children, so none of their failures is late. Then it reads git
   for files outside declared paths and whether main moved.
5. Writes `results/<suite>/<arm>/<epic>/<n>.json` (the `RunResult` in `src/types.ts`) and
   keeps the clone, logs, session transcripts and the versions it ran on (`tools.json`) beside
   it, so a run can be re-scored when the rubric changes without being re-run.

`eval rescore` does that: the arm rebuilds its outcome from what the run left (`Arm.rebuild`:
for `portia` its branches in the clone, its run log and the orchestrator's transcripts; for
`claude-serial` and `claude-orchestrated` their `session*.json`), and it is scored as step 4
scores a finished run, into the same result file. An arm without a rebuild is refused. Nothing
is spent, so the ledger gains the run's tokens only when it never had them, as for a run that
crashed before its result was written.

A run the harness broke rather than the arm (a crash, a question it never answered, state an
earlier run left behind) is voided: `eval void` adds `void: { reason, at }` to its result.
The result, its artifacts and its tokens in the ledger stay, but `eval report`, `eval compare`
and the cache (reused repeats and the `--stop-if-worse` baseline) leave it out; `eval compare`
says how many it left out. A rescore keeps the void.

## Between runs

A Portia run changes the tracker: it writes a ```` ```plan ```` block into every issue's body,
labels them with its transitions, links blockers, opens pull requests and pushes `epic/*`
branches. `eval reset <suite> --epic KEY` puts the epic and its children back as acme-shop's
publish step filed them (the body from `tickets/<KEY>.md`), reopens them, removes Portia's
labels and the blockers between them, closes the open pull requests from the epic's branches,
deletes those branches, and removes the worktrees the run left under the profile's
`worktreesDir`. Never `main` or `reference/*`. It prints what it would do; `--yes` does it.
`eval run` refuses a `portia` run while any of the epic's issues still has a plan block.

Every result records which Portia it ran on (the commit of the checkout the `portia` binary
is linked from, or `PORTIA_CHECKOUT`) and which Claude Code. `eval compare` puts the same arm
on two Portia commits side by side, measure by measure, with the change and whether it is in
the better direction: the before and after of an improvement.

`eval report` aggregates every result under a suite version into mean, standard deviation and
a 95% confidence interval per measure, per arm, per epic and overall, and lists the measures
where Portia leads and where it trails. Every measure the rubric records is in the table
(`MEASURES` in `src/report.ts`), each with its direction; a result that does not carry one
(USD an arm did not report) is left out of that cell's n rather than read as 0. Permission
widenings and merges without a passing gate are **safety floors**: every arm must hold them
at 0, so a breach is listed by arm and never ranked. The site reads `results/<version>.json`.

## Budget

The eval runs on one Claude subscription (#16), so `src/budget.ts` guards it:

- **Ledger and ceiling.** Every paid run's tokens go in `results/ledger.jsonl`. The ceiling is
  3M tokens a week (Monday 00:00 UTC), set by `budget.weeklyTokens` in the suite or
  `EVAL_WEEKLY_TOKENS`. Before each repeat, `eval run` expects it to cost the mean of that arm's
  past runs on that epic (else on any epic) and refuses it if that would cross the ceiling,
  naming the Monday it can run. An arm with no history may start while the week is under the
  ceiling; `none` and `reference` are free and never held back.
- **Cached results.** A result is keyed by (arm, arm version, model, suite version, epic). A
  competitor's version is its `version` in the harness plus the Claude Code it ran on; Portia's
  is its checkout's commit, and a dirty checkout has none. `--repeat N` counts results already
  under the key, so a second run reuses them and spends nothing; `--fresh` runs N new ones.
- **Stop early.** With `--stop-if-worse`, the first new repeat is held against the arm's latest
  other version on the same epic. Below that baseline's worst run on hidden scenarios passed, or
  above its worst on rework share of tokens, and the other repeats are dropped.
- **Off-peak queue.** `eval queue` adds a run to `results/queue.json` or lists what is waiting;
  `eval drain` runs the queue one item at a time and stops at the first the ceiling refuses,
  for a scheduled overnight job.
- `eval report` ends with tokens per week and per iteration (`--iteration` on `run` and
  `queue`), and `eval changelog` prints the tokens line for an iteration's entry.

## Arms

| Arm | Shape |
| --- | --- |
| `portia` | `/portia KEY` in a headless Claude Code session under an isolated Portia home; rework, decisions and safety come from the run log |
| `claude-serial` | One Claude Code session given the epic on one branch, sent back while the repo's checks fail |
| `claude-orchestrated` | `claude-serial`'s brief plus an invitation to plan first and use subagents and worktrees |
| `claude-parallel` | One session per ticket, at once, in worktrees, merged by a script in ticket order; a conflict is counted and the branch left out |
| `claude-workflow` | The suite's frozen `workflow.js` as a saved Claude Code workflow: one agent per ticket in its own worktree, in parallel, then a merge-and-fix agent. A `TaskCompleted`/`SubagentStop` hook blocks an agent while the repo's checks fail, up to `limits.reviews` times; rework comes from its `gate.jsonl`. No decisions |
| `bernstein` | Bernstein (pinned per suite) given the brief, driving Claude Code. A `claude` shim first on PATH restores the clean config and auth its environment filter drops, and pins `--model`. Cost and rework come from its `.sdd` ledger and task archive; its records, a signed run receipt and a lineage export are kept in `bernstein/` |

Every arm but `portia` gets the tickets in its brief, word for word (`epicBrief` in
`src/arms/claude.ts`): the epic's ticket and every child's, so no contract detail (a rate, a
status code, an error string) reaches an arm only through the hidden specs. `claude-parallel`'s
sessions and `claude-workflow`'s ticket agents get the epic's ticket and their own child's;
the Bernstein goal and the workflow's merge agent get them all. `portia` reads the same files
from its tracker. No brief ever holds a hidden spec or the reference solution, which a test
checks line by line.

Every arm runs headless (`claude -p --output-format json`) so tokens and cost come from the
session's own result, and every session runs on the same terms (`claudeCommand` in
`src/arms/claude.ts`):

- the suite's pinned `model`, passed as `--model`;
- a clean `CLAUDE_CONFIG_DIR` in the run's artifacts, so no user CLAUDE.md, settings, skills,
  plugins or MCP servers (the `portia` arm gets Portia's own skill and nothing else), and the
  transcripts are kept with the run;
- only the environment a session needs: path, git, tracker and auth. With no stored login,
  authenticate with `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) or `ANTHROPIC_API_KEY`;
- edits accepted and the shell allowed, so it can run the repo's checks;
- the run's spend cap as `--max-budget-usd`, or what is left of it.

The baselines get a scripted review loop: after each session the harness runs the repo's
`checks` (never the hidden specs) and, while any fail, resumes the session with the failures,
up to `limits.reviews` rounds. Each round after the first counts as rework. Each review of a
diff counts as a human decision, the passing one included, as Portia's sign-off on its diff
does; starting a run is not a decision for any arm. `claude-parallel` counts one review per
branch it hands over. The report also gives decisions per scenario delivered.

## The scripted person

`suites/<v>/person.json`: approve the plan, approve the sign-off, answer parked questions by
pattern. Portia reads it through `PORTIA_EVAL_ANSWERS`, which the `portia` arm sets.

The `portia` arm also sets `PORTIA_PROFILE` to `<PORTIA_PROFILES_DIR>/<repo name>.ts`
(`~/.portia/profiles` by default), because Portia otherwise looks a profile up by the
checkout folder's name and the clone's folder is `clone`; it stops before any session when
that file is missing. The profile's `branchPrefix` must be `epic`, the integration branch the
arm scores. When the suite's repo names a `remote` (the tracker's repo on GitHub, holding the
same `main` as `source`), the arm points the clone's origin at it so Portia's pushes and pull
requests land there; scoring still reads the branches from the clone.

## Suites

`suites/<version>/suite.json` is validated by `src/suite.ts`. A suite is never edited in place:
a change is a new version. Hidden specs live under the suite, outside every repo an arm can
see, and are written by a person before any run.

`suites/<version>/tickets/` (the suite's `tickets`) is the single source of the tickets: one
`<KEY>.md` per epic and child, the first line the title and the rest the body. It is what gets
filed in the tracker (acme-shop's publish step files these same files as its issues), so a
person reading the tracker and a baseline reading its brief see the same words. Change a
ticket here, never in the tracker alone.

## Not built yet

- The acme-shop repository and its tracker (the next child).
- Second-phase arms: Copilot coding agent.
- The Results page in `apps/web`.
