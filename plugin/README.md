# Portia

Hand Claude Code an epic, get back one reviewed pull request.

Point Portia at an epic or a large story in Jira or GitHub Issues with `/portia PROJ-123`. It plans the work and shows you the plan before anything starts. One worker then lands the shared groundwork and writes every acceptance scenario as a failing test. After that the tickets fan out in waves of parallel workers, each in its own git worktree. Each child is gated, rebased and merged onto one integration branch, and you get a single PR to review at the end. Portia never merges to `main`.

**Claude Code only.** Portia drives git worktrees, a local CLI and detached Claude Code sessions on your machine, so its skills do nothing on claude.ai or in Cowork.

## Install

1. Install the plugin:

   ```text
   /plugin marketplace add mousedown/portia
   /plugin install portia@portia
   ```

2. Install the `portia` CLI, which the skills call. Run `/portia-setup` and it offers to install the CLI for you, or run the installer yourself:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/mousedown/portia/main/scripts/install.sh | bash
   ```

   The installer installs Bun if it is missing, clones Portia into `~/.portia`, links the `portia` command into `~/.bun/bin`, and also links the skills into `~/.claude/skills`. With both the plugin and the installer you will see the skills twice, as `/portia` and `/portia:portia`. Either one works.

3. In the repository you want to work on, run `/portia-setup`. It detects your tracker, branch prefix and checks, and writes a profile, either in `~/.portia/profiles/` or committed to the repository as `portia.config.ts`.

You need [Claude Code](https://code.claude.com) and the [GitHub CLI](https://cli.github.com), logged in, on macOS, Linux or WSL.

## Use

| Skill | Does |
| --- | --- |
| `/portia <KEY>` | Plan, then run, one epic or story to one reviewed PR. `<KEY>` is a Jira key or `GH-<number>` |
| `/portia resume <KEY>` | Pick a run back up where it stopped |
| `/portia-setup` | Install the CLI if it is missing and write the profile for this repository |

## What it runs, reads and sends

- **Your tracker.** Jira through its REST API, using `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` from your environment, or GitHub Issues through `gh`. It reads the epic and its tickets and writes the plan back to them.
- **GitHub.** `git` and `gh` push branches, open pull requests and merge children onto the integration branch. Never `main`.
- **Your machine.** Worker sessions run locally with `claude`. Run state, logs and profiles stay in `~/.portia`.
- **The plan page** loads its fonts from Google Fonts.
- **An optional decision service**, off by default, is called only if your profile names one, with `JEV_API_KEY`.

Portia has no telemetry, and the publisher stores nothing.

## More

The full reference, troubleshooting and how it works are in the [main README](https://github.com/mousedown/portia#readme) and the [reference](https://github.com/mousedown/portia/blob/main/docs/reference.md). Licensed under Apache-2.0.
