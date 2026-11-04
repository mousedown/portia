import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { must, realExec } from "../../src/core/exec";
import { runDir } from "../../src/core/rundir";
import { appendRow } from "../../src/core/runlog";
import { FakeTracker } from "../support/fake-tracker";

/** A planned child the tracker shows as done, with no landed row: closed outside the run. */
const PROFILE = join(import.meta.dirname, "../fixtures/profile.ts");
const WARNING = "ACME-202: closed outside the run, not landed";
const saved = {
	cwd: process.cwd(),
	profile: process.env.PORTIA_PROFILE,
	home: process.env.PORTIA_HOME,
};
const restores: (() => void)[] = [];
let tracker: FakeTracker;

const fenced = (b: string) => `\`\`\`plan\n${b}\n\`\`\``;
const wave1 = (touch: string, extra = "") =>
	fenced(
		`wave: 1\nneeds: ACME-201 # contract\ntouches: src/${touch}/**\nrequirements: F1\nevidence: bun test ${touch}\nsize: S${extra}`,
	);

beforeEach(async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-closed-"));
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "packages/acme-web"), { recursive: true });
	writeFileSync(join(repo, "packages/acme-web/package.json"), "{}\n");
	await must(realExec, "git", ["init", "-q", "-b", "main", repo]);
	await must(realExec, "git", ["add", "."], { cwd: repo });
	process.chdir(repo);
	process.env.PORTIA_PROFILE = PROFILE;
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
				summary: "Closed by hand",
				description: wave1("a"),
				blockedBy: ["ACME-201"],
				done: true,
			},
			"ACME-187",
		)
		.add(
			{
				key: "ACME-203",
				summary: "Open",
				description: wave1("b", "\ntouches: specs-it/acceptance/a.it.ts"),
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

it("portia check warns, and still passes", async () => {
	const r = await portia("check", "ACME-187");
	expect(r.code, r.out).toBe(0);
	expect(r.out).toMatch(new RegExp(`warn .*${WARNING}`));
});

it("portia status shows it closed and warns; the wave barrier treats it as met", async () => {
	const text = await portia("status", "ACME-187");
	expect(text.out).toContain("closed");
	expect(text.out).toContain(`warn  ${WARNING}`);
	appendRow(runDir("ACME-187"), {
		at: "t",
		child: "ACME-201",
		attempt: 1,
		stage: "landed",
	});
	const json = await portia("status", "ACME-187", "--json");
	const s = JSON.parse(json.out);
	expect(s.states["ACME-202"]).toBe("closed");
	expect(s.ready).toEqual(["ACME-203"]);
	expect(s.warnings).toEqual([WARNING]);
});

it("portia status gives no warning once the child has landed in the run", async () => {
	appendRow(runDir("ACME-187"), {
		at: "t",
		child: "ACME-202",
		attempt: 1,
		stage: "landed",
	});
	const s = JSON.parse((await portia("status", "ACME-187", "--json")).out);
	expect(s.states["ACME-202"]).toBe("landed");
	expect(s.warnings).toEqual([]);
});

it("portia dispatch refuses it", async () => {
	const r = await portia("dispatch", "ACME-202", "--parent", "ACME-187");
	expect(r.code).toBe(11);
	expect(r.err).toContain("ACME-202 is closed outside the run");
	expect(tracker.writes).toEqual([]);
});

it("the epic gate does not wait for it", async () => {
	const r = await portia("epic", "ACME-187");
	expect(r.code).toBe(11);
	expect(r.err).toContain("not every child has landed: ACME-201, ACME-203");
});

it("a closed child's scenario ids are not checked against the parent", async () => {
	await tracker.setPlanBlock(
		"ACME-202",
		"wave: 1\nneeds: ACME-201 # contract\ntouches: src/a/**\nrequirements: F1, F7\nevidence: bun test a\nsize: S",
	);
	const r = await portia("check", "ACME-187");
	expect(r.code, r.out).toBe(0);
});
