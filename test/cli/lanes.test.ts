import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { landCtx } from "../../src/cli/commands/land";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { must, realExec } from "../../src/core/exec";
import { runDir } from "../../src/core/rundir";
import { appendRow, readRows } from "../../src/core/runlog";
import type { Tracker } from "../../src/plan/tracker";
import { sandbox } from "../helpers/git-sandbox";
import { FakeTracker } from "../support/fake-tracker";

const FIXTURE = join(import.meta.dirname, "../fixtures/profile.ts");
const saved = {
	cwd: process.cwd(),
	profile: process.env.PORTIA_PROFILE,
	home: process.env.PORTIA_HOME,
	dry: process.env.PORTIA_DRY_RUN,
};
const restores: (() => void)[] = [];
let dir: string;
let tracker: FakeTracker;

const fenced = (b: string) => `\`\`\`plan\n${b}\n\`\`\``;
const wave1 = (touch: string, extra = "") =>
	fenced(
		`wave: 1\nneeds: ACME-201 # contract\ntouches: src/${touch}/**\nrequirements: F1\nevidence: bun test ${touch}\nsize: S${extra}`,
	);

/** A profile file that is the fixture plus `lanes` and `extra`, or the fixture itself. */
const useProfile = (lanes?: object, extra: object = {}) => {
	if (!lanes) {
		process.env.PORTIA_PROFILE = FIXTURE;
		return;
	}
	const file = join(dir, "profile.ts");
	writeFileSync(
		file,
		`import base from ${JSON.stringify(FIXTURE)};\nexport default { ...base, ...${JSON.stringify(extra)}, lanes: ${JSON.stringify(lanes)} };\n`,
	);
	process.env.PORTIA_PROFILE = file;
};

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "portia-lanes-"));
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "packages/acme-web"), { recursive: true });
	writeFileSync(join(repo, "packages/acme-web/package.json"), "{}\n");
	await must(realExec, "git", ["init", "-q", "-b", "main", repo]);
	await must(realExec, "git", ["add", "."], { cwd: repo });
	process.chdir(repo);
	process.env.PORTIA_HOME = join(dir, "home");
	tracker = new FakeTracker()
		.add({
			key: "ACME-187",
			summary: "Epic",
			description: fenced("scope: onboarding\nscenario: F1 = Given x, Then y"),
			blockedBy: [],
		})
		.add(
			{
				key: "ACME-201",
				summary: "Spine",
				description: fenced(
					"wave: 0\ntouches: src/lib/**, specs-it/acceptance/a.it.ts\nevidence: bun test lib\nacceptance: F1 = specs-it/acceptance/a.it.ts\nsize: S",
				),
				blockedBy: [],
			},
			"ACME-187",
		)
		.add(
			{
				key: "ACME-202",
				summary: "Payments",
				description: wave1("payments"),
				blockedBy: ["ACME-201"],
			},
			"ACME-187",
		)
		.add(
			{
				key: "ACME-203",
				summary: "Copy",
				description: wave1("copy", "\ntouches: specs-it/acceptance/a.it.ts"),
				blockedBy: ["ACME-201"],
			},
			"ACME-187",
		);
	restores.push(useTracker(tracker));
	// The spine has landed, so wave 1 is ready to dispatch.
	appendRow(runDir("ACME-187"), {
		child: "ACME-201",
		attempt: 1,
		stage: "landed",
	});
});

afterEach(() => {
	while (restores.length) restores.pop()?.();
	process.chdir(saved.cwd);
	for (const [k, v] of [
		["PORTIA_PROFILE", saved.profile],
		["PORTIA_HOME", saved.home],
		["PORTIA_DRY_RUN", saved.dry],
	] as const)
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
});

async function portia(...argv: string[]) {
	const out: string[] = [];
	const code = await runCli(argv, { out: (s) => out.push(s), err: () => {} });
	return { code, out: out.join("\n") };
}

