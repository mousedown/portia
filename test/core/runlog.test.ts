import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runDir } from "../../src/core/rundir";
import { appendRow, LOG, nextAttempt, readRows } from "../../src/core/runlog";

it("creates the run directory under PORTIA_HOME", () => {
	const home = mkdtempSync(join(tmpdir(), "portia-"));
	expect(runDir("acme-9000", { PORTIA_HOME: home })).toBe(
		join(home, "runs", "ACME-9000"),
	);
});

it("appends rows, skips a torn line, and counts attempts", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-"));
	appendRow(dir, { child: "ACME-2", attempt: 1, stage: "dispatched" });
	appendFileSync(join(dir, LOG), '{"torn": \n');
	appendRow(dir, { child: "ACME-2", attempt: 2, stage: "dispatched" });
	const { rows, skipped } = readRows(dir);
	expect(rows).toHaveLength(2);
	expect(skipped).toBe(1);
	expect(rows[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	expect(nextAttempt(rows, "ACME-2")).toBe(3);
	expect(nextAttempt(rows, "ACME-3")).toBe(1);
});

it("a row appended after a torn write that lost its newline is kept", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-"));
	appendRow(dir, { child: "ACME-2", attempt: 1, stage: "dispatched" });
	appendFileSync(join(dir, LOG), '{"child":"ACME-2","att');
	appendRow(dir, { child: "ACME-2", attempt: 1, stage: "result" });
	const { rows, skipped } = readRows(dir);
	expect(skipped).toBe(1);
	expect(rows.map((r) => r.stage)).toEqual(["dispatched", "result"]);
	expect(readFileSync(join(dir, LOG), "utf8").endsWith("}\n")).toBe(true);
});
