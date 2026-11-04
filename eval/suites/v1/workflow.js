export const meta = {
	name: "deliver-epic",
	description:
		"Deliver an epic: one agent per ticket in its own worktree, all at once, each gated on the repo's checks; then one agent merges every branch and fixes until the checks pass.",
	whenToUse:
		"An epic of several tickets, each with the paths it is expected to change, delivered onto the current branch.",
	phases: [
		{
			title: "Tickets",
			detail: "one agent per ticket, in parallel, each in its own worktree",
		},
		{
			title: "Merge",
			detail: "merge every ticket branch, fix until the repo's checks pass",
		},
	],
};

// The frozen claude-workflow script for suite v1: what a competent Claude Code user would
// write for an epic, before seeing any hidden spec. The harness passes the epic as `args`:
// { key, title, branch, scenarios: [{ id, text }], ticket, tickets: [{ key, touches, text }] },
// where `ticket` and each `text` are the tickets word for word as filed in the tracker.
// The repo's checks are enforced by the session's hooks, not by this script: an agent
// cannot finish while lint, typecheck or tests fail in its working copy.

const epic = typeof args === "string" ? JSON.parse(args) : args;

const scenarios = epic.scenarios.map((s) => `- ${s.id}: ${s.text}`).join("\n");

// Fenced as the harness fences tickets in every baseline's brief.
const fence = (key, text) =>
	`<ticket key="${key}">\n${text.trimEnd()}\n</ticket>`;
const epicTicket = fence(epic.key, epic.ticket);

const TICKET = {
	type: "object",
	properties: {
		branch: {
			type: "string",
			description: "the branch the work is committed on",
		},
		done: {
			type: "boolean",
			description: "the ticket is done and the checks pass",
		},
		scenarios: {
			type: "array",
			items: { type: "string" },
			description: "ids of the scenarios this change proves",
		},
		notes: { type: "string" },
	},
	required: ["branch", "done", "scenarios"],
};

phase("Tickets");
const tickets = await parallel(
	epic.tickets.map(
		(t) => () =>
			agent(
				`You are delivering ticket ${t.key}, part of the feature "${epic.title}" (${epic.key}) in this repository. Other tickets of the feature are being delivered at the same time by other agents in their own worktrees.

The feature's acceptance scenarios, for context:
${scenarios}

Your ticket is expected to change these paths: ${t.touches.join(", ")}.

The feature's ticket, then yours, word for word as they are filed in the tracker:

${epicTicket}

${fence(t.key, t.text)}

You are in your own git worktree: first create the branch ${epic.branch}/${t.key} from where you are (git checkout -b), and commit your work on it as you go. Follow the repository's own CLAUDE.md, lint, typecheck and tests, and add tests that prove the scenarios your ticket covers. Do not push. Stop when the ticket is done and the repository's checks pass, and report the branch, and which scenarios your change proves.`,
				{
					label: t.key,
					phase: "Tickets",
					isolation: "worktree",
					schema: TICKET,
				},
			),
	),
);

const landed = tickets
	.map((r, i) => ({ key: epic.tickets[i].key, r }))
	.filter((x) => x.r);
const lost = epic.tickets.length - landed.length;
if (lost)
	log(`${lost} ticket agents returned nothing; the merge agent is told which`);

phase("Merge");
const merged = await agent(
	`You are finishing the feature "${epic.title}" (${epic.key}) in this repository, on the current branch ${epic.branch}. Its tickets were delivered in parallel, each on its own branch:
${landed.map((x) => `- ${x.key}: branch ${x.r.branch}${x.r.done ? "" : " (its agent did not finish)"}${x.r.notes ? `. ${x.r.notes}` : ""}`).join("\n")}
${
	lost
		? `\nThese tickets have no branch because their agent failed: ${epic.tickets
				.filter((t) => !landed.some((x) => x.key === t.key))
				.map((t) => t.key)
				.join(", ")}. Deliver them yourself.\n`
		: ""
}
It is done when every one of these acceptance scenarios holds, with tests that prove it:
${scenarios}

The feature's ticket, then each child ticket, word for word as they are filed in the tracker:

${[epicTicket, ...epic.tickets.map((t) => fence(t.key, t.text))].join("\n\n")}

Merge every ticket branch into ${epic.branch}, resolving conflicts so that both sides' intent survives. Then run the repository's lint, typecheck and tests, and fix whatever fails, committing on ${epic.branch} as you go. Do not push. Stop when every scenario is covered and every check passes, and summarise what you merged and fixed.`,
	{ label: "merge", phase: "Merge" },
);

// The session's result is the merge agent's summary; the branch is what gets scored.
log(merged ?? "the merge agent returned nothing");