it("without profile lanes, status and check say nothing about lanes", async () => {
	useProfile();
	const s = JSON.parse((await portia("status", "ACME-187", "--json")).out);
	expect(s).not.toHaveProperty("lanes");
	const text = await portia("status", "ACME-187");
	expect(text.out).not.toMatch(/light|full/);
	expect((await portia("check", "ACME-187")).out).not.toContain("lane");
});

it("with profile lanes, a small child clear of the spine and sensitive code is light", async () => {
	useProfile({});
	const s = JSON.parse((await portia("status", "ACME-187", "--json")).out);
	expect(s.lanes).toEqual({
		"ACME-201": "full",
		"ACME-202": "full",
		"ACME-203": "light",
	});
	const check = await portia("check", "ACME-187");
	expect(check.code, check.out).toBe(0);
	expect(check.out).toMatch(/info .*lane .*ACME-203 runs in the light lane/);
	expect(check.out).toMatch(/ACME-202 runs in the full lane: .*sensitive/);
	expect((await portia("status", "ACME-187")).out).toMatch(
		/ACME-203 .* light$/m,
	);
});

it("a block's lane shows even without profile lanes", async () => {
	useProfile();
	await tracker.setPlanBlock(
		"ACME-202",
		"wave: 1\nneeds: ACME-201 # contract\ntouches: src/payments/**\nrequirements: F1\nevidence: bun test payments\nsize: S\nlane: light",
	);
	const s = JSON.parse((await portia("status", "ACME-187", "--json")).out);
	expect(s.lanes).toEqual({
		"ACME-201": "full",
		"ACME-202": "light",
		"ACME-203": "full",
	});
});

it("plan write --json gives each child's lane, and nothing without lanes", async () => {
	const plan = join(dir, "plan.json");
	// ACME-201, the spine, has landed in the seeded run, and a started child is never re-planned.
	const blocks = await Promise.all(
		["ACME-202", "ACME-203"].map(async (key) => ({
			key,
			block: (await tracker.issue(key)).description.replace(
				/^```plan\n|\n```$/g,
				"",
			),
		})),
	);
	writeFileSync(
		plan,
		JSON.stringify({
			parent: { block: "scope: onboarding\nscenario: F1 = Given x, Then y" },
			children: blocks,
		}),
	);
	useProfile();
	const plain = await portia(
		"--dry-run",
		"plan",
		"write",
		"ACME-187",
		"--from",
		plan,
		"--json",
	);
	expect(plain.code, plain.out).toBe(0);
	expect(JSON.parse(plain.out)).not.toHaveProperty("lanes");
	useProfile({});
	const laned = await portia(
		"--dry-run",
		"plan",
		"write",
		"ACME-187",
		"--from",
		plan,
		"--json",
	);
	expect(JSON.parse(laned.out).lanes).toEqual({
		"ACME-201": "full",
		"ACME-202": "full",
		"ACME-203": "light",
	});
});

