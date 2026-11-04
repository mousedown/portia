/** Why an attempt was wasted. Every wasted attempt falls into exactly one. */
export const CAUSES = [
	"child-gate",
	"exit-gate-rebased",
	"rebase-conflict",
	"ci",
	"changed-after-gate",
	"parked",
	"infra",
	"unknown",
] as const;
export type CauseKind = (typeof CAUSES)[number];

/** Where a failure was caught, from earliest to latest. */
export const CATCH_POINTS = [
	"child-gate",
	"land",
	"ci",
	"wave-gate",
	"epic-gate",
	"after-main",
] as const;
export type CatchPoint = (typeof CATCH_POINTS)[number];

/** What a park was on: a question, a failure, or files outside the child's touches by kind. */
export const PARK_KINDS = [
	"test-ripple",
	"production-ripple",
	"question",
	"failure",
] as const;
export type ParkKind = (typeof PARK_KINDS)[number];

export type Cause =
	/** A gate on the child's own head failed, at its first failing step. */
	| { kind: "child-gate"; step: string }
	/** The exit gate on the head rebased onto the integration branch failed (R6). */
	| { kind: "exit-gate-rebased"; step: string }
	| { kind: "rebase-conflict" }
	| { kind: "ci"; outcome: "failed" | "timed-out" }
	| { kind: "changed-after-gate" }
	| {
			kind: "parked";
			on: ParkKind;
			/** How the park was resolved, when a decision row says. */
			resolution?: string;
	  }
	/** Not the child's fault: shown, but kept out of rework. */
	| { kind: "infra" }
	/** No bucket fits: the indexes of the run log rows it came from, so the buckets can grow. */
	| { kind: "unknown"; rows: number[] };

export interface WastedAttempt {
	run: string;
	child: string;
	attempt: number;
	tokens: number;
	minutes: number;
	cause: Cause;
	caught: CatchPoint;
}

/** One cause across runs. `step` is set for the gate causes, which are counted by step. */
export interface CauseTotal {
	kind: CauseKind;
	step?: string;
	count: number;
	tokens: number;
	minutes: number;
	/** How many runs it appeared in. */
	runs: number;
}
