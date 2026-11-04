import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { appendRow, readRows } from "../../src/core/runlog";
import { runWaveGate } from "../../src/gate/wave";
import { fakeExec } from "../helpers/fake-exec";
import { child, parent, spine } from "../helpers/plan";

const plan = parent(
	[
		spine({
			acceptance: {
				F1: "packages/acme-web/e2e/a.e2e.ts",
				F2: "packages/acme-web/e2e/b.e2e.ts",
				F3: "packages/acme-web/e2e/b.e2e.ts",
			},
		}),
		child("ACME-2", { requirements: ["F1"] }),
		child("ACME-3", { requirements: ["F2"] }),
		child("ACME-4", { wave: 2, requirements: ["F3"] }),
	],
	[
		{ id: "F1", text: "one" },
		{ id: "F2", text: "two" },
		{ id: "F3", text: "three" },
	],
);
const profile = {
	...testProfile(),
	packageDir: "packages/acme-web",
	gates: {
		task: [],
		exit: [],
		epic: [
			{
				name: "unit",
				cmd: "bun test",
				heavy: true,
				cwd: "package" as const,
			},
			{
				name: "acceptance",
				cmd: "bunx playwright test {acceptance}",
				heavy: true,
				cwd: "package" as const,
			},
			{
				name: "knowledge",
				cmd: "bun run knowledge:check",
				heavy: false,
				cwd: "root" as const,
			},
		],
	},
	waveGate: { steps: ["acceptance", "unit"] },
};

const setup = (o: { failOn?: string; landed?: string[] } = {}) => {
	// The port pool lives beside the run directory; a private parent keeps this
	// file off the pool every other test file in $TMPDIR shares.
	const dir = join(mkdtempSync(join(tmpdir(), "portia-wave-")), "run");
	mkdirSync(dir);
	const integration = mkdtempSync(join(tmpdir(), "portia-int-"));
	mkdirSync(join(integration, "packages/acme-web"), { recursive: true });
	for (const k of o.landed ?? ["ACME-1", "ACME-2", "ACME-3"])
		appendRow(dir, { child: k, attempt: 1, stage: "landed", status: "landed" });
	let tip = "aaa111";
	const f = fakeExec((c) => {
		if (c.cmd === "git" && c.args[0] === "rev-parse")
			return { stdout: `${tip}\n` };
		return o.failOn && c.cmd === "sh" && c.args[1]?.startsWith(o.failOn)
			? { code: 1, stdout: "2 failed" }
			: undefined;
	});
	return {
		...f,
		dir,
		moveTip: (sha: string) => {
			tip = sha;
		},
		ctx: {
			exec: f.exec,
			profile,
			dir,
			plan,
			integration,
			repoRoot: mkdtempSync(join(tmpdir(), "portia-main-")),
		},
	};
};
const shells = (calls: { cmd: string; args: string[] }[]) =>
	calls.filter((c) => c.cmd === "sh").map((c) => c.args[1]);

it("runs the named epic steps in the profile's order on the integration tip, and records a pass", async () => {
	const s = setup();
	const r = await runWaveGate(s.ctx, 1);
	expect(r).toMatchObject({ ok: true, wave: 1, tip: "aaa111" });
	expect(r.steps.map((x) => x.name)).toEqual(["unit", "acceptance"]);
	// b.e2e.ts also holds F3, which waits on wave 2: only the proven spec runs.
	expect(shells(s.calls)).toEqual([
		"bun test",
		"bunx playwright test 'e2e/a.e2e.ts'",
	]);
	expect(s.calls.find((c) => c.cmd === "sh")?.env).toMatchObject({
		PORTIA_WAVE: "1",
	});
	expect(s.calls.map(s.line)).toContain(
		"git reset --hard origin/portia/ACME-0",
	);
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		child: "ACME-0",
		stage: "wave-gate",
		status: "pass",
		data: {
			wave: 1,
			tip: "aaa111",
			steps: [
				{ name: "unit", ok: true },
				{ name: "acceptance", ok: true },
			],
		},
	});
});

it("stops at the first failing step, with its tail, and records a fail", async () => {
	const s = setup({ failOn: "bun test" });
	const r = await runWaveGate(s.ctx, 1);
	expect(r.ok).toBe(false);
	expect(r.steps).toEqual([{ name: "unit", ok: false, tail: "2 failed" }]);
	expect(shells(s.calls)).toEqual(["bun test"]);
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		stage: "wave-gate",
		status: "fail",
		data: { wave: 1, tip: "aaa111", steps: [{ name: "unit", ok: false }] },
	});
});

it("skips an {acceptance} step before any scenario has landed", async () => {
	const s = setup({ landed: ["ACME-1"] });
	const r = await runWaveGate(s.ctx, 0);
	expect(r.steps.find((x) => x.name === "acceptance")).toEqual({
		name: "acceptance",
		ok: true,
		tail: "skipped: no scenario has landed yet",
	});
	expect(shells(s.calls)).toEqual(["bun test"]);
});

it("runs a spec whose every scenario the spine owns once the spine lands", async () => {
	const s = setup({ landed: ["ACME-1"] });
	const owning = parent(
		[
			spine({
				requirements: ["F1"],
				acceptance: {
					F1: "packages/acme-web/e2e/a.e2e.ts",
					F2: "packages/acme-web/e2e/b.e2e.ts",
					F3: "packages/acme-web/e2e/b.e2e.ts",
				},
			}),
			child("ACME-3", { requirements: ["F2"] }),
			child("ACME-4", { wave: 2, requirements: ["F3"] }),
		],
		plan.scenarios,
	);
	const r = await runWaveGate({ ...s.ctx, plan: owning }, 0);
	expect(r.ok).toBe(true);
	expect(shells(s.calls)).toEqual([
		"bun test",
		"bunx playwright test 'e2e/a.e2e.ts'",
	]);
});

it("does not run again for a wave that passed at the same tip, but does once the tip moves or after a fail", async () => {
	const s = setup({ failOn: "bun test" });
	expect((await runWaveGate(s.ctx, 1)).ok).toBe(false);
	const passing = setup();
	const ctx = { ...passing.ctx, dir: s.dir };
	expect((await runWaveGate(ctx, 1)).ok).toBe(true);
	const runs = () => passing.calls.filter((c) => c.cmd === "sh").length;
	const before = runs();
	expect(await runWaveGate(ctx, 1)).toMatchObject({
		ok: true,
		reused: true,
		steps: [],
	});
	expect(runs()).toBe(before);
	expect(
		readRows(s.dir).rows.filter((r) => r.stage === "wave-gate"),
	).toHaveLength(2);
	passing.moveTip("bbb222");
	expect((await runWaveGate(ctx, 1)).reused).toBeUndefined();
	expect(runs()).toBeGreaterThan(before);
});
