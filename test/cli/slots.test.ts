import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { must, realExec } from "../../src/core/exec";
import { runDir } from "../../src/core/rundir";
import { appendRow, readRows } from "../../src/core/runlog";
import { useProbes, WARMUP_MS } from "../../src/env/slots";
import { FakeTracker } from "../support/fake-tracker";

/** One spine landed and three wave-1 children ready; free memory and live pids are faked. */
const FIXTURE = join(import.meta.dirname, "../fixtures/profile.ts");
const saved = {
	cwd: process.cwd(),
	profile: process.env.PORTIA_PROFILE,
	home: process.env.PORTIA_HOME,
};
const restores: (() => void)[] = [];
let tracker: FakeTracker;
let dir: string;
let freeMb = 64_000;
let clock: number | undefined;
const STARTED: Record<number, string> = { 100: "s100", 200: "s200" };
const later = () => {
	clock = Date.now() + WARMUP_MS + 1000;
};

const fenced = (b: string) => `\`\`\`plan\n${b}\n\`\`\``;
const wave1 = (touch: string) =>
	fenced(
		`wave: 1\nneeds: ACME-201 # contract\ntouches: src/${touch}/**\nrequirements: F1\nevidence: bun test ${touch}\nsize: S`,
	);

const useProfile = (extra: Record<string, unknown>) => {
	const file = join(dir, `profile-${Object.keys(extra).join("-")}.ts`);
	writeFileSync(
		file,
		`import acme from ${JSON.stringify(FIXTURE)};\nexport default { ...acme, ${Object.entries(
			extra,
		)
			.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
			.join(", ")} };\n`,
	);
	process.env.PORTIA_PROFILE = file;
};

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "portia-slots-"));
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "packages/acme-web"), { recursive: true });
	writeFileSync(join(repo, "packages/acme-web/package.json"), "{}\n");
	await must(realExec, "git", ["init", "-q", "-b", "main", repo]);
	await must(realExec, "git", ["add", "."], { cwd: repo });
	process.chdir(repo);
	process.env.PORTIA_HOME = join(dir, "home");
	useProfile({ waveCap: 3, minFreeMb: 4096, perWorkerMb: 2048 });
	freeMb = 64_000;
	clock = undefined;
	tracker = new FakeTracker().add({
		key: "ACME-187",
		summary: "Epic",
		description: fenced("scope: onboarding\nscenario: F1 = Given x, Then y"),
		blockedBy: [],
	});
	tracker.add(
		{
			key: "ACME-201",
			summary: "Spine",
			description: fenced(
				"wave: 0\ntouches: src/lib/**\nevidence: bun test lib\nacceptance: F1 = specs-it/acceptance/a.it.ts\nsize: S",
			),
			blockedBy: [],
		},
		"ACME-187",
	);
	for (const [k, t] of [
		["ACME-202", "a"],
		["ACME-203", "b"],
		["ACME-204", "c"],
	] as const)
		tracker.add(
			{ key: k, summary: `Child ${t}`, description: wave1(t), blockedBy: [] },
			"ACME-187",
		);
	restores.push(useTracker(tracker));
	restores.push(
		useProbes({
			freeMb: () => freeMb,
			startedAt: (pid) => STARTED[pid],
			ownerPid: () => 100,
			now: () => clock ?? Date.now(),
		}),
	);
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
const dispatch = (key: string) =>
	portia("dispatch", key, "--parent", "ACME-187");
const dispatched = () =>
	readRows(runDir("ACME-187")).rows.filter((r) => r.stage === "dispatched");

it("dispatch records the session that owns the worker", async () => {
	const r = await dispatch("ACME-202");
	expect(r.code, r.err).toBe(0);
	expect(dispatched()[0]?.data).toEqual({ pid: 100, started: "s100" });
});

it("dispatch starts up to what memory fits, then exits 10 with the rest waiting", async () => {
	freeMb = 8192; // (8192 - 4096) / 2048 = 2 workers
	const a = JSON.parse((await dispatch("ACME-202")).out);
	expect(a.slots).toMatchObject({ cap: 3, memory: 2, used: 0, available: 2 });
	expect(a.waiting).toEqual(["ACME-204"]);
	expect((await dispatch("ACME-203")).code).toBe(0);
	const c = await dispatch("ACME-204");
	expect(c.code).toBe(10);
	expect(JSON.parse(c.out)).toMatchObject({
		child: "ACME-204",
		waiting: ["ACME-204"],
		slots: { used: 2, available: 0 },
	});
	expect(dispatched().map((r) => r.child)).toEqual(["ACME-202", "ACME-203"]);
	expect(tracker.writes.map((w) => "key" in w && w.key)).not.toContain(
		"ACME-204",
	);
});

