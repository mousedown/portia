---
name: portia-setup
description: Set Portia up for the repository this session started in - install the CLI if it is missing, then interview the person and write the profile, with every answer defaulting to what was detected. Use for "/portia-setup", "set up portia", "configure portia", or when /portia finds no profile.
---

# Portia setup

You interview the person and write a Portia profile for the repository this session started in. Keep it short: show what was detected, and only ask about what they want to change. Every question offers the detected value first, marked "(Recommended)".

## 1. Install if needed

Run `portia version`. If the command is not found, ask the person once whether to install Portia, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/mousedown/portia/main/scripts/install.sh | bash
```

It installs Bun too if it is missing. If `~/.bun/bin` is not on PATH afterwards, call the CLI as `~/.bun/bin/portia` for the rest of this skill.

## 2. Detect

Run `portia init --detect` from the repository root. It prints JSON and writes nothing:

- `answers`: the detected settings (`repo`, `tracker`, `transitions`, `checks`, `waveCap`, `models`, `branchPrefix`, `saveTo`, and `directLand` when no CI was found).
- `trackerSignal`: what points at a tracker. `choice` is `github`, `jira` or null; `ambiguous` is true when the signals conflict or there are none; `reason` says why in words.
- `candidates`: every command the repository gives evidence for, as `{ cmd, why, preselect }`. `why` is the file that justifies it.
- `scripts`: every package.json script as the command that runs it.
- `githubRepo`: the origin's `owner/name`, when it is on GitHub.
- `files.home` and `files.repo`: where the profile goes for each `saveTo`.

## 3. Show and ask

Show the detected settings as a short table: Tracker (GitHub Issues with its repo, or Jira with its two status names, and the `reason`), Checks, Landing, Workers at once, Models (hard / routine), Branch prefix, Save to (the matching path from `files`).

If `trackerSignal.ambiguous` is true, first ask with AskUserQuestion whether tickets live in GitHub Issues or Jira. State the `reason`, and mark neither option "(Recommended)". This is the one exception to offering the detected value first.

Then ask with AskUserQuestion: "Use these settings?" with the options "Use these (Recommended)" and "Change some".

If they change some, ask which with one multi-select question: Tracker, Checks, Landing, Workers and models, Branch prefix and save location. Then ask only about those, in one AskUserQuestion call where possible. The person can always pick "Other" to type a value.

- **Tracker:** GitHub Issues (`githubRepo`) or Jira. For Jira, also ask the status while a ticket is being built (default "In Progress") and once it has landed (default "Done"). For GitHub, transitions are `{ "running": "running", "landed": "landed" }`.
- **Checks:** multi-select from `candidates`, with the detected `checks` listed first and each one's `why` beside it. At least one is required. If `candidates` is empty, read the repository (its README, CI config and build files), propose the commands you find with the file that justifies each, and let the person edit them. Never propose a command the repository gives no evidence for.
- **Landing:** with `directLand` set, a ticket lands on its local gates alone, for epics of up to `maxChildren` tickets. CI still runs on the epic PR. Set it to `null` to wait for CI on each ticket's PR, which needs CI on the repository.
- **Workers and models:** workers at once (detected `waveCap` first), and the models for hard and routine tickets (detected first).
- **Branch prefix and save location:** the prefix (lowercase, not main or master), and where the profile lives: `files.home` (just you) or `files.repo` (`portia.config.ts`, committed and shared with the team).

When nothing was detected for checks, or the tracker is GitHub with no repo, ask about those even if the person chose "Use these". For a repository not built on JavaScript or TypeScript, say that acceptance gates are off until the profile is wired by hand: the checks you write here run, but `{acceptance}` and `{owned}` steps are not generated.

## 4. Write

Write only the changed answers, as JSON with the same keys as `answers`, to a temporary file, and always include `tracker` if you asked about it, even when the person kept the preselected one: `--yes` refuses an ambiguous tracker that `--answers` does not name. Then run `portia init --yes --answers <file>`.

- If the target file in `files` already exists, ask before replacing it, and add `--force` only on a yes.
- Exit 0: tell the person where the profile was saved. If the tracker is Jira and `JIRA_BASE_URL`, `JIRA_EMAIL` or `JIRA_API_TOKEN` is unset, say they need exporting. Then say the next step is `/portia <EPIC>`.
- If the output says `PORTIA_PROFILE` outranks the new profile, tell the person: the profile just written will not be used until it is unset.
- Exit 11: show the output, fix the answer it names with the person, and run it again.

Never write the profile file yourself. `portia init` renders and validates it.
