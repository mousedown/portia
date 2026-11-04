import { expect, it } from "vitest";
import { check } from "../../src/plan/check";
import { loadPlan } from "../../src/plan/load";
import { topLevelOf } from "../../src/plan/repo";
import { FakeTracker } from "../support/fake-tracker";

const issue = (key: string, block: string, blockedBy: string[] = []) => ({
	key,
	summary: key,
	description: `\`\`\`portia\n${block}\n\`\`\``,
	blockedBy,
});

it("loads the parent and children, and reports a bad child as a parse finding", async () => {
	const tracker = new FakeTracker()
		.add(
			issue(
				"ACME-9000",
				"scope: onboarding\nscenario: F1 = Given a parent, Then content",
			),
		)
		.add(
			issue(
				"ACME-9001",
				"wave: 0\ntouches: src/lib/onboarding/**\nevidence: x\nacceptance: F1 = e2e/a.e2e.ts",
			),
			"ACME-9000",
		)
		.add(
			issue(
				"ACME-9002",
				"wave: 1\nneeds: ACME-9001 # contract\ntouches: src/app/**\nrequirements: F1\nevidence: y",
				["ACME-9001"],
			),
			"ACME-9000",
		)
		.add(issue("ACME-9003", "wave: one"), "ACME-9000");
	const { plan, findings } = await loadPlan(
		tracker,
		"ACME-9000",
		topLevelOf(["packages/acme-web/package.json"]),
		"packages/acme-web",
	);
	expect(plan.scope).toBe("onboarding");
	expect(plan.children.map((c) => c.key)).toEqual(["ACME-9001", "ACME-9002"]);
	expect(plan.children[1]?.blockedBy).toEqual(["ACME-9001"]);
	expect(findings).toEqual([
		{
			rule: "parse",
			level: "error",
			child: "ACME-9003",
			message: "ACME-9003: wave must be a whole number, got 'one'",
		},
	]);
});

const plain = (key: string, extra: object = {}) => ({
	key,
	summary: key,
	description: "As a parent I want things.",
	blockedBy: [],
	...extra,
});
const SPINE =
	"wave: 0\ntouches: src/lib/onboarding/**\nevidence: x\nacceptance: F1 = e2e/a.e2e.ts";
const PARENT = "scope: onboarding\nscenario: F1 = Given a parent, Then content";
const load = (tracker: FakeTracker, key: string) =>
	loadPlan(
		tracker,
		key,
		topLevelOf(["packages/acme-web/package.json"]),
		"packages/acme-web",
		{ excludeLabels: ["launch-readiness"] },
	);

it("runs every planned child whatever its status; leaves unplanned done and excluded ones out silently", async () => {
	const tracker = new FakeTracker()
		.add(issue("ACME-187", PARENT))
		.add(issue("ACME-201", SPINE), "ACME-187")
		.add(
			{
				...issue(
					"ACME-202",
					"wave: 1\ntouches: src/app/**\nrequirements: F1\nevidence: y",
				),
				done: true,
			},
			"ACME-187",
		)
		.add(plain("ACME-203", { done: true }), "ACME-187")
		.add(plain("ACME-204", { labels: ["launch-readiness"] }), "ACME-187")
		.add(plain("ACME-206"), "ACME-187")
		.add(plain("ACME-207", { labels: ["other"] }), "ACME-187");
	const { plan, findings, unplanned } = await load(tracker, "ACME-187");
	expect(plan.children.map((c) => c.key)).toEqual(["ACME-201", "ACME-202"]);
	expect(plan.closed).toEqual(["ACME-202"]);
	expect(unplanned).toEqual(["ACME-206", "ACME-207"]);
	expect(findings).toEqual([
		{
			rule: "unplanned",
			level: "warn",
			message: "not in this run: ACME-206, ACME-207",
		},
	]);
});

it("a planned child carrying an excluded label is an error", async () => {
	const tracker = new FakeTracker()
		.add(issue("ACME-187", PARENT))
		.add(issue("ACME-201", SPINE), "ACME-187")
		.add(
			{
				...issue(
					"ACME-205",
					"wave: 1\ntouches: src/app/**\nrequirements: F1\nevidence: y",
				),
				labels: ["x", "Launch-Readiness"],
			},
			"ACME-187",
		);
	const { plan, findings } = await load(tracker, "ACME-187");
	expect(plan.children.map((c) => c.key)).toEqual(["ACME-201"]);
	expect(findings).toEqual([
		{
			rule: "excluded",
			level: "error",
			child: "ACME-205",
			message: "ACME-205: planned but labelled Launch-Readiness",
		},
	]);
});

it("a need on a done issue outside the run is satisfied; on an open or missing one it is not", async () => {
	const needs =
		"wave: 1\ntouches: src/app/**\nrequirements: F1\nevidence: y\nneeds: ACME-203 # done sibling\nneeds: ACME-300 # done elsewhere\nneeds: ACME-206 # open\nneeds: ACME-999 # missing";
	const tracker = new FakeTracker()
		.add(issue("ACME-187", PARENT))
		.add(issue("ACME-201", SPINE), "ACME-187")
		.add(
			issue("ACME-202", needs, [
				"ACME-203",
				"ACME-300",
				"ACME-206",
				"ACME-999",
			]),
			"ACME-187",
		)
		.add(plain("ACME-203", { done: true }), "ACME-187")
		.add(plain("ACME-206"), "ACME-187")
		.add(plain("ACME-300", { done: true }));
	const { plan, findings } = await load(tracker, "ACME-187");
	expect(plan.satisfied).toEqual(["ACME-203", "ACME-300"]);
	expect(findings.filter((f) => f.level === "info")).toEqual([
		{
			rule: "graph",
			level: "info",
			child: "ACME-202",
			message: "ACME-202 needs ACME-203: already done",
		},
		{
			rule: "graph",
			level: "info",
			child: "ACME-202",
			message: "ACME-202 needs ACME-300: already done",
		},
	]);
	expect(
		check(plan, [])
			.filter((f) => f.rule === "graph")
			.map((f) => f.message),
	).toEqual([
		"ACME-202 needs ACME-206, which is not a child of ACME-187",
		"ACME-202 needs ACME-999, which is not a child of ACME-187",
	]);
});

it("excludes nothing by label when no excludeLabels are given", async () => {
	const tracker = new FakeTracker()
		.add(
			issue(
				"ACME-9000",
				"scope: onboarding\nscenario: F1 = Given a parent, Then content",
			),
		)
		.add(
			{
				...issue(
					"ACME-9001",
					"wave: 0\ntouches: src/lib/onboarding/**\nevidence: x\nacceptance: F1 = e2e/a.e2e.ts",
				),
				labels: ["launch-readiness"],
			},
			"ACME-9000",
		);
	const { plan, findings, unplanned } = await loadPlan(
		tracker,
		"ACME-9000",
		topLevelOf(["packages/acme-web/package.json"]),
		"packages/acme-web",
	);
	expect(plan.children.map((c) => c.key)).toEqual(["ACME-9001"]);
	expect(findings).toEqual([]);
	expect(unplanned).toEqual([]);
});

it("a missing parent fails with the parent's own error, though its children are read alongside", async () => {
	const t = new FakeTracker();
	t.issue = () =>
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("no parent ACME-404")), 5),
		);
	t.children = () => Promise.reject(new Error("children unreadable"));
	await expect(loadPlan(t, "ACME-404", [], "")).rejects.toThrow(
		"no parent ACME-404",
	);
});
