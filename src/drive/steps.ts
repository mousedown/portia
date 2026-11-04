import picomatch from "picomatch";
import type { Command } from "../cli/main";
import { PortiaProblem } from "../core/exit";
import { waitOf } from "../core/park";
import { spineResult } from "../core/signoff";
import { DECIDING } from "../core/state";
import type { ChildState, RunRow } from "../core/types";

/** What one Portia command printed and its exit code, run in this process. */
export interface Called {
	code: number;
	out: string[];
	err: string;
	/** The first line of its output that parses as JSON. */
	json?: Record<string, unknown>;
}

/**
 * Runs a Portia command in this process, as the orchestrator would from a shell. A
 * PortiaProblem is the command's exit 11, as `runCli` maps it; anything else is drive
 * breaking, and propagates so drive stops rather than retrying the step.
 */
export async function call(cmd: Command, args: string[]): Promise<Called> {
	const out: string[] = [];
	const err: string[] = [];
	const io = {
		out: (s: string) => out.push(s),
		err: (s: string) => err.push(s),
	};
	let code: number;
	try {
		code = await cmd(args, io);
	} catch (e) {
		if (!(e instanceof PortiaProblem)) throw e;
		err.push(e.message);
		code = 11;
	}
	return { code, out, err: err.join("\n"), json: firstJson(out) };
}

function firstJson(lines: string[]): Record<string, unknown> | undefined {
	for (const line of lines.flatMap((l) => l.split("\n"))) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		try {
			return JSON.parse(t) as Record<string, unknown>;
		} catch {}
	}
	return undefined;
}

/** A command's reason for a failure: its error, else its output. */
export const reasonOf = (c: Called): string =>
	(c.err || c.out.join("\n")).trim() || `exit ${c.code}`;

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The child's rows after its last deciding row (dispatch, result, land or landed). */
function sinceLastDecision(rows: RunRow[], child: string) {
	const mine = rows.filter((r) => r.child === child);
	let i = mine.length - 1;
	while (i >= 0 && !DECIDING.has((mine[i] as RunRow).stage)) i--;
	return { last: mine[i], after: i < 0 ? [] : mine.slice(i + 1) };
}

/** Files drive allows a parked child outside its touches, and the landed children owning them. */
export interface Grant {
	files: string[];
	owners: string[];
}

/** What a child needs next, from its state and its own rows. */
export type ChildNext =
	| { next: "land" }
	/** CI or GitHub failed its last land, not the child: land it again. */
	| { next: "reland" }
	| { next: "decide"; reason: string }
	/** Waits on a person's answer to this question. */
	| { next: "ask"; attempt: number; question: string }
	/** Every account is at its usage limit; nothing to do until one frees. */
	| { next: "limit"; text: string }
	/** The child review command broke, not the child: a person fixes it, then it lands again. */
	| { next: "broken"; reason: string }
	/** It claims its acceptance spec cannot pass as written: the spine amends it first. */
	| { next: "amend"; attempt: number; claim: OpenClaim }
	/**
	 * A fresh worker, with the person's answer when there is one. `grant` names files outside
	 * its touches that drive allows it before the dispatch: their owners have all landed.
	 */
	| { next: "restart"; note?: string; grant?: Grant }
	| { next: "none" };

/** A child's claim that its spec cannot pass, as its parked result recorded it. */
export interface OpenClaim {
	path: string;
	scenario: string;
	assertion: string;
	evidence: string;
	/** The last amendment row for this claim, while the amendment is under way. */
	amendment?: { status: string; head?: string };
}

const claimOf = (r: RunRow | undefined): OpenClaim | undefined => {
	const c = r?.stage === "result" ? r.data?.spec : undefined;
	if (!c || typeof c !== "object") return undefined;
	const o = c as Record<string, unknown>;
	return {
		path: str(o.path),
		scenario: str(o.scenario),
		assertion: str(o.assertion),
		evidence: str(o.evidence),
	};
};

/** What the redispatched child is told once its spec's amendment has landed. */
export const amendedNote = (claim: OpenClaim, landed: RunRow) =>
	`The acceptance spec ${claim.path} was amended on the integration branch (${str(landed.data?.commit).slice(0, 7)}) after your claim that it could not pass: ${claim.assertion}. Your worktree is rebased onto it. Make ${claim.scenario || "your scenario"} pass against the spec as it now stands, without editing it.`;

export interface Sibling {
	key: string;
	touches: string[];
}

