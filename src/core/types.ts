export type ReqId = string;
export type Tier = "high" | "standard";
/** A light child skips the gate steps marked for the full lane; its tier is its block's either way. */
export type Lane = "light" | "full";
export interface Need {
	key: string;
	reason: string;
}
export interface ChildPlan {
	key: string;
	summary: string;
	wave: number;
	needs: Need[];
	touches: string[];
	requirements: ReqId[];
	evidence: string;
	tier: Tier;
	/** Set in the block; otherwise derived by laneOf. */
	lane?: Lane;
	design?: string;
	size?: string;
	acceptance: Record<ReqId, string>;
	/**
	 * The spine's hook modules: each path a stub it scaffolds where one child's feature plugs
	 * into another's code, with what the stub holds. The child whose touches hold it fills it.
	 */
	hooks?: Record<string, string>;
	blockedBy: string[];
}
export interface Scenario {
	id: ReqId;
	text: string;
}
export interface ParentPlan {
	key: string;
	summary: string;
	scope: string;
	scenarios: Scenario[];
	children: ChildPlan[];
	/** Keys outside the run that some child needs and the tracker shows as done: met. */
	satisfied?: string[];
	/** Planned children the tracker shows as done: never dispatched, met unless landed. */
	closed?: string[];
}
export type Rule =
	| "completeness"
	| "coverage"
	| "graph"
	| "overlap"
	| "spine"
	| "size"
	| "parse"
	| "unplanned"
	| "excluded"
	| "closed"
	| "lane"
	| "ripple"
	| "coupling"
	| "specs"
	| "hook";
/**
 * What a file outside a child's touches is: a test-only file (spec, fixture, test setup),
 * generated output, or production code. Test and generated ripples may ride along with the
 * child; a production file is a scope question for the person.
 */
export type RippleKind = "test" | "generated" | "production";
export interface Ripple {
	file: string;
	kind: RippleKind;
}
export interface Finding {
	rule: Rule;
	level: "error" | "warn" | "info";
	child?: string;
	message: string;
}
export type ChildState =
	| "pending"
	| "ready"
	| "running"
	| "parked"
	| "failed"
	| "done"
	| "landed"
	| "closed";
export type GateStatus = "pass" | "fail";
export interface WorkerResult {
	child: string;
	status: "done" | "parked" | "failed";
	head: string;
	gates: { task: GateStatus; exit: GateStatus };
	evidence: Record<ReqId, string>;
	question?: string;
	/** Suggested answers to `question`, when it has real alternatives. */
	options?: string[];
	/** Which of `options` the worker recommends. */
	recommended?: number;
	reason?: string;
	/** Set when the child claims an acceptance spec it owns cannot pass as written. */
	spec?: SpecClaim;
}
/**
 * A worker's claim that its own acceptance spec cannot pass whatever the implementation: the
 * spec's path, the assertion, and the evidence (a command and what it showed).
 */
export interface SpecClaim {
	path: string;
	assertion: string;
	evidence: string;
}
export type Stage =
	| "dispatched"
	| "result"
	| "landed"
	| "land"
	| "tracker"
	| "decision"
	| "env"
	| "gate"
	| "review"
	| "epic"
	| "wave-gate"
	| "approval"
	| "signoff"
	/** The spec-amendment path: a child's claim that its acceptance spec cannot pass, settled. */
	| "amend"
	/** Drive allowed a parked child files outside its touches whose owners have all landed. */
	| "grant";
export interface RunRow {
	at: string;
	child: string;
	attempt: number;
	stage: Stage;
	status?: string;
	model?: { requested: string; actual?: string };
	touchesMatched?: boolean;
	/** On a result row: the files changed outside the child's touches that were accepted, by kind. */
	ripples?: Ripple[];
	tokens?: number;
	data?: Record<string, unknown>;
}
