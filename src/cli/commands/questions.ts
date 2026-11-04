import { readFileSync } from "node:fs";
import { ticketText } from "../../brief/render";
import { EXIT, PortiaProblem } from "../../core/exit";
import { runPath } from "../../core/rundir";
import { readRows } from "../../core/runlog";
import { closedOutsideRun, landedKeys, startedIn } from "../../core/state";
import { extractBlock } from "../../plan/block";
import { check } from "../../plan/check";
import {
	answerQuestions,
	collectQuestions,
	type Question,
	recordQuestions,
	unanswered,
} from "../../questions/questions";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

const show = (qs: Question[]) =>
	JSON.stringify(
		unanswered(qs).map(({ answer: _, ...q }) => q),
		null,
		2,
	);

/**
 * Collects every open question about the plan into the run dir and prints the unanswered
 * ones: exit 0 when there are none, 11 when the person must answer them. Prints [] and
 * records nothing unless the profile sets askOnce.
 */
export const questionsCommand: Command = async (args, io) => {
	const key = args[0]?.toUpperCase();
	if (!key) throw new PortiaProblem("usage: portia questions <PARENT>");
	const { profile, tracker } = await cliContext();
	if (!profile.askOnce) {
		io.out("[]");
		return EXIT.OK;
	}
	const { plan, files, findings, dir } = await loadForCli(key);
	const rows = readRows(dir).rows;
	const shut = closedOutsideRun(plan, rows);
	const landed = landedKeys(rows);
	const all = [
		...findings,
		...check(plan, files, shut, profile.maxSize, undefined, undefined, [
			...startedIn(rows),
		]),
	];
	const issues = [
		await tracker.issue(plan.key),
		...(await tracker.children(plan.key)),
	];
	const tickets: Record<string, string> = {};
	const blocks: Record<string, string> = {};
	for (const i of issues) {
		tickets[i.key] = ticketText(i.description);
		blocks[i.key] = extractBlock(i.description) ?? "";
	}
	const open = plan.children.filter(
		(c) => !shut.includes(c.key) && !landed.has(c.key),
	);
	const qs = recordQuestions(
		dir,
		collectQuestions(
			{ ...plan, children: open },
			{ tickets, blocks, files, findings: all },
		),
	);
	io.out(show(qs));
	return unanswered(qs).length ? EXIT.PROBLEM : EXIT.OK;
};

/** Records answers from a JSON file of `{ "<id>": "<answer>" }`, then prints what is still unanswered. */
export const answerCommand: Command = async (args, io) => {
	const key = args[0]?.toUpperCase();
	const from = flag(args, "--from");
	if (!key || !from)
		throw new PortiaProblem("usage: portia answer <PARENT> --from <file>");
	let answers: unknown;
	try {
		answers = JSON.parse(readFileSync(from, "utf8"));
	} catch (e) {
		throw new PortiaProblem(
			`could not read ${from}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!answers || typeof answers !== "object" || Array.isArray(answers))
		throw new PortiaProblem(`${from} must hold { "<id>": "<answer>" }`);
	const qs = answerQuestions(runPath(key), answers as Record<string, string>);
	io.out(show(qs));
	return unanswered(qs).length ? EXIT.PROBLEM : EXIT.OK;
};
