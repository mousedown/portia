import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { approvedGlobs } from "../../src/core/approvals";
import { must, realExec } from "../../src/core/exec";
import { runDir } from "../../src/core/rundir";
import { FakeTracker } from "../support/fake-tracker";

const PROFILE = join(import.meta.dirname, "../fixtures/profile.ts");
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
	const dir = mkdtempSync(join(tmpdir(), "portia-touches-"));
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
					"wave: 0\ntouches: src/lib/**\nevidence: bun test lib\nacceptance: F1 = specs-it/acceptance/a.it.ts\nsize: S",
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

it("portia touches allow records globs for one child, and list shows them", async () => {
	const none = await portia(
		"touches",
		"list",
		"ACME-203",
		"--parent",
		"ACME-187",
	);
	expect(none.code, none.err).toBe(0);
	expect(none.out).toBe("no extra files approved for ACME-203");
	const r = await portia(
		"touches",
		"allow",
		"acme-203",
		"--parent",
		"ACME-187",
		"src/jobs/registry.ts",
		"--why",
		"registers its own job",
		"src/server/repositories/x-*.ts",
	);
	expect(r.code, r.err).toBe(0);
	expect(approvedGlobs(runDir("ACME-187"), "ACME-203")).toEqual([
		"src/jobs/registry.ts",
		"src/server/repositories/x-*.ts",
	]);
	const list = await portia(
		"touches",
		"list",
		"ACME-203",
		"--parent",
		"ACME-187",
	);
	expect(list.out).toContain("src/jobs/registry.ts  # registers its own job");
	expect(approvedGlobs(runDir("ACME-187"), "ACME-201")).toEqual([]);
});

it("refuses a key that is not a child, and a bare allow", async () => {
	expect(
		(await portia("touches", "allow", "ACME-999", "--parent", "ACME-187", "x"))
			.code,
	).toBe(11);
	const bare = await portia(
		"touches",
		"allow",
		"ACME-203",
		"--parent",
		"ACME-187",
	);
	expect(bare.code).toBe(11);
	expect(bare.err).toContain("usage: portia touches");
});
