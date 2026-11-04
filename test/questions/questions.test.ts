import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortiaProblem } from "../../src/core/exit";
import { BlockError, parseChild } from "../../src/plan/block";
import {
	answerQuestions,
	answersSection,
	blockQuestions,
	collectQuestions,
	questionsWaiting,
	readQuestions,
	recordQuestions,
	ticketQuestions,
	unanswered,
} from "../../src/questions/questions";
import { child, parent, spine } from "../helpers/plan";

const dir = () => mkdtempSync(join(tmpdir(), "portia-questions-"));

describe("ticketQuestions", () => {
	it("reads the items under a Questions heading, in Markdown or as Jira text", () => {
		expect(
			ticketQuestions(
				"Build it.\n\n## Questions\n\n- Which page shows it?\n- Do admins see it\n\n## Notes\n- not a question",
			),
		).toEqual(["Which page shows it?", "Do admins see it"]);
		expect(
			ticketQuestions(
				"Build it.\nOpen questions\nWhich page shows it?\nIs it behind a flag?\nThe end.",
			),
		).toEqual(["Which page shows it?", "Is it behind a flag?"]);
	});
	it("finds none without the heading", () => {
		expect(ticketQuestions("What does it do? Nobody knows.")).toEqual([]);
	});
});

describe("blockQuestions", () => {
	it("reads '?' lines, which the block parser skips only when asked to", () => {
		const block =
			"wave: 1\n? should the badge show on mobile: yes or no\ntouches: src/a/**\nrequirements: F1\nevidence: bun test a";
		expect(blockQuestions(block)).toEqual([
			"should the badge show on mobile: yes or no",
		]);
		const raw = {
			key: "ACME-2",
			summary: "s",
			description: `\`\`\`plan\n${block}\n\`\`\``,
			blockedBy: [],
		};
		const c = parseChild(raw, ["src"], ".", { questions: true });
		expect(c.touches).toEqual(["src/a/**"]);
		expect(() => parseChild(raw, ["src"], ".")).toThrow(BlockError);
	});
});

describe("collectQuestions", () => {
	const plan = parent([
		spine({ touches: ["src/lib/**"] }),
		child("ACME-2", { touches: ["src/a/**", "src/new/thing.ts"] }),
		child("ACME-3", { touches: ["src/**"] }),
	]);
	const files = [
		"src/lib/x.ts",
		"src/a/one.ts",
		...Array.from({ length: 120 }, (_, i) => `src/b/${i}.ts`),
	];
	const tickets = {
		"ACME-0": "The epic.\n\nQuestions\n- Who signs it off?",
		"ACME-1": "The contract.",
		"ACME-2": "",
		"ACME-3": "Wide.",
	};
	const blocks = { "ACME-0": "scope: x", "ACME-1": "? new table or a column" };

	it("asks for detail, missing and broad touches, warnings and open questions", () => {
		const qs = collectQuestions(plan, {
			tickets,
			blocks,
			files,
			findings: [
				{
					rule: "graph",
					level: "warn",
					child: "ACME-3",
					message: "ACME-3 needs ACME-1 without a reason",
				},
				{ rule: "unplanned", level: "warn", message: "not in this run: X" },
				{ rule: "size", level: "error", message: "an error, never asked" },
			],
		});
		expect(qs.map((q) => [q.id, q.child, q.kind])).toEqual([
			["ACME-0/open-1", undefined, "open"],
			["ACME-1/open-1", "ACME-1", "open"],
			["ACME-2/detail", "ACME-2", "detail"],
			["ACME-2/touches-missing", "ACME-2", "touches"],
			["ACME-3/touches-broad", "ACME-3", "touches"],
			["ACME-3/warn-1", "ACME-3", "warning"],
		]);
		expect(qs[0]?.question).toBe("Who signs it off?");
		expect(qs[3]?.question).toContain("src/new/thing.ts");
		expect(qs[5]?.question).toContain("without a reason");
	});

	it("asks nothing of a well-described plan", () => {
		expect(
			collectQuestions(parent([spine({ touches: ["src/lib/**"] })]), {
				tickets: { "ACME-0": "Epic.", "ACME-1": "Spine." },
				blocks: {},
				files,
				findings: [],
			}),
		).toEqual([]);
	});
});

describe("the questions file", () => {
	const q = (id: string, question = id) => ({
		id,
		kind: "open" as const,
		question,
	});

	it("keeps an answer while its question is unchanged, and drops it when it changes", () => {
		const d = dir();
		expect(readQuestions(d)).toBeUndefined();
		recordQuestions(d, [q("A"), q("B")]);
		answerQuestions(d, { A: "yes", B: "no" });
		const again = recordQuestions(d, [q("A"), q("B", "B changed"), q("C")]);
		expect(again.map((x) => x.answer)).toEqual(["yes", undefined, undefined]);
		expect(unanswered(again).map((x) => x.id)).toEqual(["B", "C"]);
	});

	it("refuses an unknown id, an empty answer, and answering before any questions", () => {
		const d = dir();
		expect(() => answerQuestions(d, { A: "x" })).toThrow(PortiaProblem);
		recordQuestions(d, [q("A")]);
		expect(() => answerQuestions(d, { Z: "x" })).toThrow(/Z/);
		expect(() => answerQuestions(d, { A: " " })).toThrow(PortiaProblem);
	});

	it("puts a child's answers and the epic's into its brief section", () => {
		const qs = [
			{ ...q("E", "Who signs it off?"), answer: "the lead" },
			{ ...q("A", "Which page?"), child: "ACME-2", answer: "settings" },
			{ ...q("B", "Other child?"), child: "ACME-3", answer: "no" },
			{ ...q("C", "Unanswered?"), child: "ACME-2" },
		];
		const s = answersSection(qs, "ACME-2");
		expect(s).toContain("## Answers from the person");
		expect(s).toContain("- Who signs it off? Answer: the lead");
		expect(s).toContain("- Which page? Answer: settings");
		expect(s).not.toContain("Other child?");
		expect(s).not.toContain("Unanswered?");
		expect(answersSection([], "ACME-2")).toBe("");
		expect(answersSection(qs, "ACME-9")).toContain("Who signs it off?");
	});
});

describe("questionsWaiting", () => {
	it("is silent without askOnce, and says why dispatch waits with it", () => {
		const d = dir();
		expect(questionsWaiting(false, d, "ACME-0")).toBeUndefined();
		expect(questionsWaiting(true, d, "ACME-0")).toContain(
			"run portia questions ACME-0",
		);
		recordQuestions(d, [{ id: "A", kind: "open", question: "A?" }]);
		expect(questionsWaiting(true, d, "ACME-0")).toContain(
			"1 question(s) unanswered: A",
		);
		answerQuestions(d, { A: "yes" });
		expect(questionsWaiting(true, d, "ACME-0")).toBeUndefined();
	});
});
