import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { readRows } from "../../src/core/runlog";
import { runGate } from "../../src/gate/run";
import { titledWith } from "../../src/gate/specs";
import { ownedForGate } from "../../src/plan/owned";
import { fakeExec } from "../helpers/fake-exec";
import { child, parent, spine } from "../helpers/plan";

const profile = {
	...testProfile(),
	packageDir: "packages/acme-web",
	gates: {
		task: [
			{
				name: "lint",
				cmd: "bunx eslint {files}",
				heavy: false,
				cwd: "package" as const,
			},
		],
		exit: [
			{
				name: "unit",
				cmd: "bunx jest --ci --no-cache",
				heavy: true,
				cwd: "package" as const,
			},
			{
				name: "integration",
				cmd: "bunx vitest run --changed {base}",
				heavy: true,
				cwd: "package" as const,
			},
		],
		epic: [],
	},
};
const env = {
	worktree: "/wt/ACME-2",
	branch: "portia/ACME-2",
	db: "d",
	port: 3100,
	envFile: "/nonexistent",
};
const dir = () => mkdtempSync(join(tmpdir(), "portia-gate-"));

const worktree = () => {
	const wt = mkdtempSync(join(tmpdir(), "portia-wt-"));
	mkdirSync(join(wt, "packages/acme-web/src"), { recursive: true });
	for (const f of ["src/a.ts", "src/a b.ts"])
		writeFileSync(join(wt, "packages/acme-web", f), "");
	writeFileSync(join(wt, "root.ts"), "");
	return wt;
};

it("substitutes files, runs in the package dir, and stops at the first failure", async () => {
	const wt = worktree();
	const { exec, calls } = fakeExec((c) =>
		c.args[1]?.includes("--no-cache")
			? { code: 1, stdout: "1 failed" }
			: undefined,
	);
	const task = await runGate("task", {
		exec,
		profile,
		dir: dir(),
		env: { ...env, worktree: wt },
		parent: "ACME-0",
		touched: ["packages/acme-web/src/a.ts"],
	});
	expect(task.ok).toBe(true);
	expect(calls[0]).toMatchObject({
		cmd: "sh",
		args: ["-c", "bunx eslint 'src/a.ts'"],
		cwd: join(wt, "packages/acme-web"),
	});
	const exit = await runGate("exit", {
		exec,
		profile,
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
	});
	expect(exit.ok).toBe(false);
	expect(exit.steps.map((s) => s.name)).toEqual(["unit"]);
	expect(exit.steps[0]?.tail).toContain("1 failed");
});

it("{base} is origin/<integration branch>, or the commit a land pinned it to", async () => {
	const { exec, calls } = fakeExec(() => undefined);
	const vitestCmd = () =>
		calls.filter((c) => c.cmd === "sh").at(-1)?.args[1] ?? "";
	await runGate("exit", {
		exec,
		profile,
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
	});
	expect(vitestCmd()).toBe("bunx vitest run --changed origin/portia/ACME-0");
	await runGate("exit", {
		exec,
		profile,
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
		base: "abc123",
	});
	expect(vitestCmd()).toBe("bunx vitest run --changed abc123");
	expect(
		calls.some((c) => c.cmd === "git" && c.args.includes("abc123...HEAD")),
	).toBe(true);
});

it("adds the design check, then the debt and secret checks, to the exit gate", async () => {
	const { exec } = fakeExec((c) =>
		c.args[0] === "diff"
			? {
					stdout:
						"+++ b/packages/acme-web/src/x.ts\n+  await db.user.create({})",
				}
			: undefined,
	);
	const p = {
		...profile,
		gates: { ...profile.gates, exit: [] },
		debt: [{ name: "direct-db", pattern: "\\bdb\\.\\w+\\.create\\(" }],
	};
	const r = await runGate("exit", {
		exec,
		profile: p,
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
		designCheck: async () => ({ ok: true, tail: "PASS" }),
	});
	expect(r.steps.map((s) => [s.name, s.ok])).toEqual([
		["design", true],
		["debt", false],
		["secrets", true],
	]);
});

