/** One run of one arm on one epic: everything the rubric scores, plus where the artifacts are. */
export interface RunResult {
	schema: 1;
	suite: string;
	arm: string;
	repo: string;
	epic: string;
	/** 1-based repeat number. */
	n: number;
	startedAt: string;
	finishedAt: string;
	/** Where the clone, logs and transcripts were kept. */
	artifacts: string;
	/** The arm's exit: 0 is finished; anything else is recorded, not fatal. */
	exitCode: number;
	stoppedBy?: "budget" | "timeout" | "error";
	/**
	 * Set by `eval void`: the harness broke the run, not the arm. The result stays on disk
	 * and its tokens in the ledger, but no report, comparison or cached repeat counts it.
	 */
	void?: { reason: string; at: string };
	/** Which Portia (its checkout's commit), which Claude Code and which model the run used. */
	tools?: {
		portia?: {
			sha?: string;
			describe?: string;
			dirty?: boolean;
			checkout?: string;
		};
		claude?: string;
		/** The suite's pinned model, as every session was given it. */
		model?: string;
		/** The arm's version for the result cache (`armVersion` in budget.ts); absent when unknown. */
		armVersion?: string;
	};
	scores: Scores;
}

export interface Scores {
	correctness: {
		/** Hidden scenarios that passed on the arm's final branch. */
		passed: string[];
		failed: string[];
		passRate: number;
		/** The repo's own checks (its `checks`) all pass on the final branch; absent when it names none. */
		checksPass?: boolean;
		/** The checks that failed there. */
		checksFailed?: string[];
	};
	completeness: {
		/** Did the feature arrive as one reviewable unit? */
		oneUnit: boolean;
		/** Branches a person would have to merge. */
		branchesToMerge: number;
	};
	rework: {
		/** Attempts after the first, summed over children (Portia); iterations after the first until hidden specs passed (baselines). */
		retries: number;
		failedLands: number;
		/** Share of tokens spent on attempts after the first. */
		tokenShare: number;
		/** Share of minutes spent on attempts after the first. */
		minuteShare: number;
	};
	integration: {
		mergeConflicts: number;
		/** Repo checks that fail on the final branch though every child branch passed them on its own. */
		lateFailures: number;
	};
	human: {
		/** Decisions a person made: approvals, sign-offs, parked questions, and each review of a diff. */
		decisions: number;
		/** Minutes the run spent waiting on a person. */
		waitingMinutes: number;
	};
	cost: {
		tokens: number;
		tokensByModel: Record<string, number>;
		/** As the arm reported it, when it did. */
		usd?: number;
		wallMinutes: number;
		/** Sum of child durations; with wall-clock this gives the parallelism achieved. */
		workMinutes: number;
	};
	safety: {
		filesOutsideDeclaredPaths: number;
		pushesToMain: number;
		permissionWidenings: number;
		mergesWithoutPassingGate: number;
	};
}

export const emptyScores = (): Scores => ({
	correctness: { passed: [], failed: [], passRate: 0 },
	completeness: { oneUnit: false, branchesToMerge: 0 },
	rework: { retries: 0, failedLands: 0, tokenShare: 0, minuteShare: 0 },
	integration: { mergeConflicts: 0, lateFailures: 0 },
	human: { decisions: 0, waitingMinutes: 0 },
	cost: { tokens: 0, tokensByModel: {}, wallMinutes: 0, workMinutes: 0 },
	safety: {
		filesOutsideDeclaredPaths: 0,
		pushesToMain: 0,
		permissionWidenings: 0,
		mergesWithoutPassingGate: 0,
	},
});
