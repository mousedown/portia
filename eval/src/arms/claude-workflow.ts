import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { git } from "../metrics/git";
import type { Arm, ArmContext } from ".";
import { childTicket, claudeCommand, claudeSession } from "./claude";

/** The saved workflow's name, so the session runs it as `/deliver-epic`. */
export const WORKFLOW = "deliver-epic";

/**
 * Claude Code's dynamic workflows with gating hooks: the strongest native rival. The suite's
 * frozen `workflow.js`, saved as a personal workflow in the run's clean config, fans out one
 * agent per ticket, each in its own worktree, then a final agent merges the branches and
 * fixes what fails. A hook on `TaskCompleted` and `SubagentStop` runs the repo's checks in
 * the finishing agent's working copy and blocks it (exit 2, the failures fed back) while
 * any fail, up to the suite's `reviews` times per agent. A workflow takes no input once it
 * starts, so no decision reaches a person.
 */
export const claudeWorkflow: Arm = {
	name: "claude-workflow",
	description:
		"Claude Code running the suite's frozen workflow script: one agent per ticket in its own worktree in parallel, each blocked by a hook until the repo's checks pass, then one agent that merges and fixes until they pass.",
	async run(ctx) {
		const branch = `eval/${ctx.epic.key}/claude-workflow`;
		await git(ctx.clone, ["checkout", "-b", branch]);
		const dir = join(ctx.artifacts, "workflow");
		mkdirSync(dir, { recursive: true });
		const script = installWorkflow(ctx, dir);
		const settings = gateSettings(ctx, dir);
		const s = await claudeSession(ctx, {
			cwd: ctx.clone,
			prompt: workflowPrompt(ctx, branch),
			name: "session",
			allow: [`Workflow(${WORKFLOW})`],
			settings,
			env: {
				// Workflow agents take the session's model; this makes sure nothing else does.
				CLAUDE_CODE_SUBAGENT_MODEL: ctx.model,
			},
		});
		const gate = gateLog(join(dir, "gate.jsonl"));
		ctx.log(
			`claude-workflow: script ${script.slice(0, 12)}, gate ran ${gate.runs} times, blocked ${gate.blocks}`,
		);
		return {
			exitCode: s.exitCode,
			stoppedBy: s.stoppedBy,
			branch,
			branchesToMerge: 1,
			partial: {
				cost: {
					tokens: s.tokens,
					tokensByModel: s.tokensByModel,
					usd: s.usd,
					wallMinutes: s.minutes,
					workMinutes: s.minutes,
				},
				// Each block sent an agent back to its work: an attempt after the first.
				rework: {
					retries: gate.blocks,
					failedLands: 0,
					tokenShare: 0,
					minuteShare: 0,
				},
				human: { decisions: 0, waitingMinutes: 0 },
			},
		};
	},
};

/**
 * The epic as the script's `args`: the arm's only input to the frozen script. It carries
 * the epic's ticket and each child's in full, as every baseline's brief does.
 */
export function workflowArgs(ctx: ArmContext, branch: string) {
	return {
		key: ctx.epic.key,
		title: ctx.epic.title,
		branch,
		scenarios: ctx.epic.scenarios,
		ticket: ctx.tickets.epic,
		tickets: ctx.epic.children.map((c) => ({
			...c,
			text: childTicket(ctx, c.key),
		})),
	};
}

export function workflowPrompt(ctx: ArmContext, branch: string): string {
	return `/${WORKFLOW} ${JSON.stringify(workflowArgs(ctx, branch))}`;
}

/**
 * Saves the suite's frozen script (beside `person.json`) as a personal workflow in the run's
 * clean config, and keeps a copy and its hash with the run, so a result names the exact
 * script it ran.
 */
export function installWorkflow(ctx: ArmContext, dir: string): string {
	const source = join(dirname(ctx.person), "workflow.js");
	if (!existsSync(source)) throw new Error(`no workflow script at ${source}`);
	const { configDir } = claudeCommand(ctx, {});
	mkdirSync(join(configDir, "workflows"), { recursive: true });
	copyFileSync(source, join(configDir, "workflows", `${WORKFLOW}.js`));
	copyFileSync(source, join(dir, "workflow.js"));
	const sha = createHash("sha256").update(readFileSync(source)).digest("hex");
	writeFileSync(join(dir, "workflow.sha256"), `${sha}\n`);
	return sha;
}

/**
 * The gate a competent user would add: when a task or subagent finishes, run the repo's
 * checks where it worked, and while any fail, exit 2 with the failures so it keeps going.
 * After `reviews` blocks an agent is let go, as the baselines' review loop is. Read-only
 * helper agents are not gated: they cannot fix anything. Every run is logged to
 * `gate.jsonl`, which is where the arm's rework comes from.
 */
export function gateSettings(ctx: ArmContext, dir: string): string {
	const gate = join(dir, "gate.js");
	writeFileSync(
		gate,
		`// Written by the eval harness: see gateSettings in eval/src/arms/claude-workflow.ts.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const CHECKS = ${JSON.stringify(ctx.repo.checks)};
const MAX = ${ctx.limits.reviews};
const LOG = ${JSON.stringify(join(dir, "gate.jsonl"))};
const input = JSON.parse((await Bun.stdin.text()) || "{}");
const who = input.agent_id ?? input.task_id ?? input.session_id ?? "session";
if (["Explore", "Plan"].includes(input.agent_type)) process.exit(0);
const rows = existsSync(LOG)
	? readFileSync(LOG, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l))
	: [];
const blocked = rows.filter((r) => r.who === who && r.blocked).length;
const cwd = input.cwd ?? process.cwd();
const failed = [];
for (const check of CHECKS) {
	const p = Bun.spawnSync(["sh", "-c", check], { cwd, stdout: "pipe", stderr: "pipe" });
	if (p.exitCode) failed.push({ check, output: (p.stdout.toString() + p.stderr.toString()).slice(-4000) });
}
const block = failed.length > 0 && blocked < MAX;
appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), event: input.hook_event_name, who, cwd, failed: failed.map((f) => f.check), blocked: block }) + "\\n");
if (block) {
	process.stderr.write("The repository's checks fail in " + cwd + ". Fix the cause, commit, and finish again.\\n\\n" + failed.map((f) => "$ " + f.check + "\\n" + f.output).join("\\n\\n"));
	process.exit(2);
}
`,
	);
	chmodSync(gate, 0o755);
	const hook = [{ hooks: [{ type: "command", command: `bun '${gate}'` }] }];
	const settings = join(dir, "settings.json");
	writeFileSync(
		settings,
		`${JSON.stringify({ hooks: { TaskCompleted: hook, SubagentStop: hook } }, null, "\t")}\n`,
	);
	return settings;
}

export function gateLog(file: string): { runs: number; blocks: number } {
	if (!existsSync(file)) return { runs: 0, blocks: 0 };
	const rows = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as { blocked?: boolean }];
			} catch {
				return [];
			}
		});
	return { runs: rows.length, blocks: rows.filter((r) => r.blocked).length };
}
