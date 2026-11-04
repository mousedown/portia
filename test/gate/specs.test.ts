import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	scenarioProblems,
	specChanges,
	specStep,
	titledWith,
} from "../../src/gate/specs";
import { fakeExec } from "../helpers/fake-exec";

const path = "packages/acme-web/e2e/a.e2e.ts";
const spec = (f1 = 'test("F1: one", () => {\n\texpect(1).toBe(1);\n});') =>
	[
		'import { expect, test } from "@playwright/test";',
		"",
		f1,
		"",
		'test("F2: two", async ({ page }) => {',
		'\tawait page.goto("/two");',
		"});",
		"",
	].join("\n");
const ids = ["F1", "F2"];
const owns = ["F1"];
const changes = (after: string | undefined, before = spec()) =>
	specChanges(path, before, after, ids, owns);

describe("specChanges: a child may change only its own scenarios", () => {
	it("allows a change confined to an owned scenario", () => {
		expect(
			changes(
				spec(
					'test("F1: one, renamed", async ({ page }) => {\n\tawait page.goto("/one");\n});',
				),
			),
		).toEqual([]);
	});

	it("allows a formatting-only change to another child's scenario", () => {
		expect(changes(spec().replace("await page", "  await  page"))).toEqual([]);
	});

	it("allows removing a skip marker from another child's scenario", () => {
		const skipped = spec().replace('test("F2', 'test.skip("F2');
		expect(changes(spec(), skipped)).toEqual([]);
		const it2 = spec().replace('test("F2', 'it("F2');
		expect(changes(it2, it2.replace('it("F2', 'xit("F2'))).toEqual([]);
	});

	it.each([
		["test.skip", 'test.skip("F2'],
		["test.fixme", 'test.fixme("F2'],
		["test.todo", 'test.todo("F2'],
		["xit", 'xit("F2'],
	])("fails a %s added to another child's scenario", (marker, to) => {
		expect(changes(spec().replace('test("F2', to))).toEqual([
			`spec ${path} marks F2 ${marker}; F2 is another child's scenario: remove the marker`,
		]);
	});

	it("fails a skip inside another child's scenario's body", () => {
		const r = changes(
			spec().replace(
				'\tawait page.goto("/two");',
				'\ttest.skip(true, "flaky");\n\tawait page.goto("/two");',
			),
		);
		expect(r).toEqual([
			`spec ${path} marks F2 test.skip; F2 is another child's scenario: remove the marker`,
		]);
	});

	it("fails a skipped describe around another child's scenario", () => {
		const wrapped = (d: string) =>
			spec().replace(
				'test("F2: two", async ({ page }) => {\n\tawait page.goto("/two");\n});',
				`${d}("group", () => {\n\ttest("F2: two", async ({ page }) => {\n\t\tawait page.goto("/two");\n\t});\n});`,
			);
		expect(
			changes(wrapped("test.describe.skip"), wrapped("test.describe")),
		).toEqual([
			`spec ${path} marks F2 test.describe.skip; F2 is another child's scenario: remove the marker`,
		]);
		expect(changes(wrapped("xdescribe"), wrapped("test.describe"))).toEqual([
			`spec ${path} marks F2 xdescribe; F2 is another child's scenario: remove the marker`,
		]);
	});

	it("fails a skip on a test inside another child's titled describe", () => {
		const grouped = (t: string) =>
			spec().replace(
				'test("F2: two", async ({ page }) => {\n\tawait page.goto("/two");\n});',
				`test.describe("F2: two", () => {\n\t${t}("loads", async ({ page }) => {\n\t\tawait page.goto("/two");\n\t});\n});`,
			);
		expect(changes(grouped("test.skip"), grouped("test"))).toEqual([
			`spec ${path} marks F2 test.skip; F2 is another child's scenario: remove the marker`,
		]);
		expect(changes(grouped("xit"), grouped("it"))).toEqual([
			`spec ${path} marks F2 xit; F2 is another child's scenario: remove the marker`,
		]);
	});

	it("fails a bare skip at the top of the file, which skips every scenario in it", () => {
		const r = changes(
			spec().replace('\n\ntest("F1', '\n\ntest.skip();\n\ntest("F1'),
		);
		expect(r).toEqual([
			`spec ${path} marks F2 test.skip; F2 is another child's scenario: remove the marker`,
		]);
	});

	it("fails a .only anywhere, even on an owned scenario: it stops the others running", () => {
		expect(changes(spec().replace('test("F1', 'test.only("F1'))).toEqual([
			`spec ${path} adds test.only, which stops F2 (another child's scenario) from running: remove it`,
		]);
	});

	it("allows a skip marker on an owned scenario", () => {
		expect(changes(spec().replace('test("F1', 'test.skip("F1'))).toEqual([]);
	});

	it("fails another child's scenario renamed or removed", () => {
		const gone = [
			`spec ${path} no longer has a test titled with F2; F2 is another child's scenario: restore it`,
		];
		expect(changes(spec().replace('"F2: two"', '"two"'))).toEqual(gone);
		expect(changes(spec().replace('"F2: two"', '"F3: two"'))).toEqual(gone);
		expect(changes(spec().slice(0, spec().indexOf('test("F2')))).toEqual(gone);
	});

	it("fails a change to the body of another child's scenario", () => {
		expect(changes(spec().replace('"/two"', '"/elsewhere"'))).toEqual([
			`spec ${path} changes the test titled with F2; F2 is another child's scenario: revert it`,
		]);
	});

	it("fails the file deleted", () => {
		expect(changes(undefined)).toEqual([
			`spec ${path} was deleted; it holds F2, another child's scenario: restore it`,
		]);
	});

	it("checks nothing for a file absent at the base, or one this child owns whole", () => {
		expect(
			specChanges(path, undefined, spec().replace('"/two"', '"/x"'), ids, owns),
		).toEqual([]);
		expect(specChanges(path, spec(), undefined, ids, ["F1", "F2"])).toEqual([]);
	});

	it("ignores another child's scenario that the base never titled", () => {
		const before = spec().replace('"F2: two"', '"two"');
		expect(changes(before.replace('"/two"', '"/x"'), before)).toEqual([]);
	});
});

