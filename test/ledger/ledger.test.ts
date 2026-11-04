import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRow } from "../../src/core/types";
import {
	END,
	ledgerChildren,
	renderLedger,
	replaceRegion,
	START,
} from "../../src/ledger/render";
import { child, parent, spine } from "../helpers/plan";

const plan = parent([
	spine({ summary: "Spine" }),
	child("ACME-2", {
		summary: "Set-up rules",
		design: "x route=/d persona=p frames=f",
	}),
	child("ACME-3"),
]);
const rows: RunRow[] = [
	{
		at: "t",
		child: "ACME-1",
		attempt: 1,
		stage: "landed",
		data: { pr: 41, sha: "a" },
	},
	{
		at: "t",
		child: "ACME-2",
		attempt: 1,
		stage: "dispatched",
		model: { requested: "sonnet" },
	},
	{
		at: "t",
		child: "ACME-2",
		attempt: 1,
		stage: "result",
		status: "done",
		touchesMatched: true,
		model: { requested: "sonnet" },
		data: { evidence: { F1: "12 passed\nmore" } },
	},
];

describe("ledger", () => {
	it("shows state, PR, evidence, touches, design verdict and model per child", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-led-"));
		mkdirSync(join(dir, "design", "ACME-2"), { recursive: true });
		writeFileSync(
			join(dir, "design", "ACME-2", "verdict.json"),
			JSON.stringify({ verdict: "UNCERTAIN" }),
		);
		const md = renderLedger(plan, ledgerChildren(plan, rows, dir));
		expect(md).toContain("| 0 | ACME-1 Spine | landed | #41 |");
		expect(md).toContain(
			"| 1 | ACME-2 Set-up rules | done |  | F1 ✓ | matched | **UNCERTAIN: check by eye** | sonnet |",
		);
		expect(md).toContain("- ACME-2 F1: 12 passed");
		expect(md).toContain("| 1 | ACME-3 ACME-3 | ready |");
	});
	it("lists a landed child's ripples, and none for a child that has not landed", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-led-"));
		const ripples = [{ file: "test/a.test.ts", kind: "test" as const }];
		const withRipples: RunRow[] = [
			...rows,
			{
				at: "t",
				child: "ACME-2",
				attempt: 1,
				stage: "result",
				status: "done",
				ripples,
			},
			{
				at: "t",
				child: "ACME-2",
				attempt: 1,
				stage: "landed",
				data: { pr: 42 },
			},
			{
				at: "t",
				child: "ACME-3",
				attempt: 1,
				stage: "result",
				status: "done",
				ripples,
			},
		];
		const md = renderLedger(plan, ledgerChildren(plan, withRipples, dir));
		expect(md).toContain("### Ripples");
		expect(md).toContain("- ACME-2 test: test/a.test.ts");
		expect(md).not.toContain("- ACME-3 test");
		expect(renderLedger(plan, ledgerChildren(plan, rows, dir))).not.toContain(
			"Ripples",
		);
	});
	it("adds a Lane column only when lanes are in use", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-led-"));
		const plain = renderLedger(plan, ledgerChildren(plan, rows, dir));
		expect(plain).not.toContain("Lane");
		const lanes = new Map([
			["ACME-1", "full" as const],
			["ACME-2", "full" as const],
			["ACME-3", "light" as const],
		]);
		const md = renderLedger(plan, ledgerChildren(plan, rows, dir, lanes));
		expect(md).toContain(
			"| Wave | Child | State | PR | Requirements | Touches | Design | Model | Lane |",
		);
		expect(md).toContain(
			"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		);
		expect(md).toContain(
			"| 1 | ACME-3 ACME-3 | ready |  | F1 ✗ |  |  |  | light |",
		);
	});
	it("has no Review column until some child has been reviewed", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-led-"));
		const md = renderLedger(plan, ledgerChildren(plan, rows, dir));
		expect(md).toContain(
			"| Wave | Child | State | PR | Requirements | Touches | Design | Model |",
		);
		expect(md).not.toContain("Review");
	});
	const reviewed: RunRow[] = [
		...rows,
		{
			at: "t",
			child: "ACME-2",
			attempt: 1,
			stage: "review",
			status: "findings",
			data: { findings: [{ message: "a" }, { message: "b" }] },
		},
		{
			at: "t",
			child: "ACME-1",
			attempt: 1,
			stage: "review",
			status: "clean",
			data: { findings: [] },
		},
	];
	it("shows each child's last review verdict once one has run", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-led-"));
		const md = renderLedger(plan, ledgerChildren(plan, reviewed, dir));
		expect(md).toContain(
			"| Wave | Child | State | PR | Requirements | Touches | Design | Review | Model |",
		);
		expect(md).toContain(
			"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		);
		expect(md).toContain(
			"| 0 | ACME-1 Spine | landed | #41 |  |  |  | clean |  |",
		);
		expect(md).toContain("| **2 findings** | sonnet |");
		expect(md).toContain("| 1 | ACME-3 ACME-3 | ready |  | F1 ✗ |  |  |  |  |");
	});
	it("puts Review before Model and Lane last when both are in use", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-led-"));
		const lanes = new Map([
			["ACME-1", "full" as const],
			["ACME-2", "full" as const],
			["ACME-3", "light" as const],
		]);
		const md = renderLedger(plan, ledgerChildren(plan, reviewed, dir, lanes));
		expect(md).toContain(
			"| Wave | Child | State | PR | Requirements | Touches | Design | Review | Model | Lane |",
		);
		expect(md).toContain(
			"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		);
		expect(md).toContain("| **2 findings** | sonnet | full |");
		expect(md).toContain(
			"| 1 | ACME-3 ACME-3 | ready |  | F1 ✗ |  |  |  |  | light |",
		);
	});
	it("replaces only its own region, adds markers once, and is idempotent", () => {
		const first = replaceRegion("Reviewer notes above.", "LEDGER v1");
		expect(first).toBe(`Reviewer notes above.\n\n${START}\nLEDGER v1\n${END}`);
		const second = replaceRegion(`${first}\n\nNotes below.`, "LEDGER v2");
		expect(second).toBe(
			`Reviewer notes above.\n\n${START}\nLEDGER v2\n${END}\n\nNotes below.`,
		);
		expect(replaceRegion(second, "LEDGER v2")).toBe(second);
	});
});