it("fails the exit gate, before the design check, when a spec changes another child's scenario", async () => {
	const wt = worktree();
	const spec = "packages/acme-web/e2e/a.e2e.ts";
	const before = 'test("F1: one", () => {});\ntest("F2: two", () => {});\n';
	mkdirSync(join(wt, "packages/acme-web/e2e"), { recursive: true });
	writeFileSync(join(wt, spec), before.replace('test("F2', 'test.skip("F2'));
	const { exec } = fakeExec((c) =>
		c.args[0] === "merge-base"
			? { stdout: "abc123\n" }
			: c.args[0] === "show"
				? { stdout: before }
				: undefined,
	);
	let designed = false;
	const r = await runGate("exit", {
		exec,
		profile: { ...profile, gates: { ...profile.gates, exit: [] } },
		dir: dir(),
		env: { ...env, worktree: wt },
		parent: "ACME-0",
		touched: [],
		designCheck: async () => {
			designed = true;
			return { ok: true, tail: "PASS" };
		},
		guard: { specs: { F1: "e2e/a.e2e.ts", F2: "e2e/a.e2e.ts" }, owns: ["F1"] },
	});
	expect(r.ok).toBe(false);
	expect(r.steps).toEqual([
		{
			name: "specs",
			ok: false,
			tail: `spec ${spec} marks F2 test.skip; F2 is another child's scenario: remove the marker`,
		},
	]);
	expect(designed).toBe(false);
});

it("passes only existing package files, quoted", async () => {
	const wt = worktree();
	const { exec, calls } = fakeExec();
	await runGate("task", {
		exec,
		profile,
		dir: dir(),
		env: { ...env, worktree: wt },
		parent: "ACME-0",
		touched: [
			"packages/acme-web/src/deleted.ts",
			"root.ts",
			"packages/acme-web/src/a b.ts",
		],
	});
	expect(calls[0]?.args).toEqual(["-c", "bunx eslint 'src/a b.ts'"]);
});

it("fails the debt check when the diff itself fails", async () => {
	const { exec } = fakeExec((c) =>
		c.args[0] === "diff" ? { code: 128, stderr: "bad revision" } : undefined,
	);
	const p = { ...profile, gates: { ...profile.gates, exit: [] } };
	const r = await runGate("exit", {
		exec,
		profile: p,
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
	});
	expect(r.ok).toBe(false);
	expect(r.steps).toEqual([
		{ name: "debt", ok: false, tail: "bad revision" },
		{ name: "secrets", ok: false, tail: "bad revision" },
	]);
});

it("fails the exit gate on a secret in an added line, naming file:line and rule but not the value", async () => {
	const key = `AK${"IA"}Q3TZ7RKX2M5VB8NW`;
	const { exec, calls } = fakeExec((c) =>
		c.args[0] === "diff"
			? { stdout: `+++ b/src/x.ts\n@@ -4,0 +5 @@\n+const id = "${key}";` }
			: undefined,
	);
	const p = { ...profile, gates: { ...profile.gates, exit: [] } };
	const r = await runGate("exit", {
		exec,
		profile: p,
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
		base: "abc123",
	});
	expect(r.ok).toBe(false);
	expect(r.steps.at(-1)).toEqual({
		name: "secrets",
		ok: false,
		tail: "secret aws-access-key-id: src/x.ts:5",
	});
	expect(JSON.stringify(r)).not.toContain(key);
	expect(
		calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" ")),
	).toContain("diff -U0 abc123...HEAD");
	const allowed = await runGate("exit", {
		exec,
		profile: {
			...p,
			gates: { ...p.gates, secretScan: { allow: ["src/**"] } },
		},
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
	});
	expect(allowed.ok).toBe(true);
});

