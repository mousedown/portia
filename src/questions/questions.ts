import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { writeFileAtomic } from "../core/atomic";
import { PortiaProblem } from "../core/exit";
import type { Finding, ParentPlan } from "../core/types";

export type QuestionKind = "open" | "detail" | "touches" | "warning";
/** One thing to ask the person before wave 0; `child` is absent for the epic as a whole. */
export interface Question {
	id: string;
	child?: string;
	kind: QuestionKind;
	question: string;
	answer?: string;
}

/** A touches glob matching more files than this is too broad to be sure of. */
const BROAD = 100;
const HEADING = /^(?:#{1,6}\s*)?(?:open\s+)?questions:?\s*$/i;
const ITEM = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * The items under a "Questions" (or "Open questions") heading: list items, or lines ending
 * in "?". The list ends at the first other line.
 */
export function ticketQuestions(text: string): string[] {
	const lines = text.split("\n").map((l) => l.trim());
	const start = lines.findIndex((l) => HEADING.test(l));
	if (start < 0) return [];
	const out: string[] = [];
	for (const l of lines.slice(start + 1)) {
		if (!l) continue;
		if (ITEM.test(l)) out.push(l.replace(ITEM, "").trim());
		else if (!l.startsWith("#") && l.endsWith("?")) out.push(l);
		else break;
	}
	return out.filter(Boolean);
}

/** A plan block's "?" lines, which the block parser skips. */
export const blockQuestions = (block: string): string[] =>
	block
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith("?"))
		.map((l) => l.slice(1).trim())
		.filter(Boolean);

const SKIPPED: Finding["rule"][] = ["unplanned", "closed"];

export function collectQuestions(
	plan: ParentPlan,
	input: {
		/** Each ticket's text without its plan block, by key. */
		tickets: Record<string, string>;
		/** Each ticket's plan block, by key. */
		blocks: Record<string, string>;
		files: string[];
		findings: Finding[];
	},
): Question[] {
	const warnings = input.findings.filter(
		(f) => f.level === "warn" && !SKIPPED.includes(f.rule),
	);
	const open = (key: string, child?: string): Question[] =>
		[
			...ticketQuestions(input.tickets[key] ?? ""),
			...blockQuestions(input.blocks[key] ?? ""),
		].map((question, i) => ({
			id: `${key}/open-${i + 1}`,
			child,
			kind: "open",
			question,
		}));
	const warned = (key: string, child?: string): Question[] =>
		warnings
			.filter((f) => f.child === child)
			.map((f, i) => ({
				id: `${key}/warn-${i + 1}`,
				child,
				kind: "warning",
				question: `${f.message}. The run goes ahead with the plan as written: anything the worker should know? (To change the plan, stop and edit it first.)`,
			}));
	const out = [...open(plan.key), ...warned(plan.key)];
	for (const c of plan.children) {
		out.push(...open(c.key, c.key));
		if (!(input.tickets[c.key] ?? "").trim())
			out.push({
				id: `${c.key}/detail`,
				child: c.key,
				kind: "detail",
				question: `${c.key} (${c.summary}) says nothing beyond its plan block: what must it do, and what proves it done besides \`${c.evidence}\`?`,
			});
		const counts = c.touches.map((g) => {
			const m = picomatch(g, { dot: true });
			return { g, n: input.files.filter((f) => m(f)).length };
		});
		const missing = counts.filter((x) => x.n === 0).map((x) => x.g);
		const broad = counts.filter((x) => x.n > BROAD).map((x) => x.g);
		if (missing.length)
			out.push({
				id: `${c.key}/touches-missing`,
				child: c.key,
				kind: "touches",
				question: `${c.key} touches ${missing.join(", ")}, matching no file in the repo: new files, or a wrong path?`,
			});
		if (broad.length)
			out.push({
				id: `${c.key}/touches-broad`,
				child: c.key,
				kind: "touches",
				question: `${c.key} touches ${broad.join(", ")}, each matching over ${BROAD} files: which paths does it really change?`,
			});
		out.push(...warned(c.key, c.key));
	}
	return out;
}

const file = (dir: string) => join(dir, "questions.json");

/** The run's questions, or undefined when `portia questions` has not run. */
export function readQuestions(dir: string): Question[] | undefined {
	const f = file(dir);
	return existsSync(f)
		? (JSON.parse(readFileSync(f, "utf8")) as Question[])
		: undefined;
}

const write = (dir: string, qs: Question[]) =>
	writeFileAtomic(file(dir), `${JSON.stringify(qs, null, "\t")}\n`);

/** Replaces the run's questions, keeping each answer whose question is unchanged. */
export function recordQuestions(dir: string, fresh: Question[]): Question[] {
	const old = new Map((readQuestions(dir) ?? []).map((q) => [q.id, q]));
	const all = fresh.map((q) => {
		const prev = old.get(q.id);
		return prev?.answer && prev.question === q.question
			? { ...q, answer: prev.answer }
			: q;
	});
	write(dir, all);
	return all;
}

export function answerQuestions(
	dir: string,
	answers: Record<string, string>,
): Question[] {
	const qs = readQuestions(dir);
	if (!qs)
		throw new PortiaProblem(
			"no questions recorded: run portia questions first",
		);
	const unknown = Object.keys(answers).filter(
		(id) => !qs.some((q) => q.id === id),
	);
	if (unknown.length)
		throw new PortiaProblem(`no question with the id ${unknown.join(", ")}`);
	const blank = Object.entries(answers)
		.filter(([, a]) => typeof a !== "string" || !a.trim())
		.map(([id]) => id);
	if (blank.length)
		throw new PortiaProblem(`an answer must be text: ${blank.join(", ")}`);
	const all = qs.map((q) =>
		answers[q.id] ? { ...q, answer: answers[q.id]?.trim() } : q,
	);
	write(dir, all);
	return all;
}

export const unanswered = (qs: Question[]): Question[] =>
	qs.filter((q) => !q.answer);

/** With askOnce, why dispatch must wait: the questions were never collected, or some are unanswered. */
export function questionsWaiting(
	askOnce: boolean,
	dir: string,
	parent: string,
): string | undefined {
	if (!askOnce) return undefined;
	const qs = readQuestions(dir);
	if (!qs)
		return `run portia questions ${parent} before dispatching (the profile sets askOnce)`;
	const open = unanswered(qs);
	return open.length
		? `${open.length} question(s) unanswered: ${open.map((q) => q.id).join(", ")}; record them with portia answer ${parent} --from <file>`
		: undefined;
}

/** The brief's section of answers for `key`: its own and the epic's. Empty when there are none. */
export function answersSection(qs: Question[], key: string): string {
	const mine = qs.filter((q) => q.answer && (!q.child || q.child === key));
	return mine.length
		? `\n## Answers from the person\n\nAsked before the run started; do not ask them again.\n\n${mine.map((q) => `- ${q.question} Answer: ${q.answer}`).join("\n")}\n`
		: "";
}
