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

- `answers`: the detected settings (`repo`, `tracker`, `transitions`, `checks`, `waveCap`, `models`, `branchPrefix`, `saveTo`).
- `scripts`: every package.json script as the command that runs it.
- `githubRepo`: the origin's `owner/name`, when it is on GitHub.
- `files.home` and `files.repo`: where the profile goes for each `saveTo`.

## 3. Show and ask

Show the detected settings as a short table: Tracker (GitHub Issues with its repo, or Jira with its two status names), Checks, Workers at once, Models (hard / routine), Branch prefix, Save to (the matching path from `files`).

Then ask with AskUserQuestion: "Use these settings?" with the options "Use these (Recommended)" and "Change some".

If they change some, ask which with one multi-select question: Tracker, Checks, Workers and models, Branch prefix and save location. Then ask only about those, in one AskUserQuestion call where possible. The person can always pick "Other" to type a value.

- **Tracker:** GitHub Issues (`githubRepo`) or Jira. For Jira, also ask the status while a ticket is being built (default "In Progress") and once it has landed (default "Done"). For GitHub, transitions are `{ "running": "running", "landed": "landed" }`.
- **Checks:** multi-select from `scripts`, with the detected `checks` listed first. At least one is required. If `scripts` is empty, ask for the commands as text.
- **Workers and models:** workers at once (detected `waveCap` first), and the models for hard and routine tickets (detected first).
- **Branch prefix and save location:** the prefix (lowercase, not main or master), and where the profile lives: `files.home` (just you) or `files.repo` (`portia.config.ts`, committed and shared with the team).

When nothing was detected for checks, or the tracker is GitHub with no repo, ask about those even if the person chose "Use these".

## 4. Write

Write only the changed answers, as JSON with the same keys as `answers`, to a temporary file. Then run `portia init --yes --answers <file>`.

- If the target file in `files` already exists, ask before replacing it, and add `--force` only on a yes.
- Exit 0: tell the person where the profile was saved. If the tracker is Jira and `JIRA_BASE_URL`, `JIRA_EMAIL` or `JIRA_API_TOKEN` is unset, say they need exporting. Then say the next step is `/portia <EPIC>`.
- Exit 11: show the output, fix the answer it names with the person, and run it again.

Never write the profile file yourself. `portia init` renders and validates it.
