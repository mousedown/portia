import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { must, realExec } from "../../src/core/exec";
import { runDir } from "../../src/core/rundir";
import { appendRow } from "../../src/core/runlog";
import { FakeTracker } from "../support/fake-tracker";

const FIXTURE = join(import.meta.dirname, "../fixtures/profile.ts");
const saved = {
	cwd: process.cwd(),
	profile: process.env.PORTIA_PROFILE,
	home: process.env.PORTIA_HOME,
};
const restores: (() => void)[] = [];
let base: string;
let tracker: FakeTracker;

const fenced = (b: string) => `\`\`\`plan\n${b}\n\`\`\``;

beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "portia-questions-cli-"));
	const repo = join(base, "repo");
	for (const f of [
		"packages/acme-web/package.json",
		"src/lib/x.ts",
		"src/b/x.ts",
	]) {
		mkdirSync(join(repo, f, ".."), { recursive: true });
		writeFileSync(join(repo, f), "{}\n");
	}
	await must(realExec, "git", ["init", "-q", "-b", "main", repo]);
	await must(realExec, "git", ["add", "."], { cwd: repo });
	process.chdir(repo);
	process.env.PORTIA_PROFILE = FIXTURE;
	process.env.PORTIA_HOME = join(base, "home");
	tracker = new FakeTracker()
		.add({
			key: "ACME-187",
			summary: "Epic",
			description: `The epic.\n\n${fenced("scope: onboarding\nscenario: F1 = Given x, Then y")}`,
			blockedBy: [],
		})
		.add(
			{
				key: "ACME-201",
				summary: "Spine",
				description: `The contract.\n\n${fenced(
					"wave: 0\ntouches: src/lib/**\nevidence: bun test lib\nacceptance: F1 = specs-it/acceptance/a.it.ts\nsize: S",
				)}`,
				blockedBy: [],
			},
			"ACME-187",
		)
		.add(
			{
				key: "ACME-203",
				summary: "Badge",
				description: `Show a badge.\n\n## Questions\n- Is it behind a flag?\n\n${fenced(
					"wave: 1\nneeds: ACME-201 # contract\n? should it show on mobile\ntouches: src/b/**\nrequirements: F1\nevidence: bun test b\nsize: S",
				)}`,
				blockedBy: ["ACME-201"],
			},
			"ACME-187",
		);
	restores.push(useTracker(tracker));
	const dir = runDir("ACME-187");
	for (const key of ["ACME-201", "ACME-203"])
		writeFileSync(
			join(dir, `env-${key}.json`),
			JSON.stringify({
				worktree: `/wt/${key}`,
				branch: `portia/${key}`,
				db: "d",
				port: 3101,
				envFile: `/wt/${key}/.env.portia`,
			}),
		);
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

function askOnce() {
	const f = join(base, "ask-once.profile.ts");
	writeFileSync(
		f,
		`import p from ${JSON.stringify(FIXTURE)};\nexport default { ...p, askOnce: true };\n`,
	);
	process.env.PORTIA_PROFILE = f;
}

async function edit(key: string, from: string, to: string) {
	const i = await tracker.issue(key);
	i.description = i.description.replace(from, to);
}

it("without askOnce, asks nothing, records nothing and dispatches as before", async () => {
	await edit("ACME-203", "? should it show on mobile\n", "");
	const q = await portia("questions", "ACME-187");
	expect(q.code, q.err).toBe(0);
	expect(JSON.parse(q.out)).toEqual([]);
	expect(existsSync(join(runDir("ACME-187"), "questions.json"))).toBe(false);
	const d = await portia("dispatch", "ACME-201", "--parent", "ACME-187");
	expect(d.code, d.err).toBe(0);
	const b = await portia("brief", "ACME-203", "--parent", "ACME-187");
	expect(b.out).not.toContain("Answers from the person");
});

it("with askOnce, dispatch waits until every question is answered, then the brief carries the answers", async () => {
	askOnce();
	const early = await portia("dispatch", "ACME-201", "--parent", "ACME-187");
	expect(early.code).toBe(11);
	expect(early.err).toContain("run portia questions ACME-187");

	const q = await portia("questions", "acme-187");
	expect(q.code, q.err).toBe(11);
	expect(
		JSON.parse(q.out).map((x: { id: string; question: string }) => [
			x.id,
			x.question,
		]),
	).toEqual([
		["ACME-203/open-1", "Is it behind a flag?"],
		["ACME-203/open-2", "should it show on mobile"],
	]);

	const blocked = await portia("dispatch", "ACME-201", "--parent", "ACME-187");
	expect(blocked.code).toBe(11);
	expect(blocked.err).toContain("2 question(s) unanswered");

	const file = join(base, "answers.json");
	writeFileSync(file, JSON.stringify({ "ACME-203/open-1": "no flag" }));
	const partly = await portia("answer", "ACME-187", "--from", file);
	expect(partly.code).toBe(11);
	expect(JSON.parse(partly.out)).toHaveLength(1);
	writeFileSync(file, JSON.stringify({ "ACME-203/open-2": "yes" }));
	const done = await portia("answer", "ACME-187", "--from", file);
	expect(done.code, done.err).toBe(0);
	expect(JSON.parse(done.out)).toEqual([]);

	expect((await portia("questions", "ACME-187")).code).toBe(0);
	const d = await portia("dispatch", "ACME-201", "--parent", "ACME-187");
	expect(d.code, d.err).toBe(0);
	const b = await portia("brief", "ACME-203", "--parent", "ACME-187");
	expect(b.out).toContain("- Is it behind a flag? Answer: no flag");
	expect(b.out).toContain("- should it show on mobile Answer: yes");
	const spine = await portia("brief", "ACME-201", "--parent", "ACME-187");
	expect(spine.out).not.toContain("Answers from the person");
});