describe("scenarioProblems: the epic gate's check of every planned scenario", () => {
	const root = () => {
		const r = mkdtempSync(join(tmpdir(), "portia-specs-"));
		mkdirSync(join(r, "packages/acme-web/e2e"), { recursive: true });
		return r;
	};
	const scenarios = [
		{ id: "F1", path },
		{ id: "F2", path },
	];

	it("passes every scenario titled and unmarked", () => {
		const r = root();
		writeFileSync(join(r, path), spec());
		expect(scenarioProblems(r, scenarios)).toEqual([]);
	});

	it("fails a scenario no longer titled, or whose spec is gone", () => {
		const r = root();
		writeFileSync(join(r, path), spec().replace('"F2: two"', '"two"'));
		expect(scenarioProblems(r, scenarios)).toEqual([
			`spec ${path} has no test titled with F2`,
		]);
		expect(
			scenarioProblems(r, [
				{ id: "F3", path: "packages/acme-web/e2e/c.e2e.ts" },
			]),
		).toEqual([
			"spec packages/acme-web/e2e/c.e2e.ts has no test titled with F3",
		]);
	});

	it("fails a scenario marked skip, only, fixme or todo", () => {
		const r = root();
		writeFileSync(
			join(r, path),
			spec()
				.replace('test("F1', 'test.only("F1')
				.replace('test("F2', 'test.fixme("F2'),
		);
		expect(scenarioProblems(r, scenarios)).toEqual([
			`spec ${path} marks F1 test.only`,
			`spec ${path} marks F2 test.fixme`,
		]);
	});

	it("fails a skipped test inside a scenario's titled describe", () => {
		const r = root();
		writeFileSync(
			join(r, path),
			spec().replace(
				'test("F2: two", async ({ page }) => {\n\tawait page.goto("/two");\n});',
				'test.describe("F2: two", () => {\n\ttest.skip("loads", async ({ page }) => {\n\t\tawait page.goto("/two");\n\t});\n});',
			),
		);
		expect(scenarioProblems(r, scenarios)).toEqual([
			`spec ${path} marks F2 test.skip`,
		]);
	});
});

describe("specStep", () => {
	const guard = { specs: { F1: path, F2: path }, owns: ["F1"] };
	const worktree = (src?: string) => {
		const wt = mkdtempSync(join(tmpdir(), "portia-wt-"));
		mkdirSync(join(wt, "packages/acme-web/e2e"), { recursive: true });
		if (src !== undefined) writeFileSync(join(wt, path), src);
		return wt;
	};
	const git = (before?: string) =>
		fakeExec((c) => {
			if (c.args[0] === "merge-base") return { stdout: "abc123\n" };
			if (c.args[0] === "show")
				return before === undefined
					? { code: 128, stderr: "fatal: path does not exist" }
					: { stdout: before };
			return undefined;
		});

	it("compares the worktree's spec with the merge base's", async () => {
		const { exec, calls, line } = git(spec());
		const r = await specStep(
			exec,
			worktree(spec().replace('test("F2', 'test.skip("F2')),
			"origin/portia/ACME-0",
			guard,
		);
		expect(r).toEqual({
			name: "specs",
			ok: false,
			tail: `spec ${path} marks F2 test.skip; F2 is another child's scenario: remove the marker`,
		});
		expect(calls.map(line)).toEqual([
			"git merge-base origin/portia/ACME-0 HEAD",
			`git show abc123:${path}`,
		]);
	});

	it("passes an unchanged spec and one the base does not have", async () => {
		expect(
			(await specStep(git(spec()).exec, worktree(spec()), "b", guard)).ok,
		).toBe(true);
		expect((await specStep(git().exec, worktree(spec()), "b", guard)).ok).toBe(
			true,
		);
	});

	it("fails closed when git cannot read the base's spec for another reason", async () => {
		const { exec } = fakeExec((c) =>
			c.args[0] === "merge-base"
				? { stdout: "abc123\n" }
				: { code: 128, stderr: "fatal: unable to read tree abc123" },
		);
		const r = await specStep(exec, worktree(), "b", guard);
		expect(r).toMatchObject({ name: "specs", ok: false });
		expect(r.tail).toContain("unable to read tree");
	});

	it("fails closed when the merge base cannot be found", async () => {
		const { exec } = fakeExec(() => ({ code: 128, stderr: "fatal: bad rev" }));
		const r = await specStep(exec, worktree(spec()), "b", guard);
		expect(r).toMatchObject({ name: "specs", ok: false });
		expect(r.tail).toContain("fatal: bad rev");
	});
});

it("titledWith also recognises a scenario behind an x-prefixed call", () => {
	expect(titledWith('xit("F1: one", () => {})', "F1")).toBe(true);
	expect(titledWith('xdescribe("F1: one", () => {})', "F1")).toBe(true);
});
