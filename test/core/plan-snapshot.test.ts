import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { must, realExec } from "../../src/core/exec";
import { PLAN_FILE, writePlanSnapshot } from "../../src/core/plan-snapshot";
import { parent, spine } from "../helpers/plan";
import { FakeTracker } from "../support/fake-tracker";

/** §4.4: the commands that own the run directory record the plan; check never does. */
const PROFILE = join(import.meta.dirname, "../fixtures/profile.ts");
const saved = {
	cwd: process.cwd(),
	profile: process.env.PORTIA_PROFILE,
	home: process.env.PORTIA_HOME,
};
const restores: (() => void)[] = [];
let tracker: FakeTracker;
let home: string;

const fenced = (b: string) => `\`\`\`plan\n${b}\n\`\`\``;

beforeEach(async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-snapshot-"));
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "packages/acme-web"), { recursive: true });
	writeFileSync(join(repo, "packages/acme-web/package.json"), "{}\n");
	await must(realExec, "git", ["init", "-q", "-b", "main", repo]);
	await must(realExec, "git", ["add", "."], { cwd: repo });
	process.chdir(repo);
	process.env.PORTIA_PROFILE = PROFILE;
	home = join(dir, "home");
	process.env.PORTIA_HOME = home;
	tracker = new FakeTracker()
		.add({
			key: "ACME-500",
			summary: "Self-serve invoices for team accounts",
			description: fenced(
				"scope: billing\nscenario: R1 = Given a team, Then an invoice",
			),
			blockedBy: [],
		})
		.add(
			{
				key: "ACME-501",
				summary: "Invoice model",
				description: fenced(
					"wave: 0\ntouches: src/invoice/**\nevidence: bun test invoice\nacceptance: R1 = specs-it/acceptance/invoice.it.ts\nsize: S",
				),
				blockedBy: [],
			},
			"ACME-500",
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

const portia = (...argv: string[]) =>
	runCli(argv, { out: () => {}, err: () => {} });
const snap = () => join(home, "runs", "ACME-500", PLAN_FILE);

it("(a) portia status writes plan.json, version 1", async () => {
	expect(await portia("status", "ACME-500")).toBe(0);
	const s = JSON.parse(readFileSync(snap(), "utf8"));
	expect(s.version).toBe(1);
	expect(s.plan.key).toBe("ACME-500");
	expect(s.plan.summary).toBe("Self-serve invoices for team accounts");
	expect(s.plan.children.map((c: { key: string }) => c.key)).toEqual([
		"ACME-501",
	]);
	expect(Date.parse(s.at)).not.toBeNaN();
});

it("(b) portia check leaves the run directory uncreated", async () => {
	await portia("check", "ACME-500");
	expect(existsSync(join(home, "runs", "ACME-500"))).toBe(false);
});

it("(c) an unchanged plan is not rewritten", async () => {
	await portia("status", "ACME-500");
	const old = new Date("2026-01-01T00:00:00Z");
	utimesSync(snap(), old, old);
	const before = readFileSync(snap(), "utf8");
	await portia("status", "ACME-500");
	expect(statSync(snap()).mtimeMs).toBe(old.getTime());
	expect(readFileSync(snap(), "utf8")).toBe(before);
});

it("(d) a changed plan rewrites the file", async () => {
	await portia("status", "ACME-500");
	await tracker.setPlanBlock(
		"ACME-501",
		"wave: 0\ntouches: src/invoice/**, src/money/**\nevidence: bun test invoice\nacceptance: R1 = specs-it/acceptance/invoice.it.ts\nsize: S",
	);
	await portia("status", "ACME-500");
	const s = JSON.parse(readFileSync(snap(), "utf8"));
	expect(s.plan.children[0].touches.join(" ")).toContain("src/money/**");
});

it("(e) a read-only run directory does not make status fail", async () => {
	const dir = join(home, "runs", "ACME-500");
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o555);
	try {
		expect(await portia("status", "ACME-500")).toBe(0);
		expect(existsSync(snap())).toBe(false);
	} finally {
		chmodSync(dir, 0o755);
	}
});

it("writes atomically and leaves no temporary file behind", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-snapshot-unit-"));
	const plan = parent([spine()]);
	writePlanSnapshot(dir, plan, new Date("2026-10-20T14:00:31Z"));
	expect(JSON.parse(readFileSync(join(dir, PLAN_FILE), "utf8")).at).toBe(
		"2026-10-20T14:00:31.000Z",
	);
	writePlanSnapshot(dir, plan, new Date("2026-10-21T00:00:00Z"));
	expect(JSON.parse(readFileSync(join(dir, PLAN_FILE), "utf8")).at).toBe(
		"2026-10-20T14:00:31.000Z",
	);
	expect(readFileSync(join(dir, PLAN_FILE), "utf8")).toContain(
		'\t"version": 1',
	);
	writePlanSnapshot(join(dir, "missing"), plan);
	expect(existsSync(join(dir, "missing"))).toBe(false);
});