it("withholds a debt hit's line when it looks like a secret", async () => {
	const key = `AK${"IA"}Q3TZ7RKX2M5VB8NW`;
	const { exec } = fakeExec((c) =>
		c.args[0] === "diff"
			? {
					stdout: `+++ b/src/x.ts\n@@ -4,0 +5 @@\n+db.user.create({ id: "${key}" })`,
				}
			: undefined,
	);
	const r = await runGate("exit", {
		exec,
		profile: {
			...profile,
			gates: { ...profile.gates, exit: [] },
			debt: [{ name: "direct-db", pattern: "\\bdb\\.\\w+\\.create\\(" }],
		},
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
	});
	expect(r.steps.find((s) => s.name === "debt")?.tail).toBe(
		"direct-db: src/x.ts: (line withheld: it looks like a secret)",
	);
	expect(JSON.stringify(r)).not.toContain(key);
});

it("substitutes {child} and {parent} in a gate command", async () => {
	const { exec, calls } = fakeExec();
	const p = {
		...profile,
		gates: {
			...profile.gates,
			task: [
				{
					name: "tc",
					cmd: "portia gate typecheck-touched {child} --parent {parent}",
					heavy: false,
					cwd: "root" as const,
				},
			],
		},
	};
	await runGate("task", {
		exec,
		profile: p,
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
	});
	expect(calls[0]?.args).toEqual([
		"-c",
		"portia gate typecheck-touched ACME-2 --parent ACME-0",
	]);
});

it("skips a {files} step when no files remain, and runs nothing for it", async () => {
	const wt = worktree();
	const { exec, calls } = fakeExec();
	const r = await runGate("task", {
		exec,
		profile,
		dir: dir(),
		env: { ...env, worktree: wt },
		parent: "ACME-0",
		touched: ["root.ts", "packages/acme-web/src/deleted.ts"],
	});
	expect(r.ok).toBe(true);
	expect(r.steps).toEqual([
		{ name: "lint", ok: true, tail: "skipped: no files" },
	]);
	expect(calls).toHaveLength(0);
});

it("passes touched files to {files} gates when packageDir is '.'", async () => {
	const wt = mkdtempSync(join(tmpdir(), "portia-wt-"));
	mkdirSync(join(wt, "src"), { recursive: true });
	writeFileSync(join(wt, "src/a.ts"), "");
	const { exec, calls } = fakeExec();
	const r = await runGate("task", {
		exec,
		profile: { ...profile, packageDir: "." },
		dir: dir(),
		env: { ...env, worktree: wt },
		parent: "ACME-0",
		touched: ["src/a.ts"],
	});
	expect(r.steps[0]?.tail).not.toContain("skipped");
	expect(calls[0]?.args).toEqual(["-c", "bunx eslint 'src/a.ts'"]);
});

const exitWithDebtDiff = async (parent: string, added: string) => {
	const { exec } = fakeExec((c) =>
		c.args[0] === "diff" ? { stdout: `+++ b/src/x.ts\n+${added}` } : undefined,
	);
	const r = await runGate("exit", {
		exec,
		profile: { ...profile, gates: { ...profile.gates, exit: [] } },
		dir: dir(),
		env,
		parent,
		touched: [],
	});
	return r.steps.find((s) => s.name === "debt")?.ok;
};

it("the ticket-history rule only matches the parent's key prefix", async () => {
	for (const c of [
		"// UTF-8 decoding replaced the latin1 path",
		"// SHA-256 previously MD5",
		"// ISO-8601 dates now uses Temporal",
	])
		expect(await exitWithDebtDiff("ACME-1", c)).toBe(true);
	expect(await exitWithDebtDiff("ACME-1", "// ACME-12 replaced by x")).toBe(
		false,
	);
	expect(await exitWithDebtDiff("GH-1", "// GH-3 replaced by x")).toBe(false);
	expect(await exitWithDebtDiff("GH-1", "// ACME-3 replaced by x")).toBe(true);
});

const acceptanceProfile = {
	...profile,
	gates: {
		...profile.gates,
		exit: [
			{
				name: "acceptance",
				cmd: 'bunx playwright test {owned} -g "{ownedGrep}"',
				heavy: true,
				cwd: "package" as const,
			},
		],
	},
};