const PATH_IN_TEXT = /(?:^|[\s`'"(<[])((?:[\w.-]+\/)+[\w.-]+)/g;

const names = (text: string, s: Sibling) => {
	if (text.includes(s.key)) return true;
	const theirs = picomatch(s.touches, { dot: true });
	return [...text.matchAll(PATH_IN_TEXT)].some((m) => !!m[1] && theirs(m[1]));
};

function inFlight(rows: RunRow[], key: string): boolean {
	const last = rows
		.filter((r) => r.child === key && DECIDING.has(r.stage))
		.at(-1);
	return (
		last?.stage === "dispatched" ||
		(last?.stage === "result" && last.status === "done")
	);
}

export const landedNote = (keys: string[]) =>
	`${keys.join(" and ")} landed after you were dispatched, and your worktree is rebased onto it. Check what you parked on again against the integration branch as it now stands; park again only if it still holds.`;

function settledBySibling(
	rows: RunRow[],
	child: string,
	last: RunRow,
	claim: boolean,
	siblings: Sibling[],
): ChildNext | undefined {
	const since = rows
		.filter(
			(r) =>
				r.child === child &&
				r.stage === "dispatched" &&
				r.attempt === last.attempt,
		)
		.at(-1)?.at;
	if (!since) return undefined;
	const text = str(last.data?.message);
	const landedAt = new Map(
		rows.filter((r) => r.stage === "landed").map((r) => [r.child, r.at]),
	);
	const named = siblings.filter((s) => s.key !== child && names(text, s));
	const fresh = (claim ? siblings : named).filter(
		(s) => s.key !== child && (landedAt.get(s.key) ?? "") > since,
	);
	if (fresh.length)
		return { next: "restart", note: landedNote(fresh.map((s) => s.key)) };
	if (named.some((s) => !landedAt.has(s.key) && inFlight(rows, s.key)))
		return { next: "none" };
	return undefined;
}

export const grantedNote = (files: string[], owners: string[]) =>
	`You may now edit ${files.join(" and ")}: ${owners.join(" and ")} ${owners.length > 1 ? "own it and have" : "owns it and has"} landed, so drive allowed it for you alone. Make only the change your scenario needs there, and touch nothing else outside your paths.`;

/** Paths a park's text names exactly: no globs, no URLs. */
const pathsIn = (text: string) => [
	...new Set(
		[...text.matchAll(PATH_IN_TEXT)]
			.map((m) => (m[1] ?? "").replace(/[.,;:]+$/, ""))
			.filter((p) => p && !/[*?{}[\]]/.test(p) && !p.includes("//")),
	),
];

/**
 * A park asking for a file outside the child's touches that only landed children own: no
 * one is left to collide with, and the file is inside the epic's declared paths, so drive
 * allows it for this child and sends it again rather than asking anyone. Each file once:
 * a park on a file already granted goes to the person. A grant recorded for this park
 * (a crash between the grant and the dispatch) goes again without granting anything.
 */
function grantedByDrive(
	rows: RunRow[],
	child: string,
	last: RunRow,
	siblings: Sibling[],
	sensitive: (file: string) => boolean,
): ChildNext | undefined {
	const grants = rows.filter((r) => r.child === child && r.stage === "grant");
	const pending = grants.find((r) => r.at > last.at);
	if (pending) {
		const files = (pending.data?.files as string[] | undefined) ?? [];
		const owners = (pending.data?.owners as string[] | undefined) ?? [];
		return { next: "restart", note: grantedNote(files, owners) };
	}
	const done = new Set(
		grants.flatMap((r) => (r.data?.files as string[] | undefined) ?? []),
	);
	const self = siblings.find((s) => s.key === child);
	const mine = picomatch(self?.touches ?? [], { dot: true });
	const landed = new Set(
		rows.filter((r) => r.stage === "landed").map((r) => r.child),
	);
	const others = siblings
		.filter((s) => s.key !== child)
		.map((s) => ({ key: s.key, has: picomatch(s.touches, { dot: true }) }));
	const files: string[] = [];
	const owners = new Set<string>();
	for (const file of pathsIn(str(last.data?.message))) {
		if (mine(file) || done.has(file) || sensitive(file)) continue;
		const by = others.filter((o) => o.has(file));
		if (!by.length || !by.every((o) => landed.has(o.key))) continue;
		files.push(file);
		for (const o of by) owners.add(o.key);
	}
	if (!files.length) return undefined;
	return {
		next: "restart",
		note: grantedNote(files, [...owners]),
		grant: { files, owners: [...owners] },
	};
}

/**
 * Routes a done, failed or parked child: done lands; a failed land CI or GitHub caused
 * lands again; any other failure is decided once, then retried or parked; a park waits on
 * its answer, and an answered one restarts with it. A park claiming its spec cannot pass
 * waits on the amendment instead, and restarts once it has landed (or the person answers).
 */
export function childNext(
	rows: RunRow[],
	child: string,
	state: ChildState | undefined,
	siblings: Sibling[] = [],
	opts: { sensitive?: (file: string) => boolean } = {},
): ChildNext {
	if (state === "done") return { next: "land" };
	if (state !== "failed" && state !== "parked") return { next: "none" };
	const { last, after } = sinceLastDecision(rows, child);
	if (last?.stage === "land" && last.data?.review === "error")
		return { next: "broken", reason: str(last.data?.reason) };
	if (state === "failed" && last?.stage === "land" && last.data?.infra === true)
		return { next: "reland" };
	const answer = after
		.filter(
			(r) =>
				r.stage === "decision" &&
				(r.data?.kind === "parked" ||
					(r.data?.kind === "park-answerable" && r.status === "answered")),
		)
		.at(-1);
	const claim = claimOf(last);
	if (
		!answer &&
		last?.stage === "result" &&
		last.status === "parked" &&
		!after.some((r) => r.stage === "amend")
	) {
		const settled = settledBySibling(rows, child, last, !!claim, siblings);
		if (settled) return settled;
		if (!claim) {
			const granted = grantedByDrive(
				rows,
				child,
				last,
				siblings,
				opts.sensitive ?? (() => false),
			);
			if (granted) return granted;
		}
	}
	if (claim && !answer) {
		const amends = after.filter((r) => r.stage === "amend");
		const landed = amends.find((r) => r.status === "landed");
		if (landed) return { next: "restart", note: amendedNote(claim, landed) };
		const at = amends.at(-1);
		return {
			next: "amend",
			attempt: last?.attempt ?? 0,
			claim: at
				? {
						...claim,
						amendment: {
							status: str(at.status),
							...(str(at.data?.head) ? { head: str(at.data?.head) } : {}),
						},
					}
				: claim,
		};
	}
	const wait = waitOf(rows.filter((r) => r.child === child));
	if (wait?.kind === "question")
		return { next: "ask", attempt: wait.attempt, question: wait.text };
	if (wait?.kind === "limit") return { next: "limit", text: wait.text };
	if (answer) return { next: "restart", note: str(answer.data?.answer) };
	if (state === "parked") return { next: "none" };
	const decided = after
		.filter((r) => r.stage === "decision" && r.data?.kind === "failure")
		.at(-1);
	if (decided?.status === "retry") return { next: "restart" };
	if (decided) return { next: "none" };
	return {
		next: "decide",
		reason:
			str(last?.stage === "result" ? last.data?.message : last?.data?.reason) ||
			`${child} failed`,
	};
}

/** Parks in a row on one head that drive answers from the script; the next goes to the person. */
export const PARK_REPEATS = 3;

/**
 * The child's parks in a row on one head, oldest first: its parked results back from the
 * last, while each is at the last one's head, stopping at a result that was not a park, a
 * landing, a person's answer or a landed spec amendment (each deserves its own tries). A
 * head that env up's rebase onto a sibling's landing moved (an `env` row `rebased`) is
 * the same head: the worker did no new work, only its base moved.
 */
export function parkRepeats(
	rows: RunRow[],
	child: string,
): { attempt: number; question: string }[] {
	const mine = rows.filter((x) => x.child === child);
	const rebased = new Map<string, string>();
	for (const r of mine)
		if (r.stage === "env" && r.status === "rebased" && str(r.data?.from))
			rebased.set(str(r.data?.from), str(r.data?.to));
	// The head a commit was carried to by every rebase since; a cycle cannot loop.
	const settled = (h: string) => {
		const seen = new Set<string>();
		while (rebased.has(h) && !seen.has(h)) {
			seen.add(h);
			h = rebased.get(h) as string;
		}
		return h;
	};
	const out: { attempt: number; question: string }[] = [];
	let head: string | undefined;
	for (const r of mine.reverse()) {
		if (r.stage === "landed") break;
		if (r.stage === "amend" && r.status === "landed") break;
		if (
			r.stage === "decision" &&
			r.data?.kind === "parked" &&
			r.data?.by === "person"
		)
			break;
		if (r.stage !== "result") continue;
		if (r.status !== "parked") break;
		const at = settled(str(r.data?.head));
		if (out.length && at !== head) break;
		head = at;
		out.push({ attempt: r.attempt, question: str(r.data?.message) });
	}
	return out.reverse();
}

/** Where the spine's specs stand: its last done result, and the sign-off recorded for that attempt. */
export type SpecsSignoff =
	| { signed: "none"; attempt: number; head: string }
	| { signed: "approved" }
	| { signed: "rejected"; note?: string };

export function specsSignoff(
	rows: RunRow[],
	spine: string,
): SpecsSignoff | undefined {
	const result = spineResult(rows, spine);
	if (!result) return undefined;
	const signed = rows
		.filter(
			(r) =>
				r.child === spine &&
				r.stage === "signoff" &&
				r.attempt === result.attempt,
		)
		.at(-1);
	if (signed?.status === "approved") return { signed: "approved" };
	if (signed?.status === "rejected")
		return { signed: "rejected", note: str(signed.data?.note) || undefined };
	return {
		signed: "none",
		attempt: result.attempt,
		head: str(result.data?.head),
	};
}

/**
 * Whether the plan has the person's yes: its last approval is a yes, or the run predates
 * approvals and has dispatched already.
 */
export function planApproved(rows: RunRow[], parent: string): boolean {
	const last = rows
		.filter((r) => r.child === parent && r.stage === "approval")
		.at(-1);
	if (last) return last.status === "approved";
	return rows.some((r) => r.stage === "dispatched");
}
