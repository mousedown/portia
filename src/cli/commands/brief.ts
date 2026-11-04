import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	briefVars,
	environmentSection,
	fill,
	scenarioTickets,
	ticketText,
} from "../../brief/render";
import { EXIT, PortiaProblem } from "../../core/exit";
import { nextAttempt, previousAttempt, readRows } from "../../core/runlog";
import { readEnv } from "../../env/env";
import { answersSection, readQuestions } from "../../questions/questions";
import { workerPaths } from "../../worker/detached";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

const TEMPLATE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"skills/portia/worker-brief.md",
);

export const briefCommand: Command = async (args, io) => {
	const key = args[0]?.toUpperCase();
	const parent = flag(args, "--parent")?.toUpperCase();
	if (!key || !parent)
		throw new PortiaProblem("usage: portia brief <KEY> --parent <PARENT>");
	const { profile } = await cliContext();
	const loaded = await loadForCli(parent);
	const { dir } = loaded;
	io.out(
		await renderBrief(
			key,
			parent,
			profile.workers.mode === "detached"
				? workerPaths(dir, key, nextAttempt(readRows(dir).rows, key) - 1).result
				: undefined,
			loaded,
		),
	);
	return EXIT.OK;
};

/**
 * The worker's whole prompt; a detached worker also writes its result to `resultFile`.
 * `loaded` is the caller's own loadForCli of `parent`, so the plan is not fetched twice.
 */
export async function renderBrief(
	key: string,
	parent: string,
	resultFile?: string,
	loaded?: Pick<
		Awaited<ReturnType<typeof loadForCli>>,
		"plan" | "dir" | "issues"
	>,
): Promise<string> {
	const { plan, dir, issues } = loaded ?? (await loadForCli(parent));
	const c = plan.children.find((x) => x.key === key);
	if (!c) throw new PortiaProblem(`${key} is not a child of ${parent}`);
	const { profile, profileFile, tracker } = await cliContext();
	const issue = issues.find((i) => i.key === key) ?? (await tracker.issue(key));
	const description = ticketText(issue.description);
	const env = readEnv(dir, key);
	// A worktree env up could not bring onto the integration tip says so, and why.
	const notes = [...profile.briefNotes, ...(env.behind ? [env.behind] : [])];
	return fill(
		readFileSync(TEMPLATE, "utf8"),
		briefVars(
			plan,
			c,
			env,
			description,
			profile.design.personas,
			previousAttempt(readRows(dir).rows, key),
			environmentSection(notes, profileFile),
			answersSection(readQuestions(dir) ?? [], key),
			resultFile,
			scenarioTickets(plan, c, issues),
		),
	);
}