it("fills {owned} and {ownedGrep} and runs the step with the worker's .env.portia", async () => {
	const wt = worktree();
	const envFile = join(wt, ".env.portia");
	writeFileSync(envFile, "PORT=3105\nDATABASE_URL=postgres://x/y?a=b\n");
	mkdirSync(join(wt, "packages/acme-web/e2e/onboarding"), { recursive: true });
	writeFileSync(
		join(wt, "packages/acme-web/e2e/onboarding/cold start.e2e.ts"),
		'test.describe("F2: two", () => {});\ntest(`F3: three`, async () => {});\n',
	);
	writeFileSync(
		join(wt, "packages/acme-web/e2e/b.e2e.ts"),
		"test.only( 'F4: four', async () => {});\n",
	);
	const { exec, calls } = fakeExec();
	const r = await runGate("exit", {
		exec,
		profile: acceptanceProfile,
		dir: dir(),
		env: { ...env, worktree: wt, envFile },
		parent: "ACME-0",
		touched: [],
		owned: [
			{ id: "F2", path: "packages/acme-web/e2e/onboarding/cold start.e2e.ts" },
			{ id: "F3", path: "packages/acme-web/e2e/onboarding/cold start.e2e.ts" },
			{ id: "F4", path: "packages/acme-web/e2e/b.e2e.ts" },
		],
	});
	expect(r.steps[0]).toMatchObject({ name: "acceptance", ok: true });
	expect(calls[0]?.args).toEqual([
		"-c",
		"bunx playwright test 'e2e/onboarding/cold start.e2e.ts' 'e2e/b.e2e.ts' -g \"F2|F3|F4\"",
	]);
	expect(calls[0]?.env).toMatchObject({
		PORT: "3105",
		DATABASE_URL: "postgres://x/y?a=b",
	});
});

it("skips an {owned} step for the spine or a child with no scenarios", async () => {
	for (const owned of [undefined, []]) {
		const { exec, calls } = fakeExec();
		const r = await runGate("exit", {
			exec,
			profile: acceptanceProfile,
			dir: dir(),
			env,
			parent: "ACME-0",
			touched: [],
			owned,
		});
		expect(r.steps[0]).toEqual({
			name: "acceptance",
			ok: true,
			tail: "skipped: no owned scenarios",
		});
		expect(calls.filter((c) => c.cmd === "sh")).toHaveLength(0);
	}
});

it("fails an {owned} step, running nothing, when a spec has no test titled with an owned id", async () => {
	const wt = worktree();
	mkdirSync(join(wt, "packages/acme-web/e2e"), { recursive: true });
	writeFileSync(
		join(wt, "packages/acme-web/e2e/a.e2e.ts"),
		'test("F1: one", async () => {});\ntest("cold start F2: two", async () => {});\ntest("F10: ten", async () => {});\n',
	);
	const { exec, calls } = fakeExec();
	const r = await runGate("exit", {
		exec,
		profile: acceptanceProfile,
		dir: dir(),
		env: { ...env, worktree: wt },
		parent: "ACME-0",
		touched: [],
		owned: [
			{ id: "F1", path: "packages/acme-web/e2e/a.e2e.ts" },
			{ id: "F2", path: "packages/acme-web/e2e/a.e2e.ts" },
			{ id: "F3", path: "packages/acme-web/e2e/missing.e2e.ts" },
		],
	});
	expect(r.ok).toBe(false);
	expect(r.steps).toEqual([
		{
			name: "acceptance",
			ok: false,
			tail: [
				"spec packages/acme-web/e2e/a.e2e.ts has no test titled with F2",
				"spec packages/acme-web/e2e/missing.e2e.ts has no test titled with F3",
			].join("\n"),
		},
	]);
	expect(calls.filter((c) => c.cmd === "sh")).toHaveLength(0);
});