it("the lane recorded at dispatch holds at the worker's exit gate and the re-gate at land", async () => {
	const gates = {
		task: [],
		exit: [
			{ name: "unit", cmd: "true", heavy: false, cwd: "root" },
			{ name: "e2e", cmd: "true", heavy: false, cwd: "root", lanes: ["full"] },
		],
		epic: [],
	};
	useProfile({}, { gates, debt: [] });
	const { root, repo, g } = await sandbox();
	const copy = join(repo, "packages/acme-web/src/copy");
	mkdirSync(copy, { recursive: true });
	writeFileSync(join(copy, "a.ts"), "\n");
	writeFileSync(join(repo, "packages/acme-web/package.json"), "{}\n");
	await g(repo, "add", ".");
	await g(repo, "commit", "-qm", "copy");
	await g(repo, "push", "-q", "origin", "HEAD:main", "HEAD:epic/ACME-187");
	process.chdir(repo);
	const run = runDir("ACME-187");
	const lanes: Record<string, string> = {};
	for (const key of ["ACME-202", "ACME-203"]) {
		const d = await portia("dispatch", key, "--parent", "ACME-187");
		expect(d.code, d.out).toBe(0);
		lanes[key] = JSON.parse(d.out).lane;
		const wt = join(root, key);
		await must(realExec, "git", ["clone", "-q", join(root, "origin.git"), wt]);
		writeFileSync(
			join(run, `env-${key}.json`),
			JSON.stringify({
				worktree: wt,
				branch: `epic/${key}`,
				db: "d",
				port: 3100,
				envFile: "/nonexistent",
			}),
		);
	}
	expect(lanes).toEqual({ "ACME-202": "full", "ACME-203": "light" });
	expect(
		readRows(run)
			.rows.filter((r) => r.stage === "dispatched")
			.map((r) => r.data),
	).toEqual([{ lane: "full" }, { lane: "light" }]);
	// The worker adds a file under a sensitive glob that the root checkout does not have.
	const wt = join(root, "ACME-203");
	const pay = join(wt, "packages/acme-web/src/copy/payments");
	mkdirSync(pay, { recursive: true });
	writeFileSync(join(pay, "x.ts"), "\n");
	await g(
		wt,
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=Test",
		"add",
		".",
	);
	await g(
		wt,
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=Test",
		"commit",
		"-qm",
		"x",
	);
	const e2e = (r: { steps: { name: string; tail: string }[] }) =>
		r.steps.find((s) => s.name === "e2e")?.tail;
	process.chdir(wt);
	// The worker's gates read the plan its dispatch recorded: the tracker is never asked.
	const offline = () => Promise.reject(new Error("tracker unreachable"));
	const online = useTracker({
		keyPattern: tracker.keyPattern,
		issue: offline,
		children: offline,
	} as unknown as Tracker);
	const light = await portia(
		"gate",
		"exit",
		"ACME-203",
		"--parent",
		"ACME-187",
		"--json",
	);
	expect(light.code, light.out).toBe(0);
	expect(e2e(JSON.parse(light.out))).toBe("skipped: not run in the light lane");
	online();
	// A snapshot of another shape is no snapshot: the gate loads the plan from the
	// tracker as before, as it does with none at all.
	writeFileSync(
		join(run, "plan.json"),
		JSON.stringify({ version: 1, plan: { children: [{ key: "ACME-202" }] } }),
	);
	const full = await portia(
		"gate",
		"exit",
		"ACME-202",
		"--parent",
		"ACME-187",
		"--json",
	);
	expect(full.code, full.out).toBe(0);
	expect(e2e(JSON.parse(full.out))).not.toContain("skipped");
	process.chdir(repo);
	const ctx = await landCtx("ACME-187");
	expect(e2e(await ctx.gate("ACME-203"))).toBe(
		"skipped: not run in the light lane",
	);
	expect(e2e(await ctx.gate("ACME-202"))).not.toContain("skipped");
});

it("without profile lanes, dispatch records no lane", async () => {
	useProfile();
	const d = await portia("dispatch", "ACME-203", "--parent", "ACME-187");
	expect(d.code, d.out).toBe(0);
	expect(JSON.parse(d.out)).not.toHaveProperty("lane");
	const row = readRows(runDir("ACME-187")).rows.find(
		(r) => r.stage === "dispatched",
	);
	expect(row).not.toHaveProperty("data");
});

it("a light child keeps its block's tier", async () => {
	useProfile({});
	await tracker.setPlanBlock(
		"ACME-203",
		"wave: 1\nneeds: ACME-201 # contract\ntouches: src/copy/**\nrequirements: F1\nevidence: bun test copy\nsize: S\ntier: high",
	);
	const d = JSON.parse(
		(await portia("dispatch", "ACME-203", "--parent", "ACME-187")).out,
	);
	expect(d).toMatchObject({ lane: "light", model: "opus" });
});
