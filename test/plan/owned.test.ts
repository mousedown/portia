import { describe, expect, it } from "vitest";
import type { RunRow } from "../../src/core/types";
import {
	landedScenarios,
	ownedForGate,
	ownedScenarios,
	readyScenarios,
} from "../../src/plan/owned";
import { child, parent, spine } from "../helpers/plan";

const scenarios = [
	{ id: "F1", text: "one" },
	{ id: "F2", text: "two" },
	{ id: "F3", text: "three" },
];
const s = spine({
	acceptance: {
		F1: "packages/acme-web/e2e/a.e2e.ts",
		F2: "packages/acme-web/e2e/b.e2e.ts",
		F3: "packages/acme-web/e2e/b.e2e.ts",
	},
});

it("gives a child the spine's spec path for each scenario it implements", () => {
	const c = child("ACME-2", { requirements: ["F2", "F3", "X9"] });
	expect(ownedScenarios(parent([s, c], scenarios), c)).toEqual([
		{ id: "F2", path: "packages/acme-web/e2e/b.e2e.ts" },
		{ id: "F3", path: "packages/acme-web/e2e/b.e2e.ts" },
	]);
});

it("gives the spine and a child with no scenarios nothing", () => {
	const none = child("ACME-3", { requirements: [] });
	const plan = parent([s, none], scenarios);
	expect(ownedScenarios(plan, s)).toEqual([]);
	expect(ownedScenarios(plan, none)).toEqual([]);
});

it("guards every spine spec for a child, owning all its requirements, ready or not", () => {
	const c = child("ACME-2", { requirements: ["F2", "F3"] });
	const other = child("ACME-3", { requirements: ["F3"] });
	const plan = parent([s, c, other], scenarios);
	expect(ownedForGate(plan, c, []).guard).toEqual({
		specs: {
			F1: "packages/acme-web/e2e/a.e2e.ts",
			F2: "packages/acme-web/e2e/b.e2e.ts",
			F3: "packages/acme-web/e2e/b.e2e.ts",
		},
		owns: ["F2", "F3"],
	});
	expect(ownedForGate(plan, s, []).guard).toBeUndefined();
	expect(ownedForGate(plan, undefined, []).guard).toBeUndefined();
});

describe("readyScenarios: a shared scenario runs only for the child that completes it", () => {
	const shared = spine({
		acceptance: {
			F1: "packages/acme-web/e2e/onboarding/checklist.e2e.ts",
			F3: "packages/acme-web/e2e/onboarding/checklist.e2e.ts",
		},
	});
	const a = child("ACME-502", { requirements: ["F1", "F3"] });
	const b = child("ACME-503", { requirements: ["F1", "F3"] });
	const c = child("ACME-504", { requirements: ["F1", "F3"] });
	const plan = parent([shared, a, b, c], scenarios);
	const landed = (key: string): RunRow => ({
		at: "t",
		child: key,
		attempt: 1,
		stage: "landed",
		status: "landed",
	});

	it("runs none while the other listers are unlanded", () => {
		for (const x of [a, b, c]) {
			const r = readyScenarios(plan, x, []);
			expect(r.ready).toEqual([]);
			expect(r.waiting).toEqual(
				[a, b, c].filter((o) => o !== x).map((o) => o.key),
			);
		}
		expect(readyScenarios(plan, c, [landed("ACME-502")])).toMatchObject({
			ready: [],
			waiting: ["ACME-503"],
		});
	});

	it("runs F1 and F3 for C once A and B have landed", () => {
		expect(
			readyScenarios(plan, c, [landed("ACME-502"), landed("ACME-503")]),
		).toEqual({
			ready: [
				{ id: "F1", path: "packages/acme-web/e2e/onboarding/checklist.e2e.ts" },
				{ id: "F3", path: "packages/acme-web/e2e/onboarding/checklist.e2e.ts" },
			],
			waiting: [],
		});
	});

	it("a scenario only one child lists is ready at once", () => {
		const solo = child("ACME-505", { requirements: ["F2"] });
		const p = parent(
			[
				spine({ acceptance: { F2: "packages/acme-web/e2e/b.e2e.ts" } }),
				solo,
				a,
			],
			scenarios,
		);
		expect(readyScenarios(p, solo, []).ready).toEqual([
			{ id: "F2", path: "packages/acme-web/e2e/b.e2e.ts" },
		]);
	});
});

