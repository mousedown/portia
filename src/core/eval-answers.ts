import { readFileSync } from "node:fs";
import { z } from "zod";
import { PortiaProblem } from "./exit";

const validRegex = (s: string) => {
	try {
		new RegExp(s, "i");
		return true;
	} catch {
		return false;
	}
};

/**
 * The scripted person a headless eval run answers from: the plan's approval, the spec
 * sign-off, and parked questions by pattern. A section left out is asked as usual.
 */
const EvalAnswers = z.object({
	description: z.string().optional(),
	plan: z.object({ approve: z.boolean() }).optional(),
	signoff: z.object({ approve: z.boolean() }).optional(),
	parked: z
		.object({
			default: z.string().trim().min(1),
			byPattern: z
				.array(
					z.object({
						match: z.string().min(1).refine(validRegex, "not a valid regex"),
						answer: z.string().trim().min(1),
					}),
				)
				.default([]),
		})
		.optional(),
});
export type EvalAnswers = z.infer<typeof EvalAnswers>;

/** The script PORTIA_EVAL_ANSWERS names, or undefined when it is unset. A bad file is a problem, never ignored. */
export function readEvalAnswers(
	env: Record<string, string | undefined> = process.env,
): EvalAnswers | undefined {
	const file = env.PORTIA_EVAL_ANSWERS;
	if (!file) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new PortiaProblem(
			`PORTIA_EVAL_ANSWERS: could not read ${file}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	const parsed = EvalAnswers.safeParse(raw);
	if (!parsed.success)
		throw new PortiaProblem(
			`PORTIA_EVAL_ANSWERS: ${file} is not a valid answers file:\n${parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`,
		);
	return parsed.data;
}

/** The first pattern matching the question (case-insensitive) answers it, else the default. */
export function parkedAnswer(
	parked: NonNullable<EvalAnswers["parked"]>,
	question: string,
): string {
	return (
		parked.byPattern.find((p) => new RegExp(p.match, "i").test(question))
			?.answer ?? parked.default
	);
}
