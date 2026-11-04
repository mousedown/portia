import type { Epic, Repo, Suite, Tickets } from "../suite";
import type { Scores } from "../types";
import type { Exec } from "./claude";

/** What every arm gets: a fresh clone, the epic as the arms see it, and a place for logs. */
export interface ArmContext {
	/** A fresh clone of the repo, on its main branch, set up. */
	clone: string;
	repo: Repo;
	epic: Epic;
	/**
	 * The epic's ticket and its children's, as filed in the tracker. The baselines get them in
	 * their brief; Portia reads them from the tracker itself.
	 */
	tickets: Tickets;
	/** Directory for anything the arm writes besides the clone: logs, transcripts, run state. */
	artifacts: string;
	/** The budget, the same for every arm. */
	limits: Suite["limits"];
	/** The model every arm's sessions run on, pinned in the suite. */
	model: string;
	/** The scripted person's answers: `person.json` beside the suite. */
	person: string;
	/** Runs a process; a test replaces it. Spawns it by default. */
	exec?: Exec;
	/** Prints a line to the run's log and the console. */
	log: (line: string) => void;
}

export interface ArmOutcome {
	exitCode: number;
	stoppedBy?: "budget" | "timeout" | "error";
	/** The branch the arm's finished work is on, to score. */
	branch: string;
	/** Branches a person would have to merge to take the work. */
	branchesToMerge: number;
	/** Branches the arm built children on, each checked on its own for late failures; none for one branch. */
	childBranches?: string[];
	/** What the arm knows about its own run; the scorer fills the rest from git and the hidden specs. */
	partial: Partial<Scores>;
}

export interface Arm {
	name: string;
	description: string;
	/** The harness's revision of this arm, bumped when its prompt or loop changes, so its cached results are not reused. */
	version?: string;
	/** Spends no tokens, so the weekly ceiling never holds it back. */
	free?: boolean;
	run(ctx: ArmContext): Promise<ArmOutcome>;
	/**
	 * The outcome `run` returned, rebuilt from what the run left in `ctx.artifacts` and the
	 * clone, without running anything: what `eval rescore` scores. An arm without it cannot be
	 * rescored.
	 */
	rebuild?(ctx: ArmContext): Promise<ArmOutcome>;
}

export { bernstein } from "./bernstein";
export { claudeOrchestrated } from "./claude-orchestrated";
export { claudeParallel } from "./claude-parallel";
export { claudeSerial } from "./claude-serial";
export { claudeWorkflow } from "./claude-workflow";
export { none } from "./none";
export { portia } from "./portia";
export { reference } from "./reference";
