import { expect, it } from "vitest";
import type { Run } from "../../src/core/runs";
import type { RunRow } from "../../src/core/types";
import type { History } from "../../src/verify/git";
import { countReceipts, verifyRun } from "../../src/verify/verify";
import { child, parent, spine } from "../helpers/plan";

const FILE = "specs.test.ts";
const row = (
	child: string,
	stage: RunRow["stage"],
	status?: string,
	data?: Record<string, unknown>,
): RunRow => ({
	at: "2026-10-01T09:00:00Z",
	child,
	attempt: 1,
	stage,
	status,
	data,
});

const history = (o: Partial<History> = {}): History => ({
	branch: "epic/P",
	isAncestor: async () => true,
	show: async () => 'it("F1: Given x, Then y", () => {});',
	landing: async (pr) => ({ sha: `land${pr}`, parent: `tip${pr}` }),
	...o,
});

function run(rows: RunRow[]): Run {
	return {
		key: "P",
		dir: "",
		rows,
		skipped: 0,
		plan: parent([spine({ key: "S", acceptance: { F1: FILE } }), child("C")]),
		source: "plan",
		warnings: [],
	};
}

const full = (): RunRow[] => [
	row("S", "result", "done", { evidence: { F1: "Tests 1 failed (1)" } }),
	row("S", "signoff", "approved", { by: "person", commit: "s1" }),
	row("S", "gate", "pass", { kind: "exit" }),
	row("S", "landed", "landed", { pr: 1, sha: "s1", onto: "tip1" }),
	row("C", "result", "done", { evidence: { F1: "Tests 1 passed" } }),
	row("C", "gate", "pass", { kind: "exit" }),
	row("C", "landed", "landed", { pr: 2, sha: "c1", onto: "tip2" }),
];

const kinds = async (rows: RunRow[], h = history()) =>
	(await verifyRun(run(rows), h)).exceptions.map((e) => `${e.child}:${e.kind}`);

it("reports nothing for a run with every receipt", async () => {
	expect(await kinds(full())).toEqual([]);
});

it("flags a gate that passed before the last result", async () => {
	const rows = full();
	rows.splice(6, 0, row("C", "result", "done"));
	expect(await kinds(rows)).toEqual(["C:gated-commit"]);
});

it("flags a landing whose parent is not the recorded tip", async () => {
	const h = history({
		landing: async (pr) => ({ sha: "x", parent: pr === 2 ? "other" : "tip1" }),
	});
	expect(await kinds(full(), h)).toEqual(["C:rebased-on-tip"]);
});

it("flags a spine whose specs never failed", async () => {
	const rows = full();
	rows[0] = row("S", "result", "done", { evidence: { F1: "Tests 1 passed" } });
	expect(await kinds(rows)).toEqual(["S:specs-first", "C:specs-first"]);
});

it("expects a pass, not a failing run, for a scenario the spine owns", async () => {
	const owning: Run = {
		...run([]),
		plan: parent(
			[
				spine({
					key: "S",
					requirements: ["F1"],
					acceptance: { F1: FILE, F2: FILE },
				}),
				child("C", { requirements: ["F2"] }),
			],
			[
				{ id: "F1", text: "one" },
				{ id: "F2", text: "two" },
			],
		),
	};
	const rows = full();
	rows[0] = row("S", "result", "done", {
		evidence: { F1: "Tests 1 passed", F2: "Tests 1 failed (1)" },
	});
	const h = history({
		show: async () => 'it("F1: one", () => {});\nit("F2: two", () => {});',
	});
	expect(
		(await verifyRun({ ...owning, rows }, h)).exceptions.map(
			(e) => `${e.child}:${e.kind}`,
		),
	).toEqual([]);
});

it("flags a scenario with no titled test", async () => {
	const h = history({ show: async () => 'it("something else", () => {});' });
	expect(await kinds(full(), h)).toEqual([
		"S:scenario-tests",
		"C:scenario-tests",
	]);
});

it("reports sign-off as not recorded, not an exception, for a run that predates it", async () => {
	const rows = full().filter((r) => r.stage !== "signoff");
	const result = await verifyRun(run(rows), history());
	expect(result.exceptions).toEqual([]);
	expect(
		result.children[0]?.receipts.find((r) => r.kind === "signoff")?.status,
	).toBe("not-recorded");
});

it("flags a sign-off by eval and counts exceptions by receipt", async () => {
	const rows = full();
	rows[1] = row("S", "signoff", "approved", { by: "eval", commit: "s1" });
	const result = await verifyRun(run(rows), history());
	expect(countReceipts([result])).toEqual({
		runs: 1,
		landed: 2,
		complete: 0,
		exceptions: { signoff: 2 },
	});
});

it("finds a direct landing's commit by the child's key, and checks it on its tip", async () => {
	const rows = full().map((r) =>
		r.stage === "landed"
			? row(r.child, "landed", "landed", {
					sha: `${r.child}-commit`,
					// The spine's gated head is the commit its specs were signed off at.
					gated: r.child === "S" ? "s1" : `${r.child}-gated`,
					onto: r.child === "S" ? "tipS" : "tipC",
					direct: true,
				})
			: r,
	);
	const asked: (number | string)[] = [];
	const h = history({
		landing: async (by) => {
			asked.push(by);
			return { sha: `${by}-commit`, parent: `tip${by}` };
		},
	});
	expect(await kinds(rows, h)).toEqual([]);
	expect(asked).toEqual(expect.arrayContaining(["S", "C"]));
	const off = history({
		landing: async () => ({ sha: "x", parent: "elsewhere" }),
	});
	expect(await kinds(rows, off)).toContain("C:rebased-on-tip");
});
