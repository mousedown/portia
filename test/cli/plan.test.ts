import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { must, realExec } from "../../src/core/exec";
import { PortiaProblem } from "../../src/core/exit";
import { runDir } from "../../src/core/rundir";
import { appendRow } from "../../src/core/runlog";
import { FakeTracker } from "../support/fake-tracker";

const PROFILE = join(import.meta.dirname, "../fixtures/profile.ts");
const saved = {
	cwd: process.cwd(),
	profile: process.env.PORTIA_PROFILE,
	dry: process.env.PORTIA_DRY_RUN,
	home: process.env.PORTIA_HOME,
};
const restores: (() => void)[] = [];
let dir = "";
let tracker: FakeTracker;

const PARENT_BLOCK =
	"scope: onboarding\nscenario: F1 = Given a parent, Then they see the next best action";
const SPINE_BLOCK =
	"wave: 0\ntouches: src/lib/onboarding/**, specs-it/acceptance/onboarding.it.ts\nevidence: bunx vitest run specs-it/acceptance/onboarding.it.ts\nacceptance: F1 = specs-it/acceptance/onboarding.it.ts";
const UI_BLOCK =
	"wave: 1\nneeds: ACME-201 # the contract\nneeds: ACME-150 # the old endpoint\ntouches: src/app/onboarding/**, specs-it/acceptance/onboarding.it.ts\nrequirements: F1\nevidence: bunx vitest run specs-it/acceptance/onboarding.it.ts";

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "portia-plan-"));
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "packages/acme-web/src"), { recursive: true });
	writeFileSync(join(repo, "packages/acme-web/package.json"), "{}\n");
	writeFileSync(join(repo, "packages/acme-web/src/index.ts"), "\n");
	writeFileSync(join(repo, "turbo.json"), "{}\n");
	await must(realExec, "git", ["init", "-q", "-b", "main", repo]);
	await must(realExec, "git", ["add", "."], { cwd: repo });
	process.chdir(repo);
	process.env.PORTIA_PROFILE = PROFILE;
	process.env.PORTIA_HOME = join(dir, "home");
	tracker = new FakeTracker()
		.add({
			key: "ACME-187",
			summary: "Next best action",
			description: "The epic.",
			blockedBy: [],
		})
		.add(
			{
				key: "ACME-201",
				summary: "Contract",
				description: "Schema and contract.",
				blockedBy: [],
				labels: ["backend"],
			},
			"ACME-187",
		)
		.add(
			{
				key: "ACME-202",
				summary: "UI",
				description: "The card.",
				blockedBy: [],
			},
			"ACME-187",
		)
		.add(
			{
				key: "ACME-150",
				summary: "Old endpoint",
				description: "Shipped.",
				blockedBy: [],
				done: true,
			},
			"ACME-187",
		)
		.add(
			{
				key: "ACME-160",
				summary: "Launch checklist",
				description: "Comms.",
				blockedBy: [],
				labels: ["Launch-Readiness"],
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
		["PORTIA_DRY_RUN", saved.dry],
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

const planFile = (body: object) => {
	const f = join(dir, `plan-${Math.random()}.json`);
	writeFileSync(f, JSON.stringify(body));
	return f;
};
const GOOD = {
	parent: { block: PARENT_BLOCK },
	children: [
		{ key: "ACME-201", block: SPINE_BLOCK, needs: [] },
		{ key: "ACME-202", block: UI_BLOCK, needs: ["ACME-201", "ACME-150"] },
	],
};

it("plan context writes the parent, the children to plan, the done and excluded ones apart, the repo and the gates", async () => {
	tracker.add(
		{
			key: "ACME-203",
			summary: "Already planned",
			description: `Copy.\n\n\`\`\`plan\n${UI_BLOCK}\n\`\`\``,
			blockedBy: ["ACME-201"],
		},
		"ACME-187",
	);
	const out = join(dir, "ctx.json");
	const r = await portia("plan", "context", "acme-187", "--out", out);
	expect(r.code, r.err).toBe(0);
	const ctx = JSON.parse(readFileSync(out, "utf8"));
	expect(ctx.parent).toEqual({
		key: "ACME-187",
		summary: "Next best action",
		description: "The epic.",
		block: null,
	});
	expect(ctx.children.map((c: { key: string }) => c.key)).toEqual([
		"ACME-201",
		"ACME-202",
		"ACME-203",
	]);
	expect(ctx.children[0]).toEqual({
		key: "ACME-201",
		summary: "Contract",
		labels: ["backend"],
		done: false,
		description: "Schema and contract.",
		block: null,
		blockedBy: [],
	});
	expect(ctx.children[2]).toMatchObject({
		description: "Copy.",
		block: UI_BLOCK,
		blockedBy: ["ACME-201"],
	});
	expect(ctx.done).toEqual([
		{
			key: "ACME-150",
			summary: "Old endpoint",
			labels: [],
			done: true,
			block: null,
		},
	]);
	expect(ctx.excluded).toEqual([
		{
			key: "ACME-160",
			summary: "Launch checklist",
			labels: ["Launch-Readiness"],
			done: false,
			block: null,
		},
	]);
	expect(ctx.excludeLabels).toEqual(["launch-readiness"]);
	expect(ctx.lanes).toBe(false);
	expect(ctx.repo.packageDir).toBe("packages/acme-web");
	expect(ctx.repo.topLevel).toEqual(["packages", "turbo.json"]);
	expect(ctx.gates.exit).toContain("acceptance");
	expect(ctx.gates.task.length).toBeGreaterThan(0);
	expect(tracker.writes).toEqual([]);
});

it("plan write puts the parent block on the parent, each child block on its child, and links every need", async () => {
	const r = await portia("plan", "write", "ACME-187", "--from", planFile(GOOD));
	expect(r.code, r.err).toBe(0);
	expect(tracker.writes).toEqual([
		{ kind: "plan", key: "ACME-187", block: PARENT_BLOCK },
		{ kind: "plan", key: "ACME-201", block: SPINE_BLOCK },
		{ kind: "plan", key: "ACME-202", block: UI_BLOCK },
		{ kind: "link", blocker: "ACME-201", blocked: "ACME-202" },
		{ kind: "link", blocker: "ACME-150", blocked: "ACME-202" },
	]);
	expect((await tracker.issue("ACME-202")).description).toBe(
		`The card.\n\n\`\`\`plan\n${UI_BLOCK}\n\`\`\`\n`,
	);
	expect(r.out).toContain("ACME-202");
	const check = await portia("check", "ACME-187");
	expect(check.code, check.out).toBe(0);
});

it("plan write is idempotent: a second write replaces the blocks and adds no link", async () => {
	await portia("plan", "write", "ACME-187", "--from", planFile(GOOD));
	const first = (await tracker.issue("ACME-202")).description;
	tracker.writes.length = 0;
	const r = await portia("plan", "write", "ACME-187", "--from", planFile(GOOD));
	expect(r.code, r.err).toBe(0);
	expect(tracker.writes.filter((w) => w.kind === "link")).toEqual([]);
	expect((await tracker.issue("ACME-202")).description).toBe(first);
	expect((await tracker.issue("ACME-202")).blockedBy).toEqual([
		"ACME-201",
		"ACME-150",
	]);
});

it.each([
	[
		"a bad child block",
		{
			...GOOD,
			children: [GOOD.children[0], { key: "ACME-202", block: "wave: one" }],
		},
		"wave must be a whole number",
	],
	[
		"a bad parent block",
		{ ...GOOD, parent: { block: "scenario: F1 = x" } },
		"needs a scope",
	],
	[
		"a block on a done ticket",
		{ ...GOOD, children: [{ key: "ACME-150", block: SPINE_BLOCK }] },
		"ACME-150 is done",
	],
	[
		"a block on an excluded ticket",
		{ ...GOOD, children: [{ key: "ACME-160", block: SPINE_BLOCK }] },
		"ACME-160 is labelled Launch-Readiness",
	],
	[
		"a ticket outside the parent",
		{ ...GOOD, children: [{ key: "ACME-999", block: SPINE_BLOCK }] },
		"ACME-999 is not a child of ACME-187",
	],
	[
		"needs that disagree with the block",
		{
			...GOOD,
			children: [{ key: "ACME-202", block: UI_BLOCK, needs: ["ACME-201"] }],
		},
		"needs",
	],
	[
		"a need on no ticket",
		{
			...GOOD,
			children: [
				{
					key: "ACME-202",
					block:
						"wave: 1\nneeds: ACME-404 # gone\ntouches: src/app/**\nevidence: x",
				},
			],
		},
		"ACME-404",
	],
	["a file that is not a plan", { children: "nope" }, "plan file"],
	[
		"the same child twice",
		{ ...GOOD, children: [...GOOD.children, GOOD.children[1]] },
		"ACME-202 appears twice in the plan file",
	],
	[
		"a design line without route, persona and frames",
		{
			...GOOD,
			children: [
				GOOD.children[0],
				{
					key: "ACME-202",
					block: `${UI_BLOCK}\ndesign: https://www.figma.com/design/abc/Onboarding?node-id=1-2`,
				},
			],
		},
		"design line needs a link, route=, persona= and frames=",
	],
	[
		"a spine with no failing acceptance test for a scenario",
		{
			...GOOD,
			children: [
				{
					key: "ACME-201",
					block:
						"wave: 0\ntouches: src/lib/onboarding/**, specs-it/acceptance/onboarding.it.ts\nevidence: x",
				},
				GOOD.children[1],
			],
		},
		"the spine names no failing acceptance test for F1",
	],
	[
		"a need in the same wave",
		{
			...GOOD,
			children: [
				GOOD.children[0],
				{ key: "ACME-202", block: UI_BLOCK.replace("wave: 1", "wave: 0") },
			],
		},
		"a need must be in an earlier wave",
	],
	[
		"a child block naming the tool",
		{
			...GOOD,
			children: [
				GOOD.children[0],
				{
					key: "ACME-202",
					block: `${UI_BLOCK}\n# Portia lands this after the spine`,
				},
			],
		},
		"ACME-202: the block names the tool",
	],
	[
		"a parent block naming the tool",
		{ ...GOOD, parent: { block: `${PARENT_BLOCK}\n# planned by portia` } },
		"ACME-187: the block names the tool",
	],
])("plan write refuses %s and writes nothing", async (_name, body, message) => {
	const r = await portia("plan", "write", "ACME-187", "--from", planFile(body));
	expect(r.code).toBe(11);
	expect(r.err).toContain(message);
	expect(tracker.writes).toEqual([]);
	expect((await tracker.issue("ACME-202")).description).toBe("The card.");
});

it("plan write refuses same-wave drafts touching one file", async () => {
	tracker.add(
		{ key: "ACME-203", summary: "Copy", description: "", blockedBy: [] },
		"ACME-187",
	);
	const body = {
		...GOOD,
		children: [
			...GOOD.children,
			{
				key: "ACME-203",
				block:
					"wave: 1\nneeds: ACME-201 # contract\ntouches: src/app/onboarding/**, specs-it/acceptance/onboarding.it.ts\nrequirements: F1\nevidence: y",
			},
		],
	};
	const r = await portia("plan", "write", "ACME-187", "--from", planFile(body));
	expect(r.code).toBe(11);
	expect(r.err).toContain("ACME-202 and ACME-203 both touch");
	expect(tracker.writes).toEqual([]);
});

it("plan write checks the draft against the tickets already planned", async () => {
	tracker.add(
		{
			key: "ACME-203",
			summary: "Already planned",
			description: `\`\`\`plan\nwave: 1\nneeds: ACME-201 # contract\ntouches: src/app/onboarding/card.tsx\nrequirements: F1\nevidence: z\n\`\`\``,
			blockedBy: ["ACME-201"],
		},
		"ACME-187",
	);
	const r = await portia("plan", "write", "ACME-187", "--from", planFile(GOOD));
	expect(r.code).toBe(11);
	expect(r.err).toContain("ACME-202 and ACME-203 both touch");
	expect(tracker.writes).toEqual([]);
});

it("plan write prints warnings and writes anyway", async () => {
	const r = await portia("plan", "write", "ACME-187", "--from", planFile(GOOD));
	expect(r.code, r.err).toBe(0);
	expect(r.out).toContain("warn");
	expect(r.out).toContain("ACME-201 has no size");
	expect(tracker.writes.length).toBe(5);
});

it("plan write under dry run prints what it would write and writes nothing", async () => {
	const r = await portia(
		"--dry-run",
		"plan",
		"write",
		"ACME-187",
		"--from",
		planFile(GOOD),
	);
	expect(r.code, r.err).toBe(0);
	expect(r.out).toContain("ACME-202");
	expect(tracker.writes).toEqual([]);
	expect((await tracker.issue("ACME-202")).blockedBy).toEqual([]);
});

it("plan without a subcommand or its file prints the usage", async () => {
	for (const argv of [
		["plan"],
		["plan", "context", "ACME-187"],
		["plan", "write", "ACME-187"],
	]) {
		const r = await portia(...argv);
		expect(r.code).toBe(11);
		expect(r.err).toContain("usage: portia plan");
	}
});

const started = (child: string, stage: "dispatched" | "landed") =>
	appendRow(runDir("ACME-187"), { at: "t", child, attempt: 1, stage });

it("plan context lists the children already started in a run", async () => {
	started("ACME-201", "dispatched");
	const out = join(dir, "ctx.json");
	expect((await portia("plan", "context", "ACME-187", "--out", out)).code).toBe(
		0,
	);
	expect(JSON.parse(readFileSync(out, "utf8")).run).toEqual({
		started: ["ACME-201"],
	});
});

it("plan write never re-plans a child dispatched or landed in the run, but may add a ticket", async () => {
	expect(
		(await portia("plan", "write", "ACME-187", "--from", planFile(GOOD))).code,
	).toBe(0);
	started("ACME-201", "landed");
	started("ACME-202", "dispatched");
	tracker.writes.length = 0;
	const again = await portia(
		"plan",
		"write",
		"ACME-187",
		"--from",
		planFile(GOOD),
	);
	expect(again.code).toBe(11);
	expect(again.err).toContain("ACME-201 has started in this run");
	expect(again.err).toContain("ACME-202 has started in this run");
	expect(tracker.writes).toEqual([]);

	tracker.add(
		{ key: "ACME-204", summary: "More", description: "", blockedBy: [] },
		"ACME-187",
	);
	const add = await portia(
		"plan",
		"write",
		"ACME-187",
		"--from",
		planFile({
			parent: GOOD.parent,
			children: [
				{
					key: "ACME-204",
					block:
						"wave: 1\nneeds: ACME-201 # contract\ntouches: src/more/**\nrequirements: F1\nevidence: z\nsize: S",
				},
			],
		}),
	);
	expect(add.code, add.err).toBe(0);
	expect(tracker.writes.map((w) => w.kind)).toEqual(["plan", "plan", "link"]);
});

it("plan write stopped part way says so, and the same file finishes it", async () => {
	const link = tracker.link.bind(tracker);
	let calls = 0;
	tracker.link = async (blocker, blocked) => {
		if (++calls === 2) throw new PortiaProblem("Jira said 503");
		return link(blocker, blocked);
	};
	const r = await portia("plan", "write", "ACME-187", "--from", planFile(GOOD));
	expect(r.code).toBe(11);
	expect(r.err).toContain(
		"partially written (4 of 5 blocks/links done): Jira said 503; fix the cause and re-run the same file",
	);
	const again = await portia(
		"plan",
		"write",
		"ACME-187",
		"--from",
		planFile(GOOD),
	);
	expect(again.code, again.err).toBe(0);
	expect((await tracker.issue("ACME-202")).blockedBy).toEqual([
		"ACME-201",
		"ACME-150",
	]);
});

it("plan specs names a spec that requests a route another child delivers, which its owner does not need", async () => {
	const fence = (b: string) => `\n\n\`\`\`plan\n${b}\n\`\`\``;
	const settings =
		"wave: 1\nneeds: ACME-201 # the contract\ntouches: src/app/settings/**\nrequirements: F2\nevidence: bunx vitest run specs-it/acceptance/settings.it.ts";
	const planned = new FakeTracker().add({
		key: "ACME-187",
		summary: "Next best action",
		description: `The epic.${fence(`${PARENT_BLOCK}\nscenario: F2 = Given settings, Then they save`)}`,
		blockedBy: [],
	});
	for (const [key, block, description, blockedBy] of [
		[
			"ACME-201",
			`${SPINE_BLOCK}\nacceptance: F2 = specs-it/acceptance/settings.it.ts`,
			"Schema and contract.",
			[],
		],
		[
			"ACME-202",
			"wave: 1\nneeds: ACME-201 # the contract\ntouches: src/app/onboarding/**, specs-it/acceptance/onboarding.it.ts\nrequirements: F1\nevidence: bunx vitest run specs-it/acceptance/onboarding.it.ts",
			"The card, from `GET /api/next-action`.",
			["ACME-201"],
		],
		["ACME-203", settings, "Saves settings.", ["ACME-201"]],
	] as const)
		planned.add(
			{
				key,
				summary: key,
				description: `${description}${fence(block)}`,
				blockedBy: [...blockedBy],
			},
			"ACME-187",
		);
	restores.push(useTracker(planned));
	const spine = join(dir, "spine");
	const specs = join(spine, "packages/acme-web/specs-it/acceptance");
	mkdirSync(specs, { recursive: true });
	for (const f of ["onboarding.it.ts", "settings.it.ts"])
		writeFileSync(join(specs, f), 'await get("/api/next-action");\n');
	await must(realExec, "git", ["init", "-q", spine]);
	const r = await portia("plan", "specs", "ACME-187", "--dir", spine, "--json");
	expect(r.code, r.err).toBe(0);
	expect(JSON.parse(r.out)).toEqual({
		coupling: [
			{
				scenario: "F2",
				spec: "packages/acme-web/specs-it/acceptance/settings.it.ts",
				owner: "ACME-203",
				other: "ACME-202",
				via: "route",
				target: "/api/next-action",
			},
		],
	});
	const text = await portia("plan", "specs", "ACME-187", "--dir", spine);
	expect(text.code).toBe(0);
	expect(text.out).toContain("ACME-203 (owner of F2) does not need ACME-202");
	expect(text.out).toContain("1 coupling(s)");
	expect(planned.writes).toEqual([]);
});

const ARTIFACT =
	"https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-123456789abc";

it("records the plan page's link, and refuses anything but an artifact link", async () => {
	const ok = await portia("plan", "link", "acme-187", ARTIFACT);
	expect(ok.code, ok.err).toBe(0);
	const saved = JSON.parse(
		readFileSync(join(runDir("ACME-187"), "plan-link.json"), "utf8"),
	);
	expect(saved.url).toBe(ARTIFACT);
	const bad = await portia("plan", "link", "ACME-187", "https://example.com/x");
	expect(bad.code).not.toBe(0);
	expect(
		JSON.parse(readFileSync(join(runDir("ACME-187"), "plan-link.json"), "utf8"))
			.url,
	).toBe(ARTIFACT);
});

it("writes the plan page, and says which link it already has", async () => {
	const draft = join(dir, "draft.json");
	writeFileSync(
		draft,
		JSON.stringify({
			parent: { block: PARENT_BLOCK },
			children: [
				{ key: "ACME-201", block: SPINE_BLOCK, needs: [] },
				{ key: "ACME-202", block: UI_BLOCK, needs: ["ACME-201", "ACME-150"] },
			],
		}),
	);
	const wrote = await portia("plan", "write", "ACME-187", "--from", draft);
	expect(wrote.code, wrote.err).toBe(0);
	const file = join(dir, "page.html");
	const first = await portia(
		"plan",
		"page",
		"ACME-187",
		"--out",
		file,
		"--json",
	);
	expect(first.code, first.err).toBe(0);
	expect(JSON.parse(first.out)).toEqual({ out: file, url: null });
	expect(readFileSync(file, "utf8")).toContain(
		"<title>ACME-187 wave plan</title>",
	);
	await portia("plan", "link", "ACME-187", ARTIFACT);
	const again = await portia(
		"plan",
		"page",
		"ACME-187",
		"--out",
		file,
		"--json",
	);
	expect(JSON.parse(again.out)).toEqual({ out: file, url: ARTIFACT });
});

it("refuses a run another repository owns, for a command that only reads it and one that writes", async () => {
	const dir = runDir("ACME-187");
	writeFileSync(join(dir, "repo.json"), JSON.stringify({ repo: "other-repo" }));
	const out = join(tmpdir(), `portia-ctx-${process.pid}.json`);
	for (const r of [
		await portia("plan", "context", "ACME-187", "--out", out),
		await portia(
			"plan",
			"link",
			"ACME-187",
			"https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-123456789abc",
		),
	]) {
		expect(r.code).toBe(11);
		expect(r.err).toMatch(/ACME-187 is a run of other-repo/);
	}
});
