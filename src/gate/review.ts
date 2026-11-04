import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildReviewSpec, Profile } from "../core/config";
import { type Exec, type ExecResult, must } from "../core/exec";
import { PLAN_FILE } from "../core/plan-snapshot";
import { appendRow, readRows } from "../core/runlog";
import type { WorkerEnv } from "../env/env";
import { parsePlanSnapshot } from "../view/model/snapshot";
import { gateVars, tail } from "./run";

export interface ReviewFinding {
	severity?: string;
	message: string;
	file?: string;
	line?: number;
}
export type ReviewStatus = "clean" | "findings" | "error";
export interface ReviewVerdict {
	status: ReviewStatus;
	exit: number;
	timedOut?: boolean;
	findings: ReviewFinding[];
	tail: string;
}

const MAX_FINDINGS = 50;
const str = (v: unknown) =>
	typeof v === "string" && v.trim() ? v.trim() : undefined;

function finding(v: unknown): ReviewFinding | undefined {
	if (typeof v === "string") return str(v) ? { message: v.trim() } : undefined;
	if (!v || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	const message =
		str(o.message) ?? str(o.title) ?? str(o.body) ?? str(o.summary);
	if (!message) return undefined;
	const severity = str(o.severity) ?? str(o.level) ?? str(o.priority);
	const file = str(o.file) ?? str(o.path);
	const line = Number(o.line);
	return {
		message: message.slice(0, 500),
		...(severity ? { severity } : {}),
		...(file ? { file } : {}),
		...(Number.isInteger(line) && line > 0 ? { line } : {}),
	};
}

function findingsIn(text: string): ReviewFinding[] | undefined {
	try {
		const o = JSON.parse(text) as { findings?: unknown };
		if (!o || typeof o !== "object" || !Array.isArray(o.findings))
			return undefined;
		return o.findings
			.map(finding)
			.filter((f): f is ReviewFinding => f !== undefined);
	} catch {
		return undefined;
	}
}

/**
 * The findings a review printed: its whole stdout as one JSON object with a `findings`
 * array, else the last stdout line that is one. Undefined when it printed none.
 */
export function parseFindings(stdout: string): ReviewFinding[] | undefined {
	const whole = findingsIn(stdout.trim());
	if (whole) return whole;
	const lines = stdout.split("\n").map((l) => l.trim());
	for (const l of lines.reverse())
		if (l.startsWith("{") && l.endsWith("}")) {
			const found = findingsIn(l);
			if (found) return found;
		}
	return undefined;
}

/** The exit code decides: 0 clean, 1 findings, anything else an error. JSON only describes. */
export function verdictOf(r: ExecResult): ReviewVerdict {
	const status: ReviewStatus = r.timedOut
		? "error"
		: r.code === 0
			? "clean"
			: r.code === 1
				? "findings"
				: "error";
	return {
		status,
		exit: r.code,
		...(r.timedOut ? { timedOut: true } : {}),
		findings: (parseFindings(r.stdout) ?? []).slice(0, MAX_FINDINGS),
		tail: tail(`${r.stdout}\n${r.stderr}`),
	};
}

const findingLine = (f: ReviewFinding) =>
	`- ${f.severity ? `[${f.severity}] ` : ""}${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.message}`;

/** About the R6 reason's cap: the reason is logged, printed, briefed and passed as one argument. */
const MAX_REASON = 2_000;

function findingLines(findings: ReviewFinding[]): string {
	const out: string[] = [];
	let size = 0;
	for (const f of findings) {
		const l = findingLine(f);
		if (size + l.length > MAX_REASON) break;
		out.push(l);
		size += l.length + 1;
	}
	const more = findings.length - out.length;
	return [...out, ...(more ? [`(+${more} more)`] : [])].join("\n");
}

/**
 * What a verdict does to the land: nothing when clean; findings fail it (or park it, as
 * the profile says) with the findings in the reason, which the next brief carries; an
 * error parks it, since a retried worker cannot fix the review command. `review` says
 * which, so the skill can land again once a person has fixed the command.
 */
export function reviewOutcome(
	v: ReviewVerdict,
	spec: Pick<ChildReviewSpec, "onFindings" | "timeoutMs">,
	head: string,
):
	| {
			status: "parked" | "failed";
			reason: string;
			review: "findings" | "error";
	  }
	| undefined {
	const at = head.slice(0, 7);
	const out = v.tail.slice(-MAX_REASON);
	if (v.status === "clean") return undefined;
	if (v.status === "error")
		return {
			status: "parked",
			review: "error",
			reason: `${v.timedOut ? `the child review timed out after ${spec.timeoutMs}ms` : `the child review could not run (exit ${v.exit})`} at ${at}\n${out}`,
		};
	const n = v.findings.length;
	return {
		status: spec.onFindings === "park" ? "parked" : "failed",
		review: "findings",
		reason: n
			? `the child review found ${n} finding${n === 1 ? "" : "s"} at ${at}\n${findingLines(v.findings)}`
			: `the child review found findings at ${at}\n${out}`,
	};
}

/**
 * The child's ticket and plan block, and its acceptance specs as `<id> <path>` lines, from
 * the plan snapshot: what the plan says, never what the worker said about its work.
 */
function planInput(dir: string, child: string) {
	try {
		const plan = parsePlanSnapshot(
			readFileSync(join(dir, PLAN_FILE), "utf8"),
		)?.plan;
		const mine = plan?.children.find((c) => c.key === child);
		if (!plan || !mine) return { block: undefined, specs: "" };
		const specs = mine.requirements.flatMap((id) =>
			plan.children
				.filter((c) => c.acceptance[id])
				.map((c) => `${id} ${c.acceptance[id]}`),
		);
		return {
			block: JSON.stringify(
				{ ticket: { key: mine.key, summary: mine.summary }, plan: mine },
				null,
				"\t",
			),
			specs: [...new Set(specs)].join("\n"),
		};
	} catch {
		return { block: undefined, specs: "" };
	}
}

/**
 * Runs the profile's child review in the child's worktree against `base..head`, the
 * head that passed the exit gate, and records the verdict in the run log.
 */
export async function reviewChild(ctx: {
	exec: Exec;
	profile: Profile;
	spec: ChildReviewSpec;
	dir: string;
	env: WorkerEnv;
	child: string;
	parent: string;
	base: string;
	head: string;
}): Promise<ReviewVerdict> {
	const { exec, env } = ctx;
	const diff = join(ctx.dir, `review-${ctx.child}.diff`);
	writeFileSync(
		diff,
		await must(exec, "git", ["diff", `${ctx.base}..${ctx.head}`], {
			cwd: env.worktree,
		}),
	);
	const input = planInput(ctx.dir, ctx.child);
	const planFile = join(ctx.dir, `review-${ctx.child}.plan.json`);
	if (input.block) writeFileSync(planFile, input.block);
	const ripples = readRows(ctx.dir)
		.rows.filter((x) => x.child === ctx.child && x.stage === "result")
		.at(-1)?.ripples;
	const r = await exec("sh", ["-c", ctx.spec.cmd], {
		cwd: env.worktree,
		env: {
			...gateVars(ctx.profile, env.envFile),
			PORTIA_BASE_SHA: ctx.base,
			PORTIA_HEAD_SHA: ctx.head,
			PORTIA_DIFF: diff,
			PORTIA_CHILD: ctx.child,
			PORTIA_PARENT: ctx.parent,
			PORTIA_WORKTREE: env.worktree,
			PORTIA_PLAN: input.block ? planFile : "",
			PORTIA_SPECS: input.specs,
			PORTIA_RIPPLES: (ripples ?? [])
				.map((x) => `${x.kind} ${x.file}`)
				.join("\n"),
		},
		timeoutMs: ctx.spec.timeoutMs,
		// Room for a whole-output findings object; the last line is kept either way.
		keepTail: 1024 * 1024,
	});
	const v = verdictOf(r);
	appendRow(ctx.dir, {
		child: ctx.child,
		attempt:
			readRows(ctx.dir)
				.rows.filter((x) => x.child === ctx.child && x.stage === "dispatched")
				.at(-1)?.attempt ?? 0,
		stage: "review",
		status: v.status,
		data: {
			base: ctx.base,
			head: ctx.head,
			exit: v.exit,
			...(v.timedOut ? { timedOut: true } : {}),
			findings: v.findings,
		},
	});
	return v;
}