it("reads an {owned} spec written relative to the package, and passes it package-relative", async () => {
	const wt = worktree();
	mkdirSync(join(wt, "packages/acme-web/e2e"), { recursive: true });
	writeFileSync(
		join(wt, "packages/acme-web/e2e/a.e2e.ts"),
		'test("F1: one", async () => {});\n',
	);
	const { exec, calls } = fakeExec();
	const r = await runGate("exit", {
		exec,
		profile: acceptanceProfile,
		dir: dir(),
		env: { ...env, worktree: wt },
		parent: "ACME-0",
		touched: [],
		owned: [{ id: "F1", path: "e2e/a.e2e.ts" }],
	});
	expect(r.steps[0]?.tail ?? "").not.toContain("has no test titled");
	const sh = calls.filter((c) => c.cmd === "sh");
	expect(sh).toHaveLength(1);
	expect(JSON.stringify(sh[0])).toContain("e2e/a.e2e.ts");
	expect(JSON.stringify(sh[0])).not.toContain("../");
});

it("skips an {owned} step naming the children its scenarios still wait on", async () => {
	const { exec, calls } = fakeExec();
	const r = await runGate("exit", {
		exec,
		profile: acceptanceProfile,
		dir: dir(),
		env,
		parent: "ACME-0",
		touched: [],
		owned: [],
		waitingOn: ["ACME-502", "ACME-503"],
	});
	expect(r.steps[0]).toEqual({
		name: "acceptance",
		ok: true,
		tail: "skipped: no owned scenarios ready (waiting on ACME-502, ACME-503)",
	});
	expect(calls.filter((c) => c.cmd === "sh")).toHaveLength(0);
});

it("runs the regression guard as a copy of the {owned} step, right after it, on the landed children's scenarios", async () => {
	const wt = worktree();
	mkdirSync(join(wt, "packages/acme-web/e2e"), { recursive: true });
	writeFileSync(
		join(wt, "packages/acme-web/e2e/a.e2e.ts"),
		'test("F1: one", async () => {});\ntest("F2: two", async () => {});\n',
	);
	writeFileSync(
		join(wt, "packages/acme-web/e2e/b.e2e.ts"),
		'test("F3: three", async () => {});\n',
	);
	const { exec, calls } = fakeExec((c) =>
		c.args[1]?.includes("F2|F3") ? { code: 1, stdout: "F3 failed" } : undefined,
	);
	const r = await runGate("exit", {
		exec,
		profile: {
			...acceptanceProfile,
			gates: {
				...acceptanceProfile.gates,
				exit: [
					...acceptanceProfile.gates.exit,
					{ name: "lint", cmd: "bun run lint", heavy: false, cwd: "root" },
				],
			},
		},
		dir: dir(),
		env: { ...env, worktree: wt },
		parent: "ACME-0",
		touched: [],
		owned: [{ id: "F1", path: "packages/acme-web/e2e/a.e2e.ts" }],
		regressionGuard: [
			{ id: "F2", path: "packages/acme-web/e2e/a.e2e.ts" },
			{ id: "F3", path: "packages/acme-web/e2e/b.e2e.ts" },
		],
	});
	expect(r.ok).toBe(false);
	expect(r.steps.map((s) => [s.name, s.ok])).toEqual([
		["acceptance", true],
		["regression-guard", false],
	]);
	expect(r.steps[1]?.tail).toContain("F3 failed");
	expect(calls.filter((c) => c.cmd === "sh").map((c) => c.args[1])).toEqual([
		"bunx playwright test 'e2e/a.e2e.ts' -g \"F1\"",
		"bunx playwright test 'e2e/a.e2e.ts' 'e2e/b.e2e.ts' -g \"F2|F3\"",
	]);
});

it("runs the regression guard when the child owns no scenario, and adds no step when nothing landed owns one", async () => {
	const wt = worktree();
	mkdirSync(join(wt, "packages/acme-web/e2e"), { recursive: true });
	writeFileSync(
		join(wt, "packages/acme-web/e2e/a.e2e.ts"),
		'test("F2: two", async () => {});\n',
	);
	const gate = (regressionGuard?: { id: string; path: string }[]) => {
		const f = fakeExec();
		return runGate("exit", {
			exec: f.exec,
			profile: acceptanceProfile,
			dir: dir(),
			env: { ...env, worktree: wt },
			parent: "ACME-0",
			touched: [],
			owned: [],
			regressionGuard,
		}).then((r) => ({ r, sh: f.calls.filter((c) => c.cmd === "sh") }));
	};
	const some = await gate([
		{ id: "F2", path: "packages/acme-web/e2e/a.e2e.ts" },
	]);
	expect(some.r.steps.map((s) => [s.name, s.tail])).toEqual([
		["acceptance", "skipped: no owned scenarios"],
		["regression-guard", ""],
		["debt", ""],
		["secrets", ""],
	]);
	expect(some.sh.map((c) => c.args[1])).toEqual([
		"bunx playwright test 'e2e/a.e2e.ts' -g \"F2\"",
	]);
	for (const none of [undefined, []]) {
		const { r, sh } = await gate(none);
		expect(r.steps.map((s) => s.name)).toEqual([
			"acceptance",
			"debt",
			"secrets",
		]);
		expect(sh).toHaveLength(0);
	}
});

