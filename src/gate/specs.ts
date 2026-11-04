import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../core/exec";
import type { ReqId } from "../core/types";
import type { OwnedScenario } from "../plan/owned";

/** Every spine spec, by scenario id, and the scenarios this child implements. */
export interface SpecGuard {
	specs: Record<ReqId, string>;
	owns: ReqId[];
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const QUOTES = new Set(['"', "'", "`"]);

/** The index just past the string literal opening at `i`, `${…}` in a template included. */
function skipString(src: string, i: number): number {
	const q = src[i];
	for (let j = i + 1; j < src.length; j++) {
		const ch = src[j];
		if (ch === "\\") j++;
		else if (ch === q) return j + 1;
		else if (q === "`" && ch === "$" && src[j + 1] === "{")
			j = skipBalanced(src, j + 1) - 1;
	}
	return src.length;
}

/** The index just past the bracket that closes the one at `i`, skipping strings and comments. */
function skipBalanced(src: string, i: number): number {
	const stack: string[] = [];
	for (let j = i; j < src.length; j++) {
		const ch = src[j] ?? "";
		if (QUOTES.has(ch)) {
			j = skipString(src, j) - 1;
			continue;
		}
		if (src.startsWith("//", j) || src.startsWith("/*", j)) {
			const end = src.indexOf(src[j + 1] === "/" ? "\n" : "*/", j + 2);
			if (end < 0) return src.length;
			j = end;
			continue;
		}
		const close = OPEN[ch];
		if (close) stack.push(close);
		else if (ch === stack.at(-1)) {
			stack.pop();
			if (!stack.length) return j + 1;
		}
	}
	return src.length;
}

const skipSpace = (src: string, i: number) => {
	while (/\s/.test(src[i] ?? "")) i++;
	return i;
};

/** A test(...), it(...) or describe(...) call: its extent, callee, and where a literal title starts. */
interface Call {
	start: number;
	end: number;
	callee: string;
	title?: number;
}

const CALL = /\b(x?(?:test|it|describe))((?:\.\w+)*)\s*/g;
const MARKER = /^x|\.(?:skip|only|fixme|todo)\b/;
const isMarker = (c: Call) => MARKER.test(c.callee);
const encloses = (a: Call, b: Call) => a.start <= b.start && b.end <= a.end;

/**
 * Every test, it or describe call in `src`, modifiers and an `x` prefix included.
 * A parameterised call's title is in its second call: `it.each([...])("F1: …")`,
 * or a tagged table, test.each`…`("F1: …").
 */
function calls(src: string): Call[] {
	const out: Call[] = [];
	for (const m of src.matchAll(CALL)) {
		let i = m.index + m[0].length;
		if (/\.each\b/.test(m[2] ?? "")) {
			if (src[i] === "<") i = src.indexOf(">", i) + 1 || src.length;
			if (src[i] === "(") i = skipBalanced(src, i);
			else if (src[i] === "`") i = skipString(src, i);
			else continue;
			i = skipSpace(src, i);
		}
		if (src[i] !== "(") continue;
		const t = skipSpace(src, i + 1);
		out.push({
			start: m.index,
			end: skipBalanced(src, i),
			callee: `${m[1]}${m[2]}`,
			title: QUOTES.has(src[t] ?? "") ? t + 1 : undefined,
		});
	}
	return out;
}

const titled = (src: string, cs: Call[], id: ReqId) =>
	cs.filter((c) => c.title !== undefined && src.startsWith(`${id}:`, c.title));

/**
 * Whether `src` has a test(...), it(...) or describe(...) call, modifiers included
 * (`it.only`, `test.concurrent`), whose title (any quote) starts with `<id>:`.
 */
export const titledWith = (src: string, id: ReqId) =>
	titled(src, calls(src), id).length > 0;

/**
 * The markers that skip or focus scenario `id`: a titled marked call around it (its
 * own included) or inside it, or an untitled one (`test.skip()`, `test.fixme(cond)`)
 * inside the innermost titled call that holds it, or at the top of the file.
 */
function marks(src: string, cs: Call[], id: ReqId): string[] {
	const own = titled(src, cs, id);
	const group = (c: Call) =>
		cs.filter((g) => g !== c && g.title !== undefined && encloses(g, c)).at(-1);
	const hit = cs.filter((c) => {
		if (!isMarker(c)) return false;
		if (c.title !== undefined)
			return own.some((o) => encloses(c, o) || encloses(o, c));
		const g = group(c);
		return !g || own.some((o) => encloses(g, o) || encloses(o, g));
	});
	return [...new Set(hit.map((c) => c.callee))];
}

/** A scenario's calls as text, with markers and whitespace removed, to compare. */
const body = (src: string, cs: Call[], id: ReqId) =>
	titled(src, cs, id)
		.map((c) => src.slice(c.start, c.end))
		.join("\n")
		.replace(/\bx(test|it|describe)\b/g, "$1")
		.replace(/\.(?:skip|only|fixme|todo)\b/g, "")
		.replace(/\s+/g, "");

/**
 * The title convention the spine writes and `{ownedGrep}` selects on: a test(...) or
 * describe(...) title that starts with the scenario id and a colon, e.g. `test("F2: …")`,
 * `test.describe('F2: …')` or `it.each([...])("F2: …")`. Returns one line per owned id
 * that its spec file, read from the worktree, does not title that way (or a missing spec).
 */
export function untitledScenarios(
	worktree: string,
	owned: OwnedScenario[],
): string[] {
	return owned.flatMap(({ id, path }) => {
		const file = join(worktree, path);
		const src = existsSync(file) ? readFileSync(file, "utf8") : "";
		return titledWith(src, id)
			? []
			: [`spec ${path} has no test titled with ${id}`];
	});
}

/**
 * What a child's change to spine spec `path` (`before` at its base, `after` now,
 * undefined when absent) does to the scenarios in it that it does not own. A change
 * confined to its own scenarios passes, as does removing a marker; a `.only` anywhere
 * fails while the file holds another child's scenario, since it stops that one running.
 */
export function specChanges(
	path: string,
	before: string | undefined,
	after: string | undefined,
	ids: ReqId[],
	owns: ReqId[],
): string[] {
	if (before === undefined) return [];
	const was = calls(before);
	const foreign = ids.filter(
		(id) => !owns.includes(id) && titled(before, was, id).length,
	);
	if (!foreign.length) return [];
	const theirs = (id: ReqId) => `${id} is another child's scenario`;
	if (after === undefined)
		return [
			`spec ${path} was deleted; it holds ${foreign.join(", ")}, another child's scenario: restore it`,
		];
	const now = calls(after);
	const only = (cs: Call[]) =>
		cs.filter((c) => /\.only\b/.test(c.callee)).map((c) => c.callee);
	const onlyBefore = only(was);
	const added = only(now).filter((c) => {
		const i = onlyBefore.indexOf(c);
		if (i < 0) return true;
		onlyBefore.splice(i, 1);
		return false;
	});
	const problems = [...new Set(added)].map(
		(c) =>
			`spec ${path} adds ${c}, which stops ${foreign.join(", ")} (another child's scenario) from running: remove it`,
	);
	for (const id of foreign) {
		if (!titled(after, now, id).length) {
			problems.push(
				`spec ${path} no longer has a test titled with ${id}; ${theirs(id)}: restore it`,
			);
			continue;
		}
		const prior = marks(before, was, id);
		const fresh = marks(after, now, id).filter(
			(m) => !prior.includes(m) && !/\.only\b/.test(m),
		);
		if (fresh.length)
			problems.push(
				`spec ${path} marks ${id} ${fresh.join(", ")}; ${theirs(id)}: remove the marker`,
			);
		else if (body(before, was, id) !== body(after, now, id))
			problems.push(
				`spec ${path} changes the test titled with ${id}; ${theirs(id)}: revert it`,
			);
	}
	return problems;
}

/**
 * The spec-integrity check of the exit gate: each spine spec holding a scenario this
 * child does not own, in the worktree, against the merge base with `base`. A failing
 * merge-base fails the step (fail closed).
 */
export async function specStep(
	exec: Exec,
	worktree: string,
	base: string,
	guard: SpecGuard,
): Promise<{ name: string; ok: boolean; tail: string }> {
	const mb = await exec("git", ["merge-base", base, "HEAD"], {
		cwd: worktree,
	});
	const at = mb.stdout.trim();
	if (mb.code !== 0 || !at)
		return {
			name: "specs",
			ok: false,
			tail: `git merge-base ${base} HEAD: ${mb.stderr.trim()}`,
		};
	const byPath = new Map<string, ReqId[]>();
	for (const [id, path] of Object.entries(guard.specs))
		byPath.set(path, [...(byPath.get(path) ?? []), id]);
	const problems: string[] = [];
	for (const [path, ids] of byPath) {
		if (ids.every((id) => guard.owns.includes(id))) continue;
		const shown = await exec("git", ["show", `${at}:${path}`], {
			cwd: worktree,
			env: { LC_ALL: "C" },
		});
		if (
			shown.code !== 0 &&
			!/does not exist|exists on disk, but not in/.test(shown.stderr)
		) {
			problems.push(`git show ${at}:${path}: ${shown.stderr.trim()}`);
			continue;
		}
		const file = join(worktree, path);
		problems.push(
			...specChanges(
				path,
				shown.code === 0 ? shown.stdout : undefined,
				existsSync(file) ? readFileSync(file, "utf8") : undefined,
				ids,
				guard.owns,
			),
		);
	}
	return { name: "specs", ok: !problems.length, tail: problems.join("\n") };
}

/**
 * The epic gate's check before acceptance runs: one line per planned scenario its
 * spec, read from `root`, no longer titles, or skips or focuses.
 */
export function scenarioProblems(
	root: string,
	scenarios: OwnedScenario[],
): string[] {
	return scenarios.flatMap(({ id, path }) => {
		const file = join(root, path);
		const src = existsSync(file) ? readFileSync(file, "utf8") : "";
		const cs = calls(src);
		if (!titled(src, cs, id).length)
			return [`spec ${path} has no test titled with ${id}`];
		const m = marks(src, cs, id);
		return m.length ? [`spec ${path} marks ${id} ${m.join(", ")}`] : [];
	});
}

/**
 * How many assertions scenario `id`'s tests in `src` make: each `expect` call (or `assert`
 * call) in its titled calls. An amendment may move or reword one, never drop one.
 */
export function assertionCount(src: string, id: ReqId): number {
	return (
		titled(src, calls(src), id)
			.map((c) => src.slice(c.start, c.end))
			.join("\n")
			.match(/\b(?:expect|assert)(?:\.\w+)*\s*\(/g)?.length ?? 0
	);
}
