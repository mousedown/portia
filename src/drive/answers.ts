import { join } from "node:path";
import { evalAnswerCommand } from "../cli/commands/eval-answer";
import { PLAN_FILE } from "../core/plan-snapshot";
import { type Called, call, reasonOf } from "./steps";

/**
 * A scripted answer from PORTIA_EVAL_ANSWERS, applied through `portia eval-answer`, which
 * records it as the person's would be: `none` when the script is unset or has no answer
 * here (the stop stands), `no` when it answers no.
 */
export type Scripted =
	| { answered: "yes"; detail: string }
	| { answered: "none" }
	| { answered: "no"; reason: string };

function scripted(c: Called, detail: string): Scripted {
	if (c.code === 10) return { answered: "none" };
	if (c.code === 0) return { answered: "yes", detail };
	return { answered: "no", reason: reasonOf(c) };
}

/** The plan's yes, signed against the plan as the run directory recorded it. */
export const scriptPlan = async (parent: string, dir: string) =>
	scripted(
		await call(evalAnswerCommand, [
			"plan",
			parent,
			"--from",
			join(dir, PLAN_FILE),
		]),
		"the plan approved by the script",
	);

export const scriptSpecs = async (parent: string, spine: string) =>
	scripted(
		await call(evalAnswerCommand, ["specs", parent, "--child", spine]),
		"the specs signed off by the script",
	);

export const scriptQuestions = async (parent: string) =>
	scripted(
		await call(evalAnswerCommand, ["questions", parent]),
		"the questions answered by the script",
	);

export async function scriptPark(
	parent: string,
	child: string,
	question: string,
): Promise<Scripted> {
	const c = await call(evalAnswerCommand, [
		"parked",
		child,
		"--parent",
		parent,
		"--question",
		question,
	]);
	return scripted(c, `answered by the script: ${String(c.json?.answer ?? "")}`);
}
