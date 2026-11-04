import { describe, expect, it } from "vitest";
import { parseLedger } from "../../../src/view/model/ledger";
import { appendRunlog, parseRunlog } from "../../../src/view/model/runlog";
import { parsePlanSnapshot } from "../../../src/view/model/snapshot";

const row = (o: Record<string, unknown>) =>
	JSON.stringify({
		at: "2026-10-20T10:00:00.000Z",
		child: "ACME-501",
		attempt: 1,
		stage: "dispatched",
		...o,
	});

describe("parseRunlog", () => {
	it("counts broken lines and holds back a last line with no newline", () => {
		const text = `${row({})}\n{"at":"broken\n\n${row({ stage: "result", status: "done" })}\n{"at":"2026-10-20T1`;
		const log = parseRunlog(text);
		expect(log.rows.map((r) => r.stage)).toEqual(["dispatched", "result"]);
		expect(log.skipped).toBe(1);
		expect(log.tail).toBe('{"at":"2026-10-20T1');
	});
	it("counts JSON that is not a row as unreadable", () => {
		expect(parseRunlog('{"hello":1}\n[]\n').skipped).toBe(2);
	});
	it("carries a tail split mid-line into the next chunk", () => {
		const full = `${row({})}\n${row({ stage: "landed", status: "landed" })}\n`;
		const cut = full.length - 20;
		const a = parseRunlog(full.slice(0, cut));
		expect(a.rows).toHaveLength(1);
		const b = appendRunlog(a, full.slice(cut));
		expect(b.rows.map((r) => r.stage)).toEqual(["dispatched", "landed"]);
		expect(b.tail).toBe("");
		expect(b.skipped).toBe(0);
	});
});

const LEDGER = [
	"<table><tr><td>| 1 | NOT-1 inside an HTML table |</td></tr></table>",
	"| 0 | NOT-2 before the markers | landed | #1 | X1 ✓ | matched |  | opus |",
	"<!-- epic-ledger:start -->",
	"| Wave | Child | State | PR | Requirements | Touches | Design | Model |",
	"| --- | --- | --- | --- | --- | --- | --- | --- |",
	"| 2 | ACME-504 Invoice list for team admins | landed | #427 | R4 ✓ R9 ✗ | **outside touches** |  | sonnet |",
	"| 0 | ACME-501 Invoice model | landed | #415 | R1 ✓ | matched |  | opus |",
	"| 3 | ACME-507 Credit notes | closed |  |  |  |  |  |",
	"### Evidence",
	"- ACME-501 R1: 31 pass, 0 fail",
	"<!-- epic-ledger:end -->",
	"- ACME-999 R9: after the markers",
].join("\n");

describe("parseLedger", () => {
	it("reads only between the markers, waves in table order", () => {
		const l = parseLedger(LEDGER);
		expect(l?.rows.map((r) => r.key)).toEqual([
			"ACME-504",
			"ACME-501",
			"ACME-507",
		]);
		expect(l?.rows[0]).toMatchObject({
			wave: 2,
			summary: "Invoice list for team admins",
			state: "landed",
			pr: 427,
			touches: "outside",
			requirements: [
				{ id: "R4", ok: true },
				{ id: "R9", ok: false },
			],
			model: "sonnet",
		});
		expect(l?.rows[1]?.touches).toBe("matched");
		expect(l?.rows[2]?.pr).toBeUndefined();
		expect(l?.evidence).toEqual([
			{ key: "ACME-501", id: "R1", text: "31 pass, 0 fail" },
		]);
	});
	it("keeps an escaped pipe in a summary inside its cell", () => {
		const md = [
			"<!-- epic-ledger:start -->",
			"| Wave | Child | State | PR | Requirements | Touches | Design | Model |",
			"|---|---|---|---|---|---|---|---|",
			"| 1 | ACME-520 Import CSV \\| XLSX | landed | #530 | R1 ✓ | matched |  | opus |",
			"<!-- epic-ledger:end -->",
		].join("\n");
		expect(parseLedger(md)?.rows[0]).toMatchObject({
			key: "ACME-520",
			summary: "Import CSV | XLSX",
			state: "landed",
			pr: 530,
			requirements: [{ id: "R1", ok: true }],
			touches: "matched",
			model: "opus",
		});
	});
	it("is undefined without both markers", () => {
		expect(parseLedger("| 0 | ACME-1 x | landed |")).toBeUndefined();
		expect(
			parseLedger("<!-- epic-ledger:start -->\n| 0 | ACME-1 x |"),
		).toBeUndefined();
	});
});

describe("parsePlanSnapshot", () => {
	const plan = {
		key: "ACME-500",
		summary: "s",
		scope: "billing",
		scenarios: [],
		children: [],
	};
	it("accepts version 1", () => {
		expect(
			parsePlanSnapshot(
				JSON.stringify({ version: 1, at: "2026-10-20T10:00:00Z", plan }),
			)?.plan.key,
		).toBe("ACME-500");
	});
	it("reads a wrong version, a bad shape or bad JSON as no snapshot", () => {
		expect(
			parsePlanSnapshot(JSON.stringify({ version: 2, at: "x", plan })),
		).toBeUndefined();
		expect(
			parsePlanSnapshot(
				JSON.stringify({ version: 1, at: "x", plan: { key: 1 } }),
			),
		).toBeUndefined();
		expect(parsePlanSnapshot("{")).toBeUndefined();
	});
});

describe("snapshots and legacy ledgers", () => {
	it("reads back exactly what writePlanSnapshot wrote", async () => {
		const { mkdtempSync, readFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { writePlanSnapshot, PLAN_FILE } = await import(
			"../../../src/core/plan-snapshot"
		);
		const plan = {
			key: "ACME-700",
			summary: "Every field a plan can carry",
			scope: "all of it",
			scenarios: [{ id: "R1", text: "it round-trips" }],
			children: [
				{
					key: "ACME-701",
					summary: "The spine",
					wave: 0,
					needs: [{ key: "ACME-650", reason: "the schema" }],
					touches: ["src/**"],
					requirements: ["R1"],
					evidence: "a test",
					tier: "high" as const,
					design: "https://example.com/design",
					size: "M",
					acceptance: { R1: "it round-trips" },
					blockedBy: ["ACME-650"],
				},
			],
			satisfied: ["ACME-650"],
			closed: ["ACME-702"],
		};
		const dir = mkdtempSync(join(tmpdir(), "portia-snap-"));
		writePlanSnapshot(dir, plan, new Date("2026-10-20T10:00:00.000Z"));
		const snap = parsePlanSnapshot(readFileSync(join(dir, PLAN_FILE), "utf8"));
		expect(snap?.plan).toEqual(plan);
	});
	it("finds a ledger written with the markers from before the rename", () => {
		const legacy = LEDGER.replace(
			"<!-- epic-ledger:start -->",
			"<!-- portia:ledger:start -->",
		).replace("<!-- epic-ledger:end -->", "<!-- portia:ledger:end -->");
		expect(parseLedger(legacy)?.rows.map((r) => r.key)).toEqual(
			parseLedger(LEDGER)?.rows.map((r) => r.key),
		);
	});
});
