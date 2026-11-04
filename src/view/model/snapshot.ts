import { z } from "zod";
import { PLAN_FILE, type PlanSnapshot } from "../../core/plan-snapshot";
import type { ChildPlan, ParentPlan } from "../../core/types";

export { PLAN_FILE };

const Child = z.object({
	key: z.string(),
	summary: z.string(),
	wave: z.number(),
	needs: z.array(z.object({ key: z.string(), reason: z.string() })),
	touches: z.array(z.string()),
	requirements: z.array(z.string()),
	evidence: z.string(),
	tier: z.enum(["high", "standard"]),
	design: z.string().optional(),
	size: z.string().optional(),
	acceptance: z.record(z.string(), z.string()),
	hooks: z.record(z.string(), z.string()).optional(),
	blockedBy: z.array(z.string()),
});
const Snapshot = z.object({
	version: z.literal(1),
	at: z.string(),
	plan: z.object({
		key: z.string(),
		summary: z.string(),
		scope: z.string(),
		scenarios: z.array(z.object({ id: z.string(), text: z.string() })),
		children: z.array(Child),
		satisfied: z.array(z.string()).optional(),
		closed: z.array(z.string()).optional(),
	}),
	waveGate: z.literal(true).optional(),
});

// The reader mirrors core's plan types; these fail to compile the moment either side
// changes alone, so a real snapshot can never quietly stop parsing.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const childMatches: Same<z.infer<typeof Child>, ChildPlan> = true;
const planMatches: Same<z.infer<typeof Snapshot>["plan"], ParentPlan> = true;
void childMatches;
void planMatches;

/** A wrong version or shape reads as no snapshot at all. */
export function parsePlanSnapshot(text: string): PlanSnapshot | undefined {
	try {
		const r = Snapshot.safeParse(JSON.parse(text));
		return r.success
			? {
					version: 1,
					at: r.data.at,
					plan: r.data.plan as ParentPlan,
					...(r.data.waveGate ? { waveGate: true as const } : {}),
				}
			: undefined;
	} catch {
		return undefined;
	}
}
