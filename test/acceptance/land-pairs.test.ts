import { expect, it } from "vitest";
import { landPair, PAIRS, pairs } from "../helpers/gate-pairs";

it("L1: Given two children that each pass alone and break together, Then the second fails its exit gate on the rebased head, is not merged, and the integration branch still passes", async () => {
	const breaking = pairs().filter((p) => p.breaks);
	expect(breaking.length, `breaking pairs in ${PAIRS}`).toBeGreaterThan(0);
	for (const pair of breaking) {
		const r = await landPair(pair);
		expect(r.a.status, pair.name).toBe("landed");
		expect(r.b, pair.name).toMatchObject({
			status: "failed",
			reason: expect.stringContaining(
				"exit gate failed on the rebased head (R6)",
			),
		});
		expect(r.landed, pair.name).toEqual(["ACME-2"]);
		expect(r.merged, pair.name).not.toContain(r.branchB);
		expect(r.integration, pair.name).toMatchObject({ ok: true });
	}
}, 300_000);

it("L2: Given two compatible children, Then land() lands both", async () => {
	const compatible = pairs().filter((p) => !p.breaks);
	expect(compatible.length, `compatible pairs in ${PAIRS}`).toBeGreaterThan(0);
	for (const pair of compatible) {
		const r = await landPair(pair);
		expect(r.a.status, pair.name).toBe("landed");
		expect(r.b.status, pair.name).toBe("landed");
		expect(r.landed, pair.name).toEqual(["ACME-2", "ACME-3"]);
		expect(r.integration, pair.name).toMatchObject({ ok: true });
	}
}, 300_000);
