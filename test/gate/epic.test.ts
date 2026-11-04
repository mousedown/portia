import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { runEpicGate } from "../../src/gate/epic";
import { fakeExec } from "../helpers/fake-exec";
import { child, parent, spine } from "../helpers/plan";

const SPEC = "packages/acme-web/e2e/onboarding/checklist.e2e.ts";
const plan = parent([
	spine({
		acceptance: { F1: "packages/acme-web/e2e/onboarding/checklist.e2e.ts" },
	}),
	child("ACME-2"),
	child("ACME-3"),
]);
const profile = {
	...testProfile(),
	packageDir: "packages/acme-web",
	gates: {
		task: [],
		exit: [],
		epic: [
			{
				name: "acceptance",
				cmd: "bunx playwright test {acceptance}",
				heavy: true,
				cwd: "package" as const,
				// The epic gate runs every step, whatever its lanes.
				lanes: ["full"] as ["full"],
			},
			{
				name: "knowledge",
				cmd: "bun run knowledge:check",
				heavy: false,
				cwd: "root" as const,
			},
		],
	},
	agentBrowser: "agent-browser check --url {baseUrl}",
	secondVendor: "codex review --base main",
};

const setup = (failOn?: string, debtDiffFails = false) => {
	// The port pool lives beside the run directory; a private parent keeps this
	// file off the pool every other test file in $TMPDIR shares.
	const dir = join(mkdtempSync(join(tmpdir(), "portia-epic-")), "run");
	mkdirSync(dir);
	const integration = mkdtempSync(join(tmpdir(), "portia-int-"));
	mkdirSync(join(integration, "packages/acme-web"), { recursive: true });
	const repoRoot = mkdtempSync(join(tmpdir(), "portia-main-"));
	mkdirSync(join(repoRoot, "packages/acme-web"), { recursive: true });
	writeFileSync(join(repoRoot, "packages/acme-web/.env"), "FROM_MAIN=1\n");
	mkdirSync(join(integration, "packages/acme-web/e2e/onboarding"), {
		recursive: true,
	});
	writeFileSync(join(integration, SPEC), 'test("F1: checklist", () => {});\n');
	const f = fakeExec((c) => {
		if (debtDiffFails && c.cmd === "git" && c.args.includes("-U0"))
			return { code: 128, stderr: "fatal: bad revision" };
		return failOn && c.args[1]?.startsWith(failOn)
			? { code: 1, stdout: "boom" }
			: undefined;
	});
	return {
		...f,
		ctx: {
			exec: f.exec,
			profile,
			dir,
			plan,
			integration,
			repoRoot,
			epicPr: 77,
		},
	};
};
const shells = (calls: { cmd: string; args: string[] }[]) =>
	calls.filter((c) => c.cmd === "sh").map((c) => c.args[1]);

it("runs the epic steps in order with substitutions, then marks the epic PR ready", async () => {
	const s = setup();
	const r = await runEpicGate(s.ctx);
	expect(r.ok).toBe(true);
	expect(r.steps.map((x) => x.name)).toEqual([
		"specs",
		"acceptance",
		"knowledge",
		"agent-browser",
		"second-vendor",
		"debt",
	]);
	const sh = shells(s.calls);
	expect(sh[0]).toBe("bunx playwright test 'e2e/onboarding/checklist.e2e.ts'");
	expect(sh[2]).toMatch(/^agent-browser check --url http:\/\/localhost:\d+$/);
	expect(sh[3]).toBe("codex review --base main");
	expect(s.calls.map(s.line)).toContain("gh pr ready 77");
	expect(s.calls.map(s.line)).toContain(
		"git reset --hard origin/portia/ACME-0",
	);
});

it("stops at the first failing step and never marks the PR ready", async () => {
	const s = setup("agent-browser");
	const r = await runEpicGate(s.ctx);
	expect(r.ok).toBe(false);
	expect(r.steps.at(-1)).toMatchObject({ name: "agent-browser", ok: false });
	expect(s.calls.map(s.line).some((l) => l.startsWith("gh pr ready"))).toBe(
		false,
	);
});

it("fails the debt step, not passes it, when the whole-diff git diff errors", async () => {
	const s = setup(undefined, true);
	const r = await runEpicGate(s.ctx);
	expect(r.ok).toBe(false);
	expect(r.steps.at(-1)).toMatchObject({ name: "debt", ok: false });
	expect(s.calls.map(s.line).some((l) => l.startsWith("gh pr ready"))).toBe(
		false,
	);
});

it("tears down its own database and port afterwards", async () => {
	const s = setup();
	await runEpicGate(s.ctx);
	const lines = s.calls.map(s.line);
	expect(
		lines.some(
			(l) =>
				l.startsWith("createdb") &&
				l.includes("ACME-0-EPIC".toLowerCase().replace(/-/g, "_")),
		),
	).toBe(true);
	expect(
		lines.filter((l) => l.startsWith("dropdb")).length,
	).toBeGreaterThanOrEqual(2);
});

