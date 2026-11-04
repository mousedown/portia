import { describe, expect, it } from "vitest";
import {
	type Profile,
	ProfileSchema,
	testProfile,
} from "../../src/core/config";
import type { ChildPlan, RunRow } from "../../src/core/types";
import { check, childLanes, laneOf } from "../../src/plan/check";
import { child, parent, spine } from "../helpers/plan";

const needOn1 = {
	needs: [{ key: "ACME-1", reason: "contract" }],
	blockedBy: ["ACME-1"],
};
const withLanes: Profile = {
	...testProfile(),
	lanes: { maxSize: "S", fullTouches: ["**/jobs/registry.ts"] },
};
const plan = (...cs: ChildPlan[]) =>
	parent([
		spine({ touches: ["packages/acme-web/src/onboarding/types.ts"] }),
		...cs,
	]);
const lane = (c: ChildPlan, p = withLanes, files: string[] = []) =>
	laneOf(plan(c), c, files, p).lane;

describe("laneOf", () => {
	it("is full for every child when the profile sets no lanes", () => {
		const p = testProfile();
		expect(p.lanes).toBeUndefined();
		expect(lane(child("ACME-2", { size: "XS" }), p)).toBe("full");
		expect(childLanes(plan(child("ACME-2")), [], p)).toBeUndefined();
	});
	it("is light for a small child clear of the spine and sensitive code", () => {
		expect(lane(child("ACME-2", { size: "XS" }))).toBe("light");
		expect(lane(child("ACME-2", { size: "S" }))).toBe("light");
	});
	it("is full for the spine, a larger child, a missing size or a design check", () => {
		const s = spine();
		expect(laneOf(parent([s]), s, [], withLanes).lane).toBe("full");
		expect(lane(child("ACME-2", { size: "M" }))).toBe("full");
		expect(lane(child("ACME-2", { size: undefined }))).toBe("full");
		expect(lane(child("ACME-2", { design: "x route=/ persona=p" }))).toBe(
			"full",
		);
		expect(
			lane(child("ACME-2", { size: "M" }), {
				...withLanes,
				lanes: { maxSize: "M", fullTouches: [] },
			}),
		).toBe("light");
	});
	it("is full when it touches a file the spine owns", () => {
		const c = child("ACME-2", {
			touches: ["packages/acme-web/src/onboarding/**"],
		});
		expect(laneOf(plan(c), c, [], withLanes)).toEqual({
			lane: "full",
			why: "it touches packages/acme-web/src/onboarding/types.ts, which the spine owns",
		});
	});
	it("is full when it touches sensitiveGlobs or fullTouches", () => {
		expect(
			lane(child("ACME-2", { touches: ["packages/acme-web/src/auth/x.ts"] })),
		).toBe("full");
		expect(
			lane(
				child("ACME-2", { touches: ["packages/acme-web/src/**"] }),
				withLanes,
				["packages/acme-web/src/payments/charge.ts"],
			),
		).toBe("full");
		expect(
			lane(
				child("ACME-2", {
					touches: ["packages/acme-web/src/jobs/registry.ts"],
				}),
			),
		).toBe("full");
	});
	it("takes a block's lane over the derived one, with or without profile lanes", () => {
		expect(lane(child("ACME-2", { size: "M", lane: "light" }))).toBe("light");
		expect(lane(child("ACME-2", { lane: "full" }))).toBe("full");
		const p = plan(child("ACME-2", { lane: "light" }), child("ACME-3"));
		expect(childLanes(p, [], testProfile())).toEqual(
			new Map([
				["ACME-1", "full"],
				["ACME-2", "light"],
				["ACME-3", "full"],
			]),
		);
	});
});

describe("childLanes", () => {
	const dispatched = (child: string, lane?: string): RunRow => ({
		at: "t",
		child,
		attempt: 1,
		stage: "dispatched",
		...(lane ? { data: { lane } } : {}),
	});
	it("keeps the lane recorded at dispatch over one derived from other files", () => {
		const c = child("ACME-2", { touches: ["packages/acme-web/src/**"] });
		const files = ["packages/acme-web/src/payments/charge.ts"];
		expect(childLanes(plan(c), files, withLanes)?.get("ACME-2")).toBe("full");
		expect(
			childLanes(plan(c), files, withLanes, [
				dispatched("ACME-2", "light"),
			])?.get("ACME-2"),
		).toBe("light");
		expect(
			childLanes(plan(c), files, withLanes, [dispatched("ACME-2")])?.get(
				"ACME-2",
			),
		).toBe("full");
	});
});

describe("check", () => {
	const p = plan(
		child("ACME-2", needOn1),
		child("ACME-3", { ...needOn1, size: "M" }),
	);
	it("reports each child's lane when lanes are in use", () => {
		const info = check(p, [], [], "M", withLanes).filter(
			(f) => f.rule === "lane",
		);
		expect(info.map((f) => [f.level, f.message])).toEqual([
			["info", "ACME-1 runs in the full lane: it is the spine"],
			[
				"info",
				"ACME-2 runs in the light lane: small and clear of the spine and sensitive code",
			],
			["info", "ACME-3 runs in the full lane: size M is over S"],
		]);
	});
	it("reports nothing about lanes by default", () => {
		expect(check(p, [], [], "M", testProfile())).toEqual(check(p, [], [], "M"));
		expect(
			check(p, [], [], "M", testProfile()).filter((f) => f.rule === "lane"),
		).toEqual([]);
	});
});

describe("the profile", () => {
	it("defaults lanes to a max size of S and no extra full touches", () => {
		const base = { ...testProfile(), lanes: {} };
		expect(ProfileSchema.parse(base).lanes).toEqual({
			maxSize: "S",
			fullTouches: [],
		});
	});
	it("rejects an unknown or empty step lane list", () => {
		const step = (lanes: unknown) => ({
			...testProfile(),
			gates: {
				task: [],
				exit: [{ name: "e2e", cmd: "x", heavy: true, cwd: "package", lanes }],
				epic: [],
			},
		});
		expect(ProfileSchema.safeParse(step(["full"])).success).toBe(true);
		expect(ProfileSchema.safeParse(step(["fast"])).success).toBe(false);
		expect(ProfileSchema.safeParse(step([])).success).toBe(false);
	});
});
