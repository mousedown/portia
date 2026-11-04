import { PortiaProblem } from "./exit";
import { appendRow } from "./runlog";
import type { RunRow } from "./types";

/**
 * Who signed: the person, the scripted person of PORTIA_EVAL_ANSWERS, `rule` (drive itself,
 * for specs the coupling check found clean under `specsSignoff: "when-clean"`), or
 * `reviewer` (the reviewer agent's no to an amendment, before any person is asked).
 */
export type SignedBy = "person" | "eval" | "rule" | "reviewer";

/** Signers that are no one's decision: drive's rule and the reviewer agent. */
export const NOT_A_PERSON: ReadonlySet<unknown> = new Set(["rule", "reviewer"]);
export type SignoffKind = "plan" | "specs";

export interface Signoff {
	kind: SignoffKind;
	/** The parent for a plan approval, the spine for a spec sign-off. */
	child: string;
	attempt: number;
	approved: boolean;
	by: SignedBy;
	/** The commit signed off: the repo's HEAD for a plan, the spine's head for its specs. */
	commit: string;
	/** When the question was put to them; waitedMinutes runs from here to the row. */
	askedAt?: string;
	/** sha256 of the plan file the person approved. */
	plan?: string;
	note?: string;
	/** A spec amendment's sign-off: the spec it changes, on the child that claimed it (`child`). */
	amends?: string;
}

const STAGE: Record<SignoffKind, RunRow["stage"]> = {
	plan: "approval",
	specs: "signoff",
};

export const isSignoff = (r: RunRow): boolean =>
	r.stage === "approval" || r.stage === "signoff";

export const minutesSince = (from: string, to: string): number =>
	Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 6000) / 10);

/**
 * Records one sign-off: `approval` for the plan, `signoff` for the spine's acceptance specs.
 * A "no" is recorded too, as `rejected`: it is a decision the person made.
 */
export function recordSignoff(
	dir: string,
	s: Signoff,
	now = new Date().toISOString(),
): RunRow {
	if (!s.commit.trim())
		throw new PortiaProblem(`no commit to sign off for ${s.child}`);
	return appendRow(dir, {
		at: now,
		child: s.child,
		attempt: s.attempt,
		stage: STAGE[s.kind],
		status: s.approved ? "approved" : "rejected",
		data: {
			by: s.by,
			commit: s.commit.trim(),
			waitedMinutes: s.askedAt ? minutesSince(s.askedAt, now) : 0,
			...(s.plan ? { plan: s.plan } : {}),
			...(s.amends ? { amends: s.amends } : {}),
			...(s.note ? { note: s.note } : {}),
		},
	});
}

/** The spine's last done result: the attempt whose specs are put to the person. */
export function spineResult(rows: RunRow[], spine: string): RunRow | undefined {
	return rows
		.filter(
			(r) => r.child === spine && r.stage === "result" && r.status === "done",
		)
		.at(-1);
}
