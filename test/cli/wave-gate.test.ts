import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { must, realExec } from "../../src/core/exec";
import { portiaHome, runDir } from "../../src/core/rundir";
import { appendRow } from "../../src/core/runlog";
import type { RunRow } from "../../src/core/types";
import { nodeFs } from "../../src/view/model/fs";
import { readRun } from "../../src/view/model/run";
import { FakeTracker } from "../support/fake-tracker";

const FIXTURE = join(import.meta.dirname, "../fixtures/profile.ts");
const saved = {
	cwd: process.cwd(),
	profile: process.env.PORTIA_PROFILE,
	home: process.env.PORTIA_HOME,
};
const restores: (() => void)[] = [];
let tracker: FakeTracker;

const fenced = (b: string) => `\`\`\`plan\n${b}\n\`\`\``;
const wave1 = (touch: string) =>
	fenced(
		`wave: 1\nneeds: ACME-201 # contract\ntouches: src/${touch}/**\nrequirements: F1\nevidence: bun test ${touch}\nsize: S`,
	);

beforeEach(async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-wave-gate-"));
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "packages/acme-web"), { recursive: true });
	writeFileSync(join(repo, "packages/acme-web/package.json"), "{}\n");
	await must(realExec, "git", ["init", "-q", "-b", "main", repo]);
	await must(realExec, "git", ["add", "."], { cwd: repo });
	process.chdir(repo);
	const profile = join(dir, "profile.ts");
	writeFileSync(
		profile,
		`import base from ${JSON.stringify(FIXTURE)};\nexport default { ...base, waveGate: { steps: ["integration"] } };\n`,
	);
	process.env.PORTIA_PROFILE = profile;
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
					"wave: 0\ntouches: src/lib/**\nevidence: bun test lib\nacceptance: F1 = specs-it/acceptance/a.it.ts\nsize: S",
				),
				blockedBy: [],
			},
			"ACME-187",
		)
		.add(
			{
				key: "ACME-202",
				summary: "One",
				description: wave1("a"),
				blockedBy: ["ACME-201"],
			},
			"ACME-187",
		)
		.add(
			{
				key: "ACME-203",
				summary: "Two",
				description: wave1("b"),
				blockedBy: ["ACME-201"],
			},
			"ACME-187",
		);
	restores.push(useTracker(tracker));
});

afterEach(() => {
	while (restores.length) restores.pop()?.();
	process.chdir(saved.cwd);
	for (const [k, v] of [
		["PORTIA_PROFILE", saved.profile],
		["PORTIA_HOME", saved.home],
	] as const)
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
});

async function portia(...argv: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, {
		out: (s) => out.push(s),
		err: (s) => err.push(s),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

const add = (row: Omit<RunRow, "at" | "attempt">) =>
	appendRow(runDir("ACME-187"), { at: "t", attempt: 1, ...row });

it("status says the wave gate is due once the spine lands, and wave 1 waits for its pass", async () => {
	const before = await portia("status", "ACME-187", "--json");
	expect(JSON.parse(before.out)).not.toHaveProperty("waveGate");
	add({ child: "ACME-201", stage: "landed", status: "landed" });
	const due = await portia("status", "ACME-187", "--json");
	expect(due.code).toBe(0);
	expect(JSON.parse(due.out)).toMatchObject({
		ready: [],
		waveGate: { wave: 0, due: true },
	});
	expect((await portia("status", "ACME-187")).out).toContain(
		"portia gate wave ACME-187",
	);
	add({
		child: "ACME-187",
		stage: "wave-gate",
		status: "pass",
		data: { wave: 0, tip: "abc", steps: [] },
	});
	const after = JSON.parse((await portia("status", "ACME-187", "--json")).out);
	expect(after.ready).toEqual(["ACME-202", "ACME-203"]);
	expect(after).not.toHaveProperty("waveGate");
});

it("dispatch refuses a child whose earlier wave gate has not passed", async () => {
	add({ child: "ACME-201", stage: "landed", status: "landed" });
	const r = await portia("dispatch", "ACME-202", "--parent", "ACME-187");
	expect(r.code).toBe(11);
	expect(r.err).toContain("an earlier wave gate has not passed");
});

it("gate wave refuses a wave that has not fully landed, naming its children", async () => {
	const r = await portia("gate", "wave", "ACME-187");
	expect(r.code).toBe(11);
	expect(r.err).toContain("wave 0 has not fully landed: ACME-201");
	add({ child: "ACME-201", stage: "landed", status: "landed" });
	const one = await portia("gate", "wave", "ACME-187", "--wave", "1");
	expect(one.code).toBe(11);
	expect(one.err).toContain("wave 1 has not fully landed: ACME-202, ACME-203");
});

it("gate wave refuses without a waveGate in the profile", async () => {
	process.env.PORTIA_PROFILE = FIXTURE;
	const r = await portia("gate", "wave", "ACME-187");
	expect(r.code).toBe(11);
	expect(r.err).toContain("the profile has no waveGate");
});

it("the ledger and portia view hold wave 1 back while its wave gate is due, as status does", async () => {
	add({ child: "ACME-201", stage: "landed", status: "landed" });
	const ledger = (await portia("ledger", "ACME-187", "--print")).out;
	const rowOf = (key: string) =>
		ledger.split("\n").find((l) => l.includes(key)) ?? "";
	expect(rowOf("ACME-202")).toContain("pending");
	expect(rowOf("ACME-202")).not.toContain("ready");
	const view = readRun(nodeFs, portiaHome(), "ACME-187", Date.now());
	const states = Object.fromEntries(view.children.map((c) => [c.key, c.state]));
	expect(states).toMatchObject({
		"ACME-202": "pending",
		"ACME-203": "pending",
	});
	add({
		child: "ACME-187",
		stage: "wave-gate",
		status: "pass",
		data: { wave: 0, tip: "abc", steps: [] },
	});
	const after = readRun(nodeFs, portiaHome(), "ACME-187", Date.now());
	expect(after.children.find((c) => c.key === "ACME-202")?.state).toBe("ready");
});

it("gate wave with no gate due reports the last pass, rather than gating a tip that moved since", async () => {
	add({ child: "ACME-201", stage: "landed", status: "landed" });
	add({
		child: "ACME-187",
		stage: "wave-gate",
		status: "pass",
		data: { wave: 0, tip: "abc", steps: [] },
	});
	// No integration worktree exists here, so running the gate at all would fail.
	const r = await portia("gate", "wave", "ACME-187");
	expect(r.code).toBe(0);
	expect(JSON.parse(r.out)).toEqual({
		ok: true,
		wave: 0,
		tip: "abc",
		steps: [],
		reused: true,
	});
});
