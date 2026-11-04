import type { ChildPlan, Scenario } from "../core/types";
import { normaliseGlob } from "./paths";

export class BlockError extends Error {}
export interface RawIssue {
	key: string;
	summary: string;
	description: string;
	blockedBy: string[];
}

/** `plan` is the fence; `portia` still parses so tickets written before the rename keep working. */
const FENCE = /```(?:plan|portia)[ \t]*\n([\s\S]*?)\n```/g;
/** A whole plan block with its trailing newline, for stripping it from a brief. */
export const PLAN_BLOCK = /```(?:plan|portia)[ \t]*\n[\s\S]*?\n```\n?/g;
const CHILD_KEYS = new Set([
	"wave",
	"needs",
	"touches",
	"requirements",
	"evidence",
	"tier",
	"lane",
	"design",
	"size",
	"acceptance",
	"hook",
]);
const list = (v: string) =>
	v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

/** `text` with every plan block removed and exactly one, holding `block`, at the end. */
export function withPlanBlock(text: string, block: string): string {
	const rest = text.replace(PLAN_BLOCK, "").trimEnd();
	const fenced = `\`\`\`plan\n${block.trimEnd()}\n\`\`\`\n`;
	return rest ? `${rest}\n\n${fenced}` : fenced;
}

export function extractBlock(text: string): string | null {
	const all = [...text.matchAll(FENCE)];
	return all.length ? (all[all.length - 1]?.[1] ?? null) : null;
}

interface Line {
	key: string;
	value: string;
	comment: string;
	/** The trimmed source line, for error messages. */
	line: string;
}
/** With `questions`, a "?" line is an open question for the person (see src/questions), not a key. */
export interface BlockOptions {
	questions?: boolean;
}
function lines(key: string, block: string, opts: BlockOptions): Line[] {
	return block
		.split("\n")
		.map((l) => l.trim())
		.filter(
			(l) => l && !l.startsWith("#") && !(opts.questions && l.startsWith("?")),
		)
		.map((l) => {
			const i = l.indexOf(":");
			if (i < 0)
				throw new BlockError(`${key}: not a 'key: value' line: "${l}"`);
			let value = l.slice(i + 1).trim();
			const hash = value.indexOf(" #");
			const comment = hash >= 0 ? value.slice(hash + 2).trim() : "";
			if (hash >= 0) value = value.slice(0, hash).trim();
			return { key: l.slice(0, i).trim(), value, comment, line: l };
		});
}

function blockOf(raw: RawIssue): string {
	const block = extractBlock(raw.description);
	if (block === null)
		throw new BlockError(`${raw.key}: no plan block in the description`);
	return block;
}

/**
 * A scenario id is a name and nothing more: gate steps put it unquoted into `sh -c` through
 * `{ownedGrep}`, and a plan block is ticket text that anyone who can edit the ticket can write.
 */
const SCENARIO_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
function scenarioId(key: string, id: string): string {
	if (!SCENARIO_ID.test(id))
		throw new BlockError(
			`${key}: scenario id '${id}' must be a letter then letters, digits, - or _`,
		);
	return id;
}

export function parseChild(
	raw: RawIssue,
	topLevel: string[],
	packageDir: string,
	opts: BlockOptions = {},
): ChildPlan {
	const c: ChildPlan = {
		key: raw.key,
		summary: raw.summary,
		wave: Number.NaN,
		needs: [],
		touches: [],
		requirements: [],
		evidence: "",
		tier: "standard",
		acceptance: {},
		blockedBy: raw.blockedBy,
	};
	for (const { key, value, comment, line } of lines(
		raw.key,
		blockOf(raw),
		opts,
	)) {
		if (!CHILD_KEYS.has(key))
			throw new BlockError(`${raw.key}: unknown key '${key}'`);
		if (key === "wave") {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 0)
				throw new BlockError(
					`${raw.key}: wave must be a whole number, got '${value}'`,
				);
			c.wave = n;
		} else if (key === "needs") {
			// One key per line: a second key, or one after a comma in the reason, would be dropped.
			const keys = value.split(/[\s,]+/).filter(Boolean);
			if (keys.length > 1 || /,\s*[A-Za-z][A-Za-z0-9]*-\d+\b/.test(comment))
				throw new BlockError(
					`${raw.key}: a needs line names one key, one line per need: "${line}"`,
				);
			const [k] = keys;
			if (k) c.needs.push({ key: k.toUpperCase(), reason: comment });
		} else if (key === "touches") {
			c.touches.push(
				...list(value).map((g) => normaliseGlob(g, topLevel, packageDir)),
			);
		} else if (key === "requirements") {
			c.requirements.push(...list(value).map((id) => scenarioId(raw.key, id)));
		} else if (key === "evidence") {
			c.evidence = value;
		} else if (key === "tier") {
			if (value !== "high" && value !== "standard")
				throw new BlockError(`${raw.key}: tier must be high or standard`);
			c.tier = value;
		} else if (key === "lane") {
			if (value !== "light" && value !== "full")
				throw new BlockError(`${raw.key}: lane must be light or full`);
			c.lane = value;
		} else if (key === "design") {
			c.design = value;
		} else if (key === "size") {
			c.size = value.toUpperCase();
		} else if (key === "hook") {
			if (!value || list(value).length > 1)
				throw new BlockError(
					`${raw.key}: a hook line names one file, then '# what the stub holds': "${line}"`,
				);
			c.hooks = {
				...c.hooks,
				[normaliseGlob(value, topLevel, packageDir)]: comment,
			};
		} else {
			const [id, path] = value.split("=").map((s) => s.trim());
			if (!id || !path)
				throw new BlockError(`${raw.key}: acceptance must read 'F1 = path'`);
			c.acceptance[scenarioId(raw.key, id)] = normaliseGlob(
				path,
				topLevel,
				packageDir,
			);
		}
	}
	if (Number.isNaN(c.wave)) throw new BlockError(`${raw.key}: missing wave`);
	return c;
}

export function parseParent(
	raw: RawIssue,
	opts: BlockOptions = {},
): {
	key: string;
	summary: string;
	scope: string;
	scenarios: Scenario[];
} {
	let scope = "";
	const scenarios: Scenario[] = [];
	for (const { key, value } of lines(raw.key, blockOf(raw), opts)) {
		if (key === "scope") scope = value;
		else if (key === "scenario") {
			const eq = value.indexOf("=");
			if (eq < 0)
				throw new BlockError(`${raw.key}: scenario must read 'F1 = text'`);
			scenarios.push({
				id: scenarioId(raw.key, value.slice(0, eq).trim()),
				text: value.slice(eq + 1).trim(),
			});
		} else throw new BlockError(`${raw.key}: unknown parent key '${key}'`);
	}
	if (!scope)
		throw new BlockError(
			`${raw.key}: parent block needs a scope (the PR title scope)`,
		);
	return { key: raw.key, summary: raw.summary, scope, scenarios };
}
