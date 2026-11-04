import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	approvedGlobs,
	approveTouches,
	readApprovals,
} from "../../src/core/approvals";
import { PortiaProblem } from "../../src/core/exit";

const dir = () => mkdtempSync(join(tmpdir(), "portia-approvals-"));

it("records approved globs per child, with when and why, once each", () => {
	const d = dir();
	expect(readApprovals(d, "ACME-2")).toEqual([]);
	approveTouches(
		d,
		"ACME-2",
		["src/a.ts", "src/b/**"],
		"registers its function",
	);
	approveTouches(d, "ACME-2", ["src/a.ts", "src/c.ts"]);
	expect(approvedGlobs(d, "ACME-2")).toEqual([
		"src/a.ts",
		"src/b/**",
		"src/c.ts",
	]);
	expect(readApprovals(d, "ACME-2")[0]).toMatchObject({
		glob: "src/a.ts",
		by: "person",
		why: "registers its function",
		at: expect.any(String),
	});
	expect(readApprovals(d, "ACME-2")[2]?.why).toBeUndefined();
	expect(approvedGlobs(d, "ACME-3")).toEqual([]);
});

it("refuses no globs, absolute paths and '..'", () => {
	const d = dir();
	for (const globs of [[], ["/etc/passwd"], ["src/../../x"]])
		expect(() => approveTouches(d, "ACME-2", globs)).toThrow(PortiaProblem);
});
