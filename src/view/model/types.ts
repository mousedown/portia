import type { RunMetrics } from "../../core/metrics";
import type { Wait } from "../../core/park";
import type { ChildState, ParentPlan, RunRow } from "../../core/types";
import type { WorkerView } from "./worker";

export type Source = "plan" | "ledger" | "runlog" | "empty";
/** `waiting`: a child waits on the person's answer to a question. */
export type Group = "waiting" | "session" | "judgement" | "rest" | "delivered";
export type RunGlyph =
	| "running"
	| "parked"
	| "failed"
	| "quiet"
	| "done"
	| "ready"
	| "landed"
	| "empty"
	| "delivered";
export type Phase =
	| "working"
	| "fixing"
	| "exit gate"
	| "reporting"
	| "quiet"
	| "landing";

export type TextRole =
	| "ink"
	| "ink2"
	| "dim"
	| "faint"
	| "rule"
	| "accent"
	| "accentBright"
	/** Amber: a machine figure past its warning threshold, always after a ▲. */
	| "warn";
export type StateRole = ChildState | "quiet";
export type Role = TextRole | StateRole;

export type EventGlyph =
	| "dispatched"
	| "envUp"
	| "envDown"
	| "pass"
	| "fail"
	| "result"
	| "parked"
	| "accept"
	| "retry"
	| "epic";

export interface Step {
	name: string;
	ok: boolean | null;
}
export interface GateRun {
	at: string;
	kind: "task" | "exit" | "epic";
	pass: boolean;
	steps: Step[];
}
export interface Phrase {
	glyph: EventGlyph;
	label: string;
	detail: string;
	/** A shorter detail for narrow layouts. */
	short?: string;
	/** A gate's steps with short labels, before falling back to `short`. */
	compact?: string;
	/** Appended to the detail only when it fits. */
	extra?: string;
	fold?: string;
	role: Role;
}
export interface Event {
	id: string;
	at: string;
	run: string;
	child: string;
	attempt: number;
	row: RunRow;
	phrase: Phrase;
	durationMs?: number;
}
export type Outcome =
	| "done"
	| "parked"
	| "failed"
	| "landed"
	| "land failed"
	| "running";
export interface Attempt {
	n: number;
	model?: { requested: string; actual?: string };
	startedAt: string;
	endedAt?: string;
	outcome?: Outcome;
	tokens?: number;
	events: Event[];
	task?: GateRun;
	exit?: GateRun;
}
export interface Approval {
	glob: string;
	at: string;
	by: string;
	why: string;
}
export interface EnvView {
	worktree: string;
	branch: string;
	db?: string;
	port?: number;
	up: boolean;
	since: string;
	/** Whether the worktree is still on disk; undefined when the view could not tell. */
	exists?: boolean;
}
export interface Requirement {
	id: string;
	/** Proven by evidence that counts (an attempt that landed, or the current one done), else the ledger cell; null when unknown. */
	ok: boolean | null;
	text?: string;
}
export type CellKind = "pass" | "fail" | "unrun" | "active" | "gap";
export interface StripCell {
	kind: CellKind;
}
export interface ChildView {
	key: string;
	summary: string;
	wave: number;
	state: ChildState;
	phase?: Phase;
	phaseSince?: string;
	attempt: number;
	attempts: Attempt[];
	model?: { requested: string; actual?: string };
	tokens: number;
	tokensCounting: boolean;
	pr?: number;
	/** Set when `pr` is from a land that did not merge: why it is not landed. */
	prNote?: string;
	sha?: string;
	requirements: Requirement[];
	touchesMatched?: boolean;
	outside: string[];
	approvals: Approval[];
	needs?: { key: string; state: ChildState }[];
	env?: EnvView;
	lastMessage?: { text: string; role: Role; at: string; attempt: number };
	strip: StripCell[];
	elapsedMs?: number;
	quietMs?: number;
	/** The newest touches-mismatch decision for this child. */
	touchesDecision?: { answer: string; by: string };
	evidence: Record<string, string>;
	/** The child's branch, from its env row or the run's prefix; never assumed. */
	branch?: string;
	/** Evidence reported by a newer attempt that did not land: shown, never counted. */
	unlandedEvidence?: { attempt: number; evidence: Record<string, string> };
	/** The paths the plan declares for it; only a plan snapshot has them. */
	touches?: string[];
	/** Who works on its newest attempt, and how to reach them. */
	worker?: WorkerView;
	/** What it is parked on: the person's answer, or a usage limit the run clears itself. */
	wait?: Wait;
}
export interface WaveView {
	wave: number;
	label: string;
	children: ChildView[];
	landed: number;
	running: number;
}
export interface LedgerRow {
	wave: number;
	key: string;
	summary: string;
	state: string;
	pr?: number;
	requirements: { id: string; ok: boolean }[];
	touches?: "matched" | "outside";
	design: string;
	model: string;
}
export interface LedgerView {
	rows: LedgerRow[];
	evidence: { key: string; id: string; text: string }[];
	mtimeMs?: number;
}
export interface RunView {
	key: string;
	summary?: string;
	scope?: string;
	source: Source;
	planAt?: string;
	/** The published page of the plan and its waves, from `portia plan link`. */
	planUrl?: string;
	skipped: number;
	group: Group;
	glyph: RunGlyph;
	waves: WaveView[];
	children: ChildView[];
	tokens: number;
	epicPr?: number;
	/** `epic.diff` exists, which the epic gate writes. */
	hasEpicDiff: boolean;
	branch: string;
	startedAt?: string;
	lastAt?: string;
	lastEvent?: string;
	epicGates: GateRun[];
	baseline: string[];
	ports: number[];
	ledger?: LedgerView;
	events: Event[];
	catalog: { task: string[]; exit: string[]; epic: string[] };
	/** The run directory's mtime, which orders runs with no rows. */
	mtimeMs?: number;
	plan?: ParentPlan;
	/** Rework and human figures from the run log, as the ledger prints them. */
	metrics: RunMetrics;
	/** Children waiting on the person's answer. */
	questions: number;
}
export interface HomeView {
	home: string;
	runs: RunView[];
	inSession: number;
	needYou: number;
	runningChildren: number;
	landedThisWeek: number;
	tokens: number;
}
export type Sort = "activity" | "key" | "tokens";