it("runs every step with the profile's gateEnv under the worker's .env.portia", async () => {
	const wt = worktree();
	const envFile = join(wt, ".env.portia");
	writeFileSync(envFile, "SHARED=from-worker\n");
	const { exec, calls } = fakeExec();
	await runGate("exit", {
		exec,
		profile: {
			...profile,
			gateEnv: { PAYMENTS_KEY: "pk_test", SHARED: "from-profile", TZ: "UTC" },
		},
		dir: dir(),
		env: { ...env, worktree: wt, envFile },
		parent: "ACME-0",
		touched: [],
	});
	for (const c of calls.filter((x) => x.cmd === "sh"))
		expect(c.env).toMatchObject({
			PAYMENTS_KEY: "pk_test",
			SHARED: "from-worker",
			TZ: "UTC",
		});
});

it("runs a whenTouches step only when a changed file matches its globs", async () => {
	const p = {
		...profile,
		gates: {
			...profile.gates,
			exit: [
				{
					name: "moderation",
					cmd: "cd packages/moderation && bunx jest",
					heavy: false,
					cwd: "root" as const,
					whenTouches: [
						"packages/moderation/**",
						"packages/acme-web/src/lib/notify/templates.ts",
					],
				},
			],
		},
	};
	const run = async (touched: string[]) => {
		const { exec, calls } = fakeExec();
		const r = await runGate("exit", {
			exec,
			profile: p,
			dir: dir(),
			env,
			parent: "ACME-0",
			touched,
		});
		return { r, ran: calls.some((c) => c.cmd === "sh") };
	};
	const skipped = await run(["packages/acme-web/src/a.ts"]);
	expect(skipped.ran).toBe(false);
	expect(skipped.r.steps[0]).toMatchObject({ name: "moderation", ok: true });
	expect(skipped.r.steps[0]?.tail).toMatch(/^skipped: no changed file matches/);
	for (const f of [
		"packages/moderation/src/x.ts",
		"packages/acme-web/src/lib/notify/templates.ts",
	])
		expect((await run([f])).ran).toBe(true);
});

