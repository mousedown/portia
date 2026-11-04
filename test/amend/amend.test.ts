import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { amendmentProblems } from "../../src/amend/amend";
import { testProfile } from "../../src/core/config";
import { spawnExec } from "../../src/core/exec";

const SPEC = "specs/launch/R6.accept.ts";
const before = [
	'test("R6: the customer gets a telegram", async () => {',
	"\tconst res = await launch();",
	"\texpect(res.body).toMatchObject({ launchedAt: expect.any(String) });",
	"\texpect(Number.isNaN(Date.parse(res.body.launchedAt))).toBe(false);",
	"});",
	"",
].join("\n");

/** A repo whose spec is committed as `before`; returns it and the base commit. */
function repo(): { wt: string; base: string } {
	const wt = mkdtempSync(join(tmpdir(), "portia-amend-"));
	const git = (...a: string[]) =>
		execFileSync("git", a, { cwd: wt, encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	mkdirSync(join(wt, "specs/launch"), { recursive: true });
	writeFileSync(join(wt, SPEC), before);
	git("add", "-A");
	git("commit", "-q", "-m", "spec");
	return { wt, base: git("rev-parse", "HEAD") };
}
const change = (wt: string, files: Record<string, string>) => {
	for (const [f, text] of Object.entries(files)) {
		mkdirSync(join(wt, f, ".."), { recursive: true });
		writeFileSync(join(wt, f), text);
	}
	execFileSync("git", ["add", "-A"], { cwd: wt });
	execFileSync("git", ["commit", "-q", "-m", "amend"], { cwd: wt });
};
const problems = (wt: string, base: string) =>
	amendmentProblems(
		spawnExec,
		{ ...testProfile(), packageDir: "." },
		wt,
		base,
		{
			path: SPEC,
			scenario: "R6",
		},
	);

describe("amendmentProblems", () => {
	it("passes a reorder that keeps every assertion, in the spec alone", async () => {
		const { wt, base } = repo();
		change(wt, {
			[SPEC]: before
				.replace(
					"\tconst res = await launch();",
					"\tconst res = await launch();\n\tconst launchedAt = res.body.launchedAt;",
				)
				.replace("Date.parse(res.body.launchedAt)", "Date.parse(launchedAt)"),
		});
		expect(await problems(wt, base)).toEqual([]);
	});

	it("refuses one that drops an assertion, skips the scenario or changes another file", async () => {
		const { wt, base } = repo();
		change(wt, {
			[SPEC]: before
				.replace('test("R6:', 'test.skip("R6:')
				.replace(
					"\texpect(Number.isNaN(Date.parse(res.body.launchedAt))).toBe(false);\n",
					"",
				),
			"src/launch/route.ts": "export const launch = () => 1;\n",
		});
		const found = await problems(wt, base);
		expect(found).toContain(
			"it changes src/launch/route.ts, outside the spec it amends",
		);
		expect(found).toContain(`the amended spec ${SPEC} marks R6 test.skip`);
		expect(found).toContain(
			"R6 makes 2 assertions where it made 3: every clause stays asserted",
		);
	});

	it("refuses one that leaves the spec as it was", async () => {
		const { wt, base } = repo();
		change(wt, { "notes.md": "x\n" });
		expect(await problems(wt, base)).toContain(`it does not change ${SPEC}`);
	});
});