it("the regression guard holds the scenarios landed children made pass, growing as they land", () => {
	const a = child("ACME-2", { requirements: ["F1"] });
	const b = child("ACME-3", { requirements: ["F2", "F3"] });
	const c = child("ACME-4", { requirements: ["F3"] });
	const plan = parent([s, a, b, c], scenarios);
	const landed = (...keys: string[]): RunRow[] =>
		keys.map((k) => ({ at: "t", child: k, attempt: 1, stage: "landed" }));
	expect(landedScenarios(plan, landed())).toEqual([]);
	expect(landedScenarios(plan, landed("ACME-1"))).toEqual([]);
	expect(landedScenarios(plan, landed("ACME-1", "ACME-2"))).toEqual([
		{ id: "F1", path: "packages/acme-web/e2e/a.e2e.ts" },
	]);
	// F3 waits on ACME-4 as well: it has not run on the tip yet.
	expect(
		landedScenarios(plan, landed("ACME-1", "ACME-2", "ACME-3")).map(
			(o) => o.id,
		),
	).toEqual(["F1", "F2"]);
	expect(
		landedScenarios(plan, landed("ACME-1", "ACME-2", "ACME-3", "ACME-4")).map(
			(o) => o.id,
		),
	).toEqual(["F1", "F2", "F3"]);
});

describe("a spine that owns a scenario no later child can deliver", () => {
	const own = spine({ requirements: ["F1"], acceptance: s.acceptance });
	const b = child("ACME-3", { requirements: ["F2", "F3"] });
	const plan = parent([own, b], scenarios);
	const landed = (...keys: string[]): RunRow[] =>
		keys.map((k) => ({ at: "t", child: k, attempt: 1, stage: "landed" }));

	it("gives the spine its own scenarios at its gate, unguarded, and nothing else", () => {
		expect(ownedForGate(plan, own, [])).toEqual({
			owned: [{ id: "F1", path: "packages/acme-web/e2e/a.e2e.ts" }],
			waitingOn: [],
			// Every other spec it wrote, to fail on an assertion until its child lands.
			failing: [
				{ id: "F2", path: "packages/acme-web/e2e/b.e2e.ts" },
				{ id: "F3", path: "packages/acme-web/e2e/b.e2e.ts" },
			],
		});
		expect(ownedScenarios(plan, b).map((o) => o.id)).toEqual(["F2", "F3"]);
	});

	it("counts the spine's scenario as landed once the spine lands", () => {
		expect(landedScenarios(plan, landed())).toEqual([]);
		expect(landedScenarios(plan, landed("ACME-1"))).toEqual([
			{ id: "F1", path: "packages/acme-web/e2e/a.e2e.ts" },
		]);
		expect(
			landedScenarios(plan, landed("ACME-1", "ACME-3")).map((o) => o.id),
		).toEqual(["F1", "F2", "F3"]);
	});

	it("leaves a scenario the spine shares with a later child to that child", () => {
		const shared = spine({ requirements: ["F2"], acceptance: s.acceptance });
		const p = parent([shared, b], scenarios);
		expect(ownedForGate(p, shared, []).owned).toEqual([]);
		expect(readyScenarios(p, b, []).ready.map((o) => o.id)).toEqual([
			"F2",
			"F3",
		]);
		expect(landedScenarios(p, landed("ACME-1"))).toEqual([]);
		expect(
			landedScenarios(p, landed("ACME-1", "ACME-3")).map((o) => o.id),
		).toEqual(["F2", "F3"]);
	});
});
