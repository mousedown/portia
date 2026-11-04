import { expect, it } from "vitest";
import {
	type CheckedPlan,
	PLAN_WRITE_CONCURRENCY,
	writePlan,
} from "../../src/plan/draft";
import type { Tracker } from "../../src/plan/tracker";

it("writes the blocks several at a time, then the links, never more than the cap at once", async () => {
	let inFlight = 0;
	let most = 0;
	const order: string[] = [];
	const slow = async (what: string) => {
		inFlight++;
		most = Math.max(most, inFlight);
		await new Promise((r) => setTimeout(r, 20));
		order.push(what);
		inFlight--;
	};
	const tracker = {
		setPlanBlock: (key: string) => slow(`block ${key}`),
		link: (blocker: string, blocked: string) =>
			slow(`link ${blocker}>${blocked}`),
	} as unknown as Tracker;
	const children = Array.from({ length: 9 }, (_, i) => ({
		key: `C-${i + 1}`,
		block: "b",
		needs: i ? ["C-1"] : [],
	}));
	const plan = {
		parent: { key: "P", block: "p" },
		children,
		findings: [],
	} as unknown as CheckedPlan;
	const said: string[] = [];
	const started = Date.now();
	await writePlan(tracker, plan, (s) => said.push(s), false);
	expect(most).toBeGreaterThan(1);
	expect(most).toBeLessThanOrEqual(PLAN_WRITE_CONCURRENCY);
	// Ten blocks and eight links at 20 ms each, sequentially 360 ms.
	expect(Date.now() - started).toBeLessThan(250);
	const lastBlock = Math.max(
		...order.map((w, i) => (w.startsWith("block") ? i : -1)),
	);
	const firstLink = order.findIndex((w) => w.startsWith("link"));
	expect(lastBlock).toBeLessThan(firstLink);
	// Said in plan order, whatever order the writes finished in.
	expect(said[0]).toBe("wrote the plan block on P");
	expect(said[1]).toBe("wrote the plan block on C-1");
	expect(said.at(-1)).toBe("wrote C-9 is blocked by C-1");
});
