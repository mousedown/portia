import { expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { spendCheck } from "../../src/core/spend";
import type { ChildPlan, RunRow } from "../../src/core/types";
import { child, parent, spine } from "../helpers/plan";

const plan = parent([spine(), child("ACME-2"), child("ACME-3")]);
const p = { ...testProfile(), spend: { worker: 100, wave: 150, epic: 1000 } };
const used = (key: string, tokens: number): RunRow => ({
	at: "t",
	child: key,
	attempt: 1,
	stage: "result",
	tokens,
});

it("refuses the next dispatch once a worker, wave or epic cap is reached (H6)", () => {
	expect(
		spendCheck([used("ACME-2", 50)], plan, plan.children[1] as ChildPlan, p),
	).toBeNull();
	expect(
		spendCheck([used("ACME-2", 100)], plan, plan.children[1] as ChildPlan, p),
	).toMatch(/ACME-2 spend 100 reached the worker cap 100/);
	expect(
		spendCheck(
			[used("ACME-2", 90), used("ACME-3", 70)],
			plan,
			plan.children[2] as ChildPlan,
			p,
		),
	).toMatch(/wave 1 spend 160 reached the wave cap 150/);
	expect(
		spendCheck([used("ACME-1", 1000)], plan, plan.children[1] as ChildPlan, p),
	).toMatch(/epic spend 1000/);
});