it("refuses an answer file naming an unknown question", async () => {
	askOnce();
	await portia("questions", "ACME-187");
	const file = join(base, "answers.json");
	writeFileSync(file, JSON.stringify({ "ACME-999/open-1": "x" }));
	const r = await portia("answer", "ACME-187", "--from", file);
	expect(r.code).toBe(11);
	expect(r.err).toContain("ACME-999/open-1");
	expect((await portia("answer", "ACME-187")).err).toContain(
		"usage: portia answer",
	);
});

it("without askOnce, a '?' line in a plan block is still a parse error", async () => {
	const r = await portia("check", "ACME-187");
	expect(r.code).toBe(11);
	expect(`${r.out}\n${r.err}`).toContain(
		"not a 'key: value' line: \"? should it show on mobile\"",
	);
});

it("asks for detail, missing touches and a check warning through the CLI", async () => {
	askOnce();
	tracker.add(
		{
			key: "ACME-204",
			summary: "Report",
			description: fenced(
				"wave: 2\nneeds: ACME-203 # badge\ntouches: src/new/**\nrequirements: F1\nevidence: bun test new",
			),
			blockedBy: ["ACME-203"],
		},
		"ACME-187",
	);
	const q = await portia("questions", "ACME-187");
	expect(q.code, q.err).toBe(11);
	const qs = JSON.parse(q.out) as { id: string; question: string }[];
	expect(qs.map((x) => x.id)).toEqual([
		"ACME-203/open-1",
		"ACME-203/open-2",
		"ACME-204/detail",
		"ACME-204/touches-missing",
		"ACME-204/warn-1",
	]);
	expect(qs[3]?.question).toContain("src/new/**");
	expect(qs[4]?.question).toContain("ACME-204 has no size");
	expect(qs[4]?.question).toContain("plan as written");
});

it("asks nothing about a child landed in the run or closed in the tracker", async () => {
	askOnce();
	tracker.add(
		{
			key: "ACME-205",
			summary: "Done already",
			description: `## Questions\n- Still wanted?\n\n${fenced(
				"wave: 2\nneeds: ACME-203 # badge\ntouches: src/b/**\nrequirements: F1\nevidence: bun test b2\nsize: S",
			)}`,
			blockedBy: ["ACME-203"],
			done: true,
		},
		"ACME-187",
	);
	appendRow(runDir("ACME-187"), {
		child: "ACME-203",
		attempt: 1,
		stage: "landed",
		status: "landed",
	});
	const q = await portia("questions", "ACME-187");
	expect(q.code, q.err).toBe(0);
	expect(JSON.parse(q.out)).toEqual([]);
});

it("asks a ticket question again once its ticket changes it", async () => {
	askOnce();
	await portia("questions", "ACME-187");
	const file = join(base, "answers.json");
	writeFileSync(
		file,
		JSON.stringify({ "ACME-203/open-1": "no", "ACME-203/open-2": "yes" }),
	);
	expect((await portia("answer", "ACME-187", "--from", file)).code).toBe(0);
	await edit(
		"ACME-203",
		"Is it behind a flag?",
		"Is it behind a feature flag?",
	);
	const q = await portia("questions", "ACME-187");
	expect(q.code).toBe(11);
	expect(JSON.parse(q.out)).toEqual([
		{
			id: "ACME-203/open-1",
			child: "ACME-203",
			kind: "open",
			question: "Is it behind a feature flag?",
		},
	]);
});

it("status warns while questions are uncollected or unanswered", async () => {
	askOnce();
	const warnings = async () =>
		JSON.parse((await portia("status", "ACME-187", "--json")).out)
			.warnings as string[];
	expect(await warnings()).toEqual([
		"run portia questions ACME-187 before dispatching (the profile sets askOnce)",
	]);
	await portia("questions", "ACME-187");
	expect((await warnings())[0]).toContain("2 question(s) unanswered");
	const file = join(base, "answers.json");
	writeFileSync(
		file,
		JSON.stringify({ "ACME-203/open-1": "no", "ACME-203/open-2": "yes" }),
	);
	await portia("answer", "ACME-187", "--from", file);
	expect(await warnings()).toEqual([]);
});

it("brief loads the plan once and takes the ticket text from it, not from another fetch", async () => {
	await edit("ACME-203", "? should it show on mobile\n", "");
	const seen: string[] = [];
	const issue = tracker.issue.bind(tracker);
	const children = tracker.children.bind(tracker);
	tracker.issue = async (k) => {
		seen.push(`issue ${k}`);
		return issue(k);
	};
	tracker.children = async (k) => {
		seen.push(`children ${k}`);
		return children(k);
	};
	const b = await portia("brief", "ACME-203", "--parent", "ACME-187");
	expect(b.code, b.err).toBe(0);
	expect(b.out).toContain("Show a badge.");
	expect(seen).toEqual(["issue ACME-187", "children ACME-187"]);
});
