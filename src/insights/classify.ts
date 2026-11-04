import type {
	CatchPoint,
	Cause,
	ParkKind,
	WastedAttempt,
} from "../core/causes";
import {
	DEFAULT_TEST_GLOBS,
	type RippleGlobs,
	rippleClassifier,
} from "../core/ripple";
import type { Run } from "../core/runs";
import { minutesSince } from "../core/signoff";
import type { RunRow } from "../core/types";

/** A wasted attempt, with the run log rows its cause was read from and, for a park, the answer given. */
export interface Classified extends WastedAttempt {
	rows: number[];
	/** The attempt whose failure wasted this one. */
	source: number;
	answer?: string;
}

interface Indexed {
	i: number;
	r: RunRow;
}

export const firstFailingStep = (r: RunRow): string => {
	const steps = Array.isArray(r.data?.steps)
		? (r.data.steps as { name?: unknown; ok?: unknown }[])
		: [];
	return String(steps.find((s) => s?.ok === false)?.name ?? "unknown");
};

const R6 = /^exit gate failed on the rebased head \(R6\): ([\w.:-]+)/;

function fromLand(land: Indexed): { cause: Cause; caught: CatchPoint } {
	const reason = String(land.r.data?.reason ?? "");
	const ci = /^(CI |no CI checks)/.test(reason);
	if (land.r.data?.infra === true)
		return { cause: { kind: "infra" }, caught: ci ? "ci" : "land" };
	const r6 = R6.exec(reason);
	if (r6?.[1])
		return {
			cause: { kind: "exit-gate-rebased", step: r6[1] },
			caught: "land",
		};
	if (/^rebasing .* conflicts/.test(reason))
		return { cause: { kind: "rebase-conflict" }, caught: "land" };
	if (/^CI failed on PR/.test(reason))
		return { cause: { kind: "ci", outcome: "failed" }, caught: "ci" };
	if (/^CI on PR .* still pending/.test(reason))
		return { cause: { kind: "ci", outcome: "timed-out" }, caught: "ci" };
	if (
		/changed after its gate|kept changing after its gate|^merge refused .*(head branch was modified|head commit|match-head-commit)/i.test(
			reason,
		)
	)
		return { cause: { kind: "changed-after-gate" }, caught: "land" };
	return { cause: { kind: "unknown", rows: [land.i] }, caught: "land" };
}

/** The globs used when no profile is at hand: the default test globs, no generated output. */
export const DEFAULT_RIPPLE_GLOBS: RippleGlobs = {
	tests: [...DEFAULT_TEST_GLOBS],
	generated: [],
};

/** What a parked result was on: a production file outside its touches, only test files, or a question. */
function parkKind(result: RunRow, globs: RippleGlobs): ParkKind {
	const outside = Array.isArray(result.data?.outside)
		? (result.data.outside as string[])
		: [];
	if (!outside.length) return "question";
	const kind = rippleClassifier(globs);
	return outside.some((f) => kind(f) === "production")
		? "production-ripple"
		: "test-ripple";
}

const DECIDES_PARK = new Set(["parked", "failure", "touches-mismatch"]);

/** Why the attempt dispatched at `window[0]` failed, from the rows up to the next dispatch. */
function failureOf(
	window: Indexed[],
	globs: RippleGlobs,
): {
	cause: Cause;
	caught: CatchPoint;
	rows: number[];
	answer?: string;
} {
	const land = window.filter((x) => x.r.stage === "land").at(-1);
	if (land) return { ...fromLand(land), rows: [land.i] };
	const result = window.find((x) => x.r.stage === "result");
	const decision = window.find(
		(x) =>
			x.r.stage === "decision" &&
			DECIDES_PARK.has(String(x.r.data?.kind ?? "")),
	);
	const gate = window
		.filter((x) => x.r.stage === "gate" && x.r.status === "fail")
		.at(-1);
	if (result?.r.status === "parked") {
		const answer =
			decision?.r.data?.kind === "parked" &&
			typeof decision.r.data.answer === "string"
				? decision.r.data.answer
				: undefined;
		return {
			cause: {
				kind: "parked",
				on: parkKind(result.r, globs),
				resolution: decision?.r.status ?? "redispatched",
			},
			caught: "child-gate",
			rows: [result.i, ...(decision ? [decision.i] : [])],
			...(answer === undefined ? {} : { answer }),
		};
	}
	if (gate)
		return {
			cause: { kind: "child-gate", step: firstFailingStep(gate.r) },
			caught: "child-gate",
			rows: [gate.i],
		};
	if (
		result?.r.status === "failed" &&
		decision?.r.data?.kind === "failure" &&
		decision.r.status === "park"
	)
		return {
			cause: { kind: "parked", on: "failure", resolution: "redispatched" },
			caught: "child-gate",
			rows: [result.i, decision.i],
		};
	const rows = (result ? [result] : window.slice(0, 1)).map((x) => x.i);
	return { cause: { kind: "unknown", rows }, caught: "child-gate", rows };
}

/**
 * Every attempt `runMetrics` counts as rework (a retry, or an attempt whose land failed and
 * never landed), each with one cause: a retry takes the failure of the attempt before it.
 */
export function wastedAttempts(
	run: Run,
	globs: RippleGlobs = DEFAULT_RIPPLE_GLOBS,
): Classified[] {
	const out: Classified[] = [];
	const all = run.rows.map((r, i) => ({ i, r }));
	for (const c of run.plan.children) {
		const mine = all.filter((x) => x.r.child === c.key);
		const landed = mine.find((x) => x.r.stage === "landed")?.r;
		const dispatches = mine.filter((x) => x.r.stage === "dispatched");
		const windows = dispatches.map((d, n) => {
			const next = dispatches[n + 1]?.i ?? Number.POSITIVE_INFINITY;
			return mine.filter((x) => x.i >= d.i && x.i < next);
		});
		dispatches.forEach((d, n) => {
			const attempt = d.r.attempt;
			const landedHere = landed?.attempt === attempt;
			const ownLandFailed = mine.some(
				(x) =>
					x.r.stage === "land" &&
					x.r.status === "failed" &&
					x.r.data?.infra !== true &&
					x.r.attempt === attempt,
			);
			if (!(attempt > 1 || (ownLandFailed && !landedHere))) return;
			const result = mine.find(
				(x) => x.r.stage === "result" && x.r.attempt === attempt,
			)?.r;
			const end = result?.at ?? (landedHere && landed ? landed.at : "");
			const prior = attempt > 1 ? windows[n - 1] : windows[n];
			const failure = prior
				? failureOf(prior, globs)
				: {
						cause: { kind: "unknown", rows: [d.i] } as Cause,
						caught: "child-gate" as CatchPoint,
						rows: [d.i],
					};
			out.push({
				run: run.key,
				child: c.key,
				attempt,
				tokens: result?.tokens ?? 0,
				minutes: end ? minutesSince(d.r.at, end) : 0,
				cause: failure.cause,
				caught: failure.caught,
				rows: failure.rows,
				source: prior?.[0]?.r.attempt ?? attempt,
				...("answer" in failure && failure.answer !== undefined
					? { answer: failure.answer }
					: {}),
			});
		});
	}
	return out;
}