it("dispatch starts the waiting child once a landing frees a slot", async () => {
	freeMb = 8192;
	await dispatch("ACME-202");
	await dispatch("ACME-203");
	expect((await dispatch("ACME-204")).code).toBe(10);
	appendRow(runDir("ACME-187"), {
		child: "ACME-202",
		attempt: 1,
		stage: "landed",
	});
	expect((await dispatch("ACME-204")).code).toBe(0);
});

it("another live run on the machine takes from the same cap", async () => {
	appendRow(runDir("ACME-900"), {
		child: "ACME-901",
		attempt: 1,
		stage: "dispatched",
		data: { pid: 200, started: "s200" },
	});
	appendRow(runDir("ACME-900"), {
		child: "ACME-902",
		attempt: 1,
		stage: "dispatched",
		data: { pid: 200, started: "s200" },
	});
	expect((await dispatch("ACME-202")).code).toBe(0);
	const r = await dispatch("ACME-203");
	expect(r.code).toBe(10);
	expect(JSON.parse(r.out).slots).toMatchObject({ used: 1, peers: 2 });
});

it("status shows the slots, as text and as JSON", async () => {
	await dispatch("ACME-202");
	const text = await portia("status", "ACME-187");
	expect(text.out).toContain("slots  2 of 3 free · 1 running here");
	const json = JSON.parse((await portia("status", "ACME-187", "--json")).out);
	expect(json.slots).toMatchObject({ cap: 3, used: 1, available: 2 });
});

it("counts running workers once: free memory already holds what they use", async () => {
	useProfile({ waveCap: 3, minFreeMb: 1000, perWorkerMb: 3000 });
	freeMb = 10_000;
	for (const k of ["ACME-202", "ACME-203", "ACME-204"]) {
		const r = await dispatch(k);
		expect(r.code, r.out).toBe(0);
		// Each worker takes its memory once it has warmed up.
		freeMb -= 3000;
		later();
	}
	expect(dispatched()).toHaveLength(3);
});

it("reserves memory for a worker that has not taken it yet", async () => {
	useProfile({ waveCap: 3, minFreeMb: 1000, perWorkerMb: 3000 });
	freeMb = 7000; // fits 2
	expect((await dispatch("ACME-202")).code).toBe(0);
	expect((await dispatch("ACME-203")).code).toBe(0);
	expect((await dispatch("ACME-204")).code).toBe(10);
});

it("never waits on dispatches with no recorded owner", async () => {
	for (const k of ["ACME-202", "ACME-203"])
		appendRow(runDir("ACME-187"), {
			child: k,
			attempt: 1,
			stage: "dispatched",
		});
	freeMb = 6144; // fits 1
	const r = await dispatch("ACME-204");
	expect(r.code, r.out).toBe(0);
	expect(JSON.parse(r.out).slots).toMatchObject({ used: 0, available: 1 });
});

it("exits 11 when memory fits no worker and this run has none to wait on", async () => {
	freeMb = 5000;
	const r = await dispatch("ACME-202");
	expect(r.code).toBe(11);
	expect(r.err).toContain("no memory for a worker");
	expect(dispatched()).toEqual([]);
});

it("--check decides the slot before env up and records nothing", async () => {
	freeMb = 6144; // fits 1
	const ok = await portia(
		"dispatch",
		"ACME-202",
		"--parent",
		"ACME-187",
		"--check",
	);
	expect(ok.code, ok.err).toBe(0);
	expect(dispatched()).toEqual([]);
	expect(tracker.writes).toEqual([]);
	await dispatch("ACME-202");
	const full = await portia(
		"dispatch",
		"ACME-203",
		"--parent",
		"ACME-187",
		"--check",
	);
	expect(full.code).toBe(10);
	expect(JSON.parse(full.out).slots.running).toEqual(["ACME-202"]);
});

const envUp = (key: string) => {
	writeFileSync(join(runDir("ACME-187"), `env-${key}.json`), "{}");
	appendRow(runDir("ACME-187"), {
		child: key,
		attempt: 0,
		stage: "env",
		status: "up",
	});
};

it("once a child's environment is up, only the cap holds its dispatch back", async () => {
	envUp("ACME-202");
	freeMb = 0;
	expect((await dispatch("ACME-202")).code).toBe(0);
});