it("copies the main checkout .env into the integration worktree", async () => {
	const s = setup();
	await runEpicGate(s.ctx);
	expect(
		readFileSync(join(s.ctx.integration, "packages/acme-web/.env"), "utf8"),
	).toBe("FROM_MAIN=1\n");
	expect(existsSync(join(s.ctx.dir, "env-ACME-0-EPIC.json"))).toBe(false);
});

it("the epic debt step uses the plan key's prefix", async () => {
	const s = setup();
	const base = s.ctx.exec;
	s.ctx.exec = async (cmd, args, opts) =>
		cmd === "git" && args.includes("-U0")
			? {
					code: 0,
					stdout: "+++ b/src/x.ts\n+// SHA-256 previously MD5",
					stderr: "",
				}
			: base(cmd, args, opts);
	const r = await runEpicGate(s.ctx);
	expect(r.steps.at(-1)).toMatchObject({ name: "debt", ok: true });
});

it("runs every epic step with the profile's gateEnv", async () => {
	const s = setup();
	await runEpicGate({
		...s.ctx,
		profile: { ...profile, gateEnv: { PAYMENTS_KEY: "pk_test" } },
	});
	const sh = s.calls.filter((c) => c.cmd === "sh");
	expect(sh.length).toBeGreaterThan(0);
	for (const c of sh) expect(c.env).toMatchObject({ PAYMENTS_KEY: "pk_test" });
});

it("runs a whenTouches epic step only when the epic's diff matches it", async () => {
	const withStep = (changed: string) => {
		const s = setup();
		const exec: typeof s.exec = async (cmd, args, opts) => {
			const r = await s.exec(cmd, args, opts);
			return cmd === "git" && args.includes("--name-only")
				? { ...r, stdout: changed }
				: r;
		};
		return {
			s,
			ctx: {
				...s.ctx,
				exec,
				profile: {
					...profile,
					gates: {
						...profile.gates,
						epic: [
							{
								name: "chat",
								cmd: "cd packages/chat && bun run test",
								heavy: true,
								cwd: "root" as const,
								whenTouches: ["packages/chat/**"],
							},
						],
					},
				},
			},
		};
	};
	const off = withStep("packages/acme-web/src/a.ts\n");
	const skipped = await runEpicGate(off.ctx);
	expect(skipped.steps[0]?.tail).toMatch(/^skipped/);
	expect(shells(off.s.calls)).not.toContain("cd packages/chat && bun run test");
	const on = withStep("packages/chat/src/x.ts\n");
	await runEpicGate(on.ctx);
	expect(shells(on.s.calls)).toContain("cd packages/chat && bun run test");
	expect(on.s.calls.map(on.s.line)).toContain(
		"git diff --name-only origin/main...HEAD",
	);
});

it("retries a failing epic step once when it has retries: 1", async () => {
	const s = setup();
	let n = 0;
	const exec: typeof s.exec = async (cmd, args, opts) =>
		cmd === "sh" && args[1] === "bun run flaky" && n++ === 0
			? { code: 1, stdout: "timeout", stderr: "" }
			: s.exec(cmd, args, opts);
	const r = await runEpicGate({
		...s.ctx,
		exec,
		profile: {
			...profile,
			gates: {
				...profile.gates,
				epic: [
					{
						name: "flaky",
						cmd: "bun run flaky",
						heavy: true,
						cwd: "package" as const,
						retries: 1,
					},
				],
			},
		},
	});
	expect(r.steps[0]).toMatchObject({ name: "flaky", ok: true });
	expect(n).toBe(2);
});

it("fails before running acceptance when a planned scenario is no longer titled", async () => {
	const s = setup();
	writeFileSync(
		join(s.ctx.integration, SPEC),
		'test("checklist", () => {});\n',
	);
	const r = await runEpicGate(s.ctx);
	expect(r.ok).toBe(false);
	expect(r.steps).toEqual([
		{
			name: "specs",
			ok: false,
			tail: `spec ${SPEC} has no test titled with F1`,
		},
	]);
	expect(shells(s.calls)).toEqual([]);
	expect(s.calls.map(s.line).some((l) => l.startsWith("gh pr ready"))).toBe(
		false,
	);
});

it("fails before running acceptance when a planned scenario is skipped", async () => {
	const s = setup();
	writeFileSync(
		join(s.ctx.integration, SPEC),
		'test.describe.skip("onboarding", () => {\n\ttest("F1: checklist", () => {});\n});\n',
	);
	const r = await runEpicGate(s.ctx);
	expect(r.steps).toEqual([
		{
			name: "specs",
			ok: false,
			tail: `spec ${SPEC} marks F1 test.describe.skip`,
		},
	]);
	expect(shells(s.calls)).toEqual([]);
});

it("checks no scenarios when no epic step runs {acceptance}", async () => {
	const s = setup();
	writeFileSync(join(s.ctx.integration, SPEC), "");
	const r = await runEpicGate({
		...s.ctx,
		profile: {
			...profile,
			gates: { ...profile.gates, epic: profile.gates.epic.slice(1) },
		},
	});
	expect(r.ok).toBe(true);
	expect(r.steps[0]?.name).toBe("knowledge");
});