describe("replaceRegion with a missing end marker", () => {
	it("keeps reviewer notes when the end marker was deleted", () => {
		const body = `Notes above.\n\n${START}\nold ledger\nReviewer note that must survive.`;
		const once = replaceRegion(body, "LEDGER v2");
		expect(once).toContain("Reviewer note that must survive.");
		expect(once.split(START)).toHaveLength(2);
		expect(once.split(END)).toHaveLength(2);
		const twice = replaceRegion(once, "LEDGER v3");
		expect(twice).toContain("Reviewer note that must survive.");
		expect(twice).toContain("LEDGER v3");
		expect(twice).not.toContain("LEDGER v2");
		expect(twice.split(START)).toHaveLength(2);
		expect(twice.split(END)).toHaveLength(2);
	});
});

describe("replaceRegion with markers from before the rename", () => {
	it("replaces a legacy region with the current markers, keeping notes", () => {
		const body =
			"Above.\n\n<!-- portia:ledger:start -->\nold\n<!-- portia:ledger:end -->\n\nBelow.";
		const out = replaceRegion(body, "NEW");
		expect(out).toBe(`Above.\n\n${START}\nNEW\n${END}\n\nBelow.`);
		expect(out).not.toMatch(/portia/i);
	});
	it("writes no tool name into a fresh ledger", () => {
		expect(START + END).not.toMatch(/portia/i);
	});
});
