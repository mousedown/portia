import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parkedAnswer, readEvalAnswers } from "../../src/core/eval-answers";

const PERSON = {
	description: "The scripted person every arm gets.",
	plan: { approve: true },
	signoff: { approve: true },
	parked: {
		default: "Yes. Add the file to your paths and carry on.",
		byPattern: [
			{
				match: "secret|credential|token|password",
				answer: "No. Leave that out.",
			},
		],
	},
};

const file = (body: unknown) => {
	const f = join(mkdtempSync(join(tmpdir(), "portia-")), "person.json");
	writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
	return f;
};

it("unset means no script", () => {
	expect(readEvalAnswers({})).toBeUndefined();
});

it("reads the eval suite's person file", () => {
	expect(readEvalAnswers({ PORTIA_EVAL_ANSWERS: file(PERSON) })).toEqual(
		PERSON,
	);
	expect(
		readEvalAnswers({
			PORTIA_EVAL_ANSWERS: file({ plan: { approve: false } }),
		}),
	).toEqual({ plan: { approve: false } });
});

it("fails loudly on a missing, malformed or invalid file", () => {
	expect(() =>
		readEvalAnswers({ PORTIA_EVAL_ANSWERS: "/no/such/person.json" }),
	).toThrow(/could not read/);
	expect(() => readEvalAnswers({ PORTIA_EVAL_ANSWERS: file("{") })).toThrow(
		/could not read/,
	);
	expect(() =>
		readEvalAnswers({
			PORTIA_EVAL_ANSWERS: file({ plan: { approve: "yes" } }),
		}),
	).toThrow(/plan\.approve/);
	expect(() =>
		readEvalAnswers({
			PORTIA_EVAL_ANSWERS: file({
				parked: { default: "x", byPattern: [{ match: "(", answer: "y" }] },
			}),
		}),
	).toThrow(/parked\.byPattern\.0\.match: not a valid regex/);
});

it("answers a parked question by the first matching pattern, else the default", () => {
	const parked = PERSON.parked;
	expect(parkedAnswer(parked, "Which API TOKEN should it use?")).toBe(
		"No. Leave that out.",
	);
	expect(parkedAnswer(parked, "May I edit src/registry.ts?")).toBe(
		parked.default,
	);
});
