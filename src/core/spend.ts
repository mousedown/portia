import type { Profile } from "./config";
import type { ChildPlan, ParentPlan, RunRow } from "./types";

const sum = (rows: RunRow[]) => rows.reduce((s, r) => s + (r.tokens ?? 0), 0);

/** A spend cap a child's next dispatch would pass: which one, what was spent and the cap. */
export interface SpendOver {
	scope: "epic" | "wave" | "worker";
	spent: number;
	cap: number;
	message: string;
}

export function spendOver(
	rows: RunRow[],
	plan: ParentPlan,
	c: ChildPlan,
	p: Profile,
): SpendOver | null {
	const results = rows.filter((r) => r.stage === "result");
	// A spec amendment's worker is the epic's spend, not the child that claimed it.
	const epic = sum(
		rows.filter((r) => r.stage === "result" || r.stage === "amend"),
	);
	if (epic >= p.spend.epic)
		return {
			scope: "epic",
			spent: epic,
			cap: p.spend.epic,
			message: `epic spend ${epic} reached the epic cap ${p.spend.epic} (H6)`,
		};
	const inWave = new Set(
		plan.children.filter((x) => x.wave === c.wave).map((x) => x.key),
	);
	const wave = sum(results.filter((r) => inWave.has(r.child)));
	if (wave >= p.spend.wave)
		return {
			scope: "wave",
			spent: wave,
			cap: p.spend.wave,
			message: `wave ${c.wave} spend ${wave} reached the wave cap ${p.spend.wave} (H6)`,
		};
	const mine = sum(results.filter((r) => r.child === c.key));
	if (mine >= p.spend.worker)
		return {
			scope: "worker",
			spent: mine,
			cap: p.spend.worker,
			message: `${c.key} spend ${mine} reached the worker cap ${p.spend.worker} (H6)`,
		};
	return null;
}

export const spendCheck = (
	rows: RunRow[],
	plan: ParentPlan,
	c: ChildPlan,
	p: Profile,
): string | null => spendOver(rows, plan, c, p)?.message ?? null;