describe("titledWith", () => {
	it.each([
		['test("F1: one", () => {})', "plain"],
		["it('F1: one', () => {})", "single quotes"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: test source as text
		["it(`F1: one ${x}`, () => {})", "a template literal"],
		['test.describe("F1: one", () => {})', "describe"],
		['it.only("F1: one", () => {})', "it.only"],
		['it.concurrent("F1: one", async () => {})', "it.concurrent"],
		['it.each([1, 2])("F1: one %i", (n) => {})', "it.each"],
		[
			'it.each([\n  { a: "(", b: [1] }, // don\'t\n  { a: ")", b: [2] },\n])(\n  "F1: one $a",\n  ({ a }) => {},\n)',
			"a multi-line it.each table with brackets, quotes and a comment",
		],
		["test.each([[1, 2]])(`F1: one`, () => {})", "test.each"],
		['test.concurrent.each([1])("F1: one", () => {})', "test.concurrent.each"],
		['describe.each([1])("F1: one", () => {})', "describe.each"],
		[
			'it.each<{ n: number }>([{ n: 1 }])("F1: one", () => {})',
			"typed it.each",
		],
		[
			// biome-ignore lint/suspicious/noTemplateCurlyInString: test source as text
			'test.each`\n  a | b\n  ${1} | ${2}\n`("F1: one", () => {})',
			"a tagged table",
		],
	])("recognises %s (%s)", (src) => {
		expect(titledWith(src, "F1")).toBe(true);
	});
	it.each([
		['test("cold start F1: one", () => {})', "the id not at the start"],
		['test("F10: ten", () => {})', "a longer id"],
		["it.each([1])(name, () => {})", "a non-literal title"],
		['it.each(["F1: one"])("%s", () => {})', "the id only in the table"],
		["const it = 1;", "no call"],
	])("rejects %s (%s)", (src) => {
		expect(titledWith(src, "F1")).toBe(false);
	});
});

it("retries a failing step up to its retries, and the last run's result stands", async () => {
	const p = (retries?: number) => ({
		...profile,
		gates: {
			...profile.gates,
			exit: [
				{
					name: "unit",
					cmd: "bunx jest",
					heavy: true,
					cwd: "package" as const,
					retries,
				},
			],
		},
	});
	const gate = async (retries: number | undefined, failures: number) => {
		let n = 0;
		const { exec, calls } = fakeExec((c) =>
			c.cmd === "sh" && n++ < failures
				? { code: 139, stdout: "SIGSEGV" }
				: undefined,
		);
		const r = await runGate("exit", {
			exec,
			profile: p(retries),
			dir: dir(),
			env,
			parent: "ACME-0",
			touched: [],
		});
		return { r, runs: calls.filter((c) => c.cmd === "sh").length };
	};
	const flaky = await gate(1, 1);
	expect(flaky.runs).toBe(2);
	expect(flaky.r.steps[0]).toMatchObject({ name: "unit", ok: true });
	expect(flaky.r.steps[0]?.tail).toMatch(/^\(retried 1x\)/);
	const broken = await gate(1, 5);
	expect(broken.runs).toBe(2);
	expect(broken.r.steps[0]?.ok).toBe(false);
	const once = await gate(undefined, 1);
	expect(once.runs).toBe(1);
	expect(once.r.steps[0]?.ok).toBe(false);
	const green = await gate(1, 0);
	expect(green.runs).toBe(1);
	expect(green.r.steps[0]?.tail).not.toContain("retried");
});

it("skips a step outside the child's lane; an unset lane is full", async () => {
	const p = {
		...profile,
		gates: {
			...profile.gates,
			exit: [
				{
					name: "unit",
					cmd: "bunx jest",
					heavy: false,
					cwd: "package" as const,
				},
				{
					name: "e2e",
					cmd: "bunx playwright test",
					heavy: true,
					cwd: "package" as const,
					lanes: ["full"] as ["full"],
				},
			],
		},
	};
	const gate = async (lane?: "light" | "full") => {
		const { exec, calls } = fakeExec();
		const r = await runGate("exit", {
			exec,
			profile: p,
			dir: dir(),
			env,
			parent: "ACME-0",
			touched: [],
			lane,
		});
		const sh = calls.filter((c) => c.cmd === "sh").map((c) => c.args[1]);
		return { r, sh };
	};
	const light = await gate("light");
	expect(light.r.ok).toBe(true);
	expect(light.sh).toEqual(["bunx jest"]);
	expect(light.r.steps[1]).toEqual({
		name: "e2e",
		ok: true,
		tail: "skipped: not run in the light lane",
	});
	expect((await gate("full")).sh).toEqual([
		"bunx jest",
		"bunx playwright test",
	]);
	expect((await gate()).sh).toEqual(["bunx jest", "bunx playwright test"]);
});

describe("the spine's exit gate runs only the scenarios it owns", () => {
	const plan = parent(
		[
			spine({
				requirements: ["R1"],
				acceptance: {
					R1: "packages/acme-web/e2e/record.e2e.ts",
					R2: "packages/acme-web/e2e/list.e2e.ts",
					R3: "packages/acme-web/e2e/list.e2e.ts",
				},
			}),
			child("ACME-2", { requirements: ["R2", "R3"] }),
		],
		["R1", "R2", "R3"].map((id) => ({ id, text: id })),
	);
	const gate = async (red: string[]) => {
		const wt = worktree();
		mkdirSync(join(wt, "packages/acme-web/e2e"), { recursive: true });
		writeFileSync(
			join(wt, "packages/acme-web/e2e/record.e2e.ts"),
			'test("R1: record", async () => {});\n',
		);
		writeFileSync(
			join(wt, "packages/acme-web/e2e/list.e2e.ts"),
			'test("R2: list", async () => {});\ntest("R3: more", async () => {});\n',
		);
		// A runner that fails when any scenario it is asked to run is red.
		const f = fakeExec((c) =>
			c.cmd === "sh" && red.some((id) => c.args[1]?.includes(id))
				? { code: 1, stdout: `${red.join(", ")} failed` }
				: undefined,
		);
		const r = await runGate("exit", {
			exec: f.exec,
			profile: acceptanceProfile,
			dir: dir(),
			env: { ...env, worktree: wt },
			parent: "ACME-0",
			touched: [],
			...ownedForGate(plan, plan.children[0], []),
		});
		return { r, sh: f.calls.filter((c) => c.cmd === "sh") };
	};

	it("fails when its owned scenario is red", async () => {
		const { r } = await gate(["R1"]);
		expect(r.ok).toBe(false);
		expect(r.steps[0]).toMatchObject({ name: "acceptance", ok: false });
		expect(r.steps[0]?.tail).toContain("R1 failed");
	});

	it("passes with every spec it does not own still red, each failing on an assertion", async () => {
		const { r, sh } = await gate(["R2", "R3"]);
		expect(r.ok).toBe(true);
		// Its own scenario, then each other spec once, to see how it fails.
		expect(sh.map((c) => c.args[1])).toEqual([
			"bunx playwright test 'e2e/record.e2e.ts' -g \"R1\"",
			"bunx playwright test 'e2e/list.e2e.ts' -g \"R2\"",
			"bunx playwright test 'e2e/list.e2e.ts' -g \"R3\"",
		]);
		expect(r.steps.map((s) => s.name)).toEqual([
			"acceptance",
			"satisfiable",
			"debt",
			"secrets",
		]);
		expect(r.steps[1]?.tail).toContain(
			"R2 packages/acme-web/e2e/list.e2e.ts: assertion",
		);
	});

	it("fails a spec it does not own that fails on an error its test code threw", async () => {
		const wt = worktree();
		const f = fakeExec((c) =>
			c.cmd === "sh" && c.args[1]?.includes("R3")
				? {
						code: 1,
						stdout:
							"TypeError: res.body.items is undefined\n    at e2e/list.e2e.ts:2:9",
					}
				: c.cmd === "sh" && c.args[1]?.includes("R2")
					? { code: 1, stdout: "expect(received).toBe(expected)" }
					: undefined,
		);
		const d = dir();
		const r = await runGate("exit", {
			exec: f.exec,
			profile: acceptanceProfile,
			dir: d,
			env: { ...env, worktree: wt },
			parent: "ACME-0",
			touched: [],
			owned: [],
			waitingOn: [],
			failing: [
				{ id: "R2", path: "packages/acme-web/e2e/list.e2e.ts" },
				{ id: "R3", path: "packages/acme-web/e2e/list.e2e.ts" },
			],
		});
		expect(r.ok).toBe(false);
		expect(r.steps.at(-1)).toMatchObject({ name: "satisfiable", ok: false });
		expect(r.steps.at(-1)?.tail).toMatch(
			/^spec packages\/acme-web\/e2e\/list\.e2e\.ts \(R3\) fails on an error the test code threw/,
		);
		expect(r.steps.at(-1)?.tail).not.toContain("(R2)");
		expect(readRows(d).rows.at(-1)?.data?.specs).toEqual([
			{
				id: "R2",
				path: "packages/acme-web/e2e/list.e2e.ts",
				kind: "assertion",
			},
			{ id: "R3", path: "packages/acme-web/e2e/list.e2e.ts", kind: "error" },
		]);
	});
});