it("an environment left up from an earlier attempt is checked against memory again", async () => {
	envUp("ACME-202");
	expect((await dispatch("ACME-202")).code).toBe(0);
	appendRow(runDir("ACME-187"), {
		child: "ACME-202",
		attempt: 1,
		stage: "result",
		status: "failed",
	});
	freeMb = 0;
	const r = await dispatch("ACME-202");
	expect(r.code).toBe(11);
	expect(r.err).toContain("no memory for a worker");
	// Within the warm-up, a fresh env up still admits its child.
	envUp("ACME-203");
	expect((await dispatch("ACME-203")).code).toBe(0);
	envUp("ACME-204");
	later();
	expect((await dispatch("ACME-204")).code).not.toBe(0);
});

it("an environment just up and not yet dispatched holds its memory for its worker", async () => {
	freeMb = 8192; // (8192 - 4096) / 2048 = 2 workers
	envUp("ACME-202");
	envUp("ACME-203");
	const r = await portia(
		"dispatch",
		"ACME-204",
		"--parent",
		"ACME-187",
		"--check",
	);
	expect(r.code).toBe(11);
	expect((await dispatch("ACME-202")).code).toBe(0);
	expect((await dispatch("ACME-203")).code).toBe(0);
});

it("dispatch refuses a child whose needs have not landed, and one that has landed", async () => {
	tracker.add(
		{
			key: "ACME-205",
			summary: "Later",
			description: fenced(
				"wave: 2\nneeds: ACME-202 # a\ntouches: src/d/**\nrequirements: F1\nevidence: bun test d\nsize: S",
			),
			blockedBy: [],
		},
		"ACME-187",
	);
	const pending = await dispatch("ACME-205");
	expect(pending.code).toBe(11);
	expect(pending.err).toContain("ACME-205 is not ready");
	const landed = await dispatch("ACME-201");
	expect(landed.code).toBe(11);
	expect(landed.err).toContain("ACME-201 has landed");
	expect(dispatched()).toEqual([]);
});

it("dispatches of one child at once each take their own attempt", async () => {
	useProfile({ waveCap: 3, minFreeMb: 4096 });
	const all = await Promise.all([1, 2, 3].map(() => dispatch("ACME-202")));
	expect(all.map((r) => r.code)).toEqual([0, 0, 0]);
	expect(dispatched().map((r) => r.attempt)).toEqual([1, 2, 3]);
});

it("without perWorkerMb, dispatch never waits and status shows no slots", async () => {
	useProfile({ waveCap: 1, minFreeMb: 4096 });
	freeMb = 0;
	for (const k of ["ACME-202", "ACME-203", "ACME-204"]) {
		const r = await dispatch(k);
		expect(r.code, r.err).toBe(0);
		expect(Object.keys(JSON.parse(r.out))).toEqual([
			"child",
			"attempt",
			"model",
		]);
	}
	expect(dispatched().map((r) => r.data)).toEqual([
		undefined,
		undefined,
		undefined,
	]);
	expect(
		(await portia("dispatch", "ACME-202", "--parent", "ACME-187", "--check"))
			.code,
	).toBe(0);
	expect((await portia("status", "ACME-187")).out).not.toContain("slots");
	const json = JSON.parse((await portia("status", "ACME-187", "--json")).out);
	expect(json).not.toHaveProperty("slots");
});

it("with lanes too, the slots path records the lane beside the owner and reports both", async () => {
	useProfile({ waveCap: 3, minFreeMb: 4096, perWorkerMb: 2048, lanes: {} });
	const check = await portia(
		"dispatch",
		"ACME-202",
		"--parent",
		"ACME-187",
		"--check",
	);
	expect(check.code, check.err).toBe(0);
	expect(JSON.parse(check.out)).toMatchObject({ lane: "light" });
	const r = await dispatch("ACME-202");
	expect(r.code, r.err).toBe(0);
	expect(JSON.parse(r.out)).toMatchObject({ lane: "light", attempt: 1 });
	expect(dispatched()[0]?.data).toEqual({
		pid: 100,
		started: "s100",
		lane: "light",
	});
	const json = JSON.parse((await portia("status", "ACME-187", "--json")).out);
	expect(json.lanes).toMatchObject({ "ACME-201": "full", "ACME-202": "light" });
	expect(json.slots).toMatchObject({ used: 1 });
	const text = (await portia("status", "ACME-187")).out;
	expect(text).toContain("slots  2 of 3 free");
	expect(text).toMatch(/ACME-202 .* running {2}light$/m);
});
