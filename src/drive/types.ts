import { EXIT } from "../core/exit";
import type { SpendOver } from "../core/spend";
import type { ReqId } from "../core/types";
import type { Coupling } from "../plan/coupling";

/**
 * What `portia drive` returns: the automatic steps it took, in order, and the one stop it
 * ended on. Drive keeps no state of its own; a second drive derives the same position from
 * the run log and the tracker, so a stop is always safe to act on and drive again.
 */
export interface DriveResult {
	parent: string;
	steps: DriveStep[];
	stop: Stop;
}

/** The automatic steps drive takes; each is what one Portia command does. */
export const STEP_NAMES = [
	"record-landed",
	"env-up",
	"dispatch",
	"worker-start",
	"worker-wait",
	"result",
	"decide-failure",
	"amend-start",
	"answer",
	"grant",
	"signoff",
	"land",
	"ledger",
	"wave-gate",
	"epic-gate",
] as const;
export type StepName = (typeof STEP_NAMES)[number];

export interface DriveStep {
	step: StepName;
	/** The child it acted on, or the parent for a run-wide step (the wave and epic gates). */
	child: string;
	attempt?: number;
	ok: boolean;
	/** One line: what happened, e.g. `PR #4 merged` or `attempt 2 parked`. */
	detail: string;
	at: string;
}

/** Who answered a question drive applied: a person earlier, or the PORTIA_EVAL_ANSWERS script. */
export type AnsweredBy = "person" | "eval";

/** Where drive stops: a person or the AI is needed, the epic is ready, or something broke. */
export type Stop =
	/** The plan needs drafting, fixing or the person's yes before anything is dispatched. */
	| { kind: "plan"; reason: string }
	/** askOnce questions are open; `portia answer` records them. */
	| {
			kind: "questions";
			questions: { id: string; child?: string; question: string }[];
	  }
	/** The spine finished; its specs wait for the review and `portia signoff specs`. */
	| {
			kind: "spec-signoff";
			spine: string;
			attempt: number;
			head: string;
			/** The spec file of each scenario. */
			specs: Record<ReqId, string>;
			/**
			 * What `portia plan specs` found: specs reaching a child their owner does not need.
			 * With any, drive signs nothing off, scripted or not, until they are settled.
			 */
			coupling?: Coupling[];
	  }
	/**
	 * A child claims an acceptance spec it owns cannot pass as written, with its evidence. Drive
	 * neither answers it nor redispatches it: the spec goes back to the spine to amend (`portia
	 * amend`), and once the amendment lands drive redispatches the child onto it.
	 */
	| {
			kind: "spec-amendment";
			child: string;
			attempt: number;
			/** The spine that wrote the spec, when the plan names one. */
			spine?: string;
			/** The spec's path, as the plan has it, and its scenario. */
			path: string;
			scenario: string;
			assertion: string;
			evidence: string;
			/** How far the amendment has got: the last `amend` row's status, and its head. */
			amendment?: { status: string; head?: string };
	  }
	/** A child waits on a person; `portia drive <PARENT> --answer <KEY> --note-file <file>` records the answer. */
	| {
			kind: "parked";
			child: string;
			attempt: number;
			question: string;
			/**
			 * Set when the child parked this many times running at one head, so the script's
			 * answer is not applied again: each attempt and its question, oldest first.
			 */
			repeats?: { attempt: number; question: string }[];
	  }
	/**
	 * A step failed with no automatic next move: a wave or epic gate, a child out of retries,
	 * or a dispatch past a spend cap (`spend`), which only the person's decision moves.
	 */
	| {
			kind: "failed";
			child: string;
			step: StepName;
			reason: string;
			spend?: Omit<SpendOver, "message">;
	  }
	/** Every child landed and the epic gate passed. */
	| { kind: "epic-ready"; landed: string[]; pr?: number }
	/** Drive could not go on: a refused setting, a broken command, GitHub or the tracker. */
	| { kind: "error"; message: string };
export type StopKind = Stop["kind"];

export const STOP_KINDS = [
	"plan",
	"questions",
	"spec-signoff",
	"spec-amendment",
	"parked",
	"failed",
	"epic-ready",
	"error",
] as const satisfies readonly StopKind[];

/** 0 when the epic is ready, 10 when a person or the AI is needed, 11 when drive failed or broke. */
export function stopExit(stop: Stop): number {
	switch (stop.kind) {
		case "epic-ready":
			return EXIT.OK;
		case "failed":
		case "error":
			return EXIT.PROBLEM;
		default:
			return EXIT.NOTHING;
	}
}

/** The stop as one line for a person. */
export function stopLine(stop: Stop): string {
	switch (stop.kind) {
		case "plan":
			return `plan: ${stop.reason}`;
		case "questions":
			return `questions: ${stop.questions.length} open; answer them with portia answer`;
		case "spec-signoff":
			return `spec-signoff: ${stop.spine} attempt ${stop.attempt} at ${stop.head.slice(0, 7)} waits for the specs sign-off${stop.coupling?.length ? `; settle ${stop.coupling.length} coupling(s) first: ${stop.coupling.map((c) => `${c.scenario} (${c.owner}) reaches ${c.other} via ${c.target}`).join(", ")}` : ""}`;
		case "spec-amendment":
			return `spec-amendment: ${stop.child} attempt ${stop.attempt} says ${stop.path} (${stop.scenario}) cannot pass as written${stop.amendment ? ` (amendment ${stop.amendment.status})` : ""}: ${stop.assertion}`;
		case "parked":
			return `parked: ${stop.child} attempt ${stop.attempt}${stop.repeats ? ` (parked ${stop.repeats.length} times running on one head; the script's answer is not applied again)` : ""} asks: ${stop.question}`;
		case "failed":
			return `failed: ${stop.child} at ${stop.step}: ${stop.reason}`;
		case "epic-ready":
			return `epic-ready: ${stop.landed.length} landed${stop.pr ? `, PR #${stop.pr}` : ""}`;
		case "error":
			return `error: ${stop.message}`;
	}
}

/** The steps, one per line, then the stop. */
export function renderDrive(r: DriveResult): string {
	return [
		...r.steps.map(
			(s) =>
				`${s.ok ? "ok  " : "FAIL"} ${s.step} ${s.child}${s.attempt ? ` #${s.attempt}` : ""}: ${s.detail}`,
		),
		`stop ${stopLine(r.stop)}`,
	].join("\n");
}
