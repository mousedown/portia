import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	briefVars,
	claimSection,
	environmentSection,
	fill,
	hooksSection,
	scenarioTickets,
	ticketText,
} from "../../src/brief/render";
import { recordLandFailure } from "../../src/cli/commands/land";
import { PortiaProblem } from "../../src/core/exit";
import {
	appendRow,
	failures,
	previousAttempt,
	readRows,
} from "../../src/core/runlog";
import type { RunRow } from "../../src/core/types";
import { adfToText } from "../../src/plan/adf";
import { answersSection } from "../../src/questions/questions";
import { child, parent, spine } from "../helpers/plan";

const env = {
	worktree: "/wt/ACME-2",
	branch: "portia/ACME-2",
	db: "d",
	port: 3101,
	envFile: "/wt/ACME-2/packages/acme-web/.env.portia",
};
const plan = parent(
	[spine(), child("ACME-2", { requirements: ["F2"] }), child("ACME-3")],
	[
		{ id: "F1", text: "one" },
		{ id: "F2", text: "two" },
	],
);

describe("fill", () => {
	it("fills every placeholder and refuses a missing one", () => {
		expect(
			fill("Hi {{child}} in {{worktree}}", {
				child: "ACME-2",
				worktree: "/wt",
			}),
		).toBe("Hi ACME-2 in /wt");
		expect(() => fill("{{nope}}", {})).toThrow(PortiaProblem);
	});
});

describe("the ticket in the brief", () => {
	it("keeps a Jira description's Gherkin and design links, without the plan block", () => {
		const FIGMA = "https://www.figma.com/design/abc/Onboarding?node-id=1-2";
		const WIKI =
			"https://acme.atlassian.net/wiki/spaces/ENG/pages/42/Onboarding";
		const doc = {
			type: "doc",
			version: 1,
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "See the " },
						{
							type: "text",
							text: "Figma design",
							marks: [{ type: "link", attrs: { href: FIGMA } }],
						},
						{ type: "text", text: "." },
					],
				},
				{ type: "blockCard", attrs: { url: WIKI } },
				{
					type: "codeBlock",
					attrs: { language: "gherkin" },
					content: [
						{
							type: "text",
							text: "Scenario: a parent with no child\n  Given a parent with no child\n  Then they are asked to add a child",
						},
					],
				},
				{
					type: "codeBlock",
					attrs: { language: "plan" },
					content: [{ type: "text", text: "wave: 1\ntouches: src/app/**" }],
				},
			],
		};
		const template = readFileSync(
			join(import.meta.dirname, "../../skills/portia/worker-brief.md"),
			"utf8",
		);
		const out = fill(
			template,
			briefVars(
				plan,
				child("ACME-2", { requirements: ["F2"] }),
				env,
				ticketText(adfToText(doc)),
			),
		);
		const start = out.indexOf("## The ticket");
		const ticket = out.slice(start, out.indexOf("\n## ", start + 1));
		expect(ticket).toContain(`Figma design (${FIGMA})`);
		expect(ticket).toContain(WIKI);
		expect(ticket).toContain(
			"Scenario: a parent with no child\n  Given a parent with no child\n  Then they are asked to add a child",
		);
		expect(ticket).not.toContain("touches: src/app/**");
		expect(ticket).not.toContain("```plan");
	});
	it("carries the ticket's acceptance criteria and links, without the plan block", () => {
		const raw = [
			"Show the parent their next best action.",
			"",
			"Design: https://www.figma.com/design/abc/Onboarding?node-id=1-2",
			"",
			"Scenario: a parent with no child",
			"  Given a parent with no child",
			"  When they open the dashboard",
			"  Then they are asked to add a child",
			"",
			"```plan",
			"wave: 1",
			"touches: src/app/**",
			"```",
		].join("\n");
		const template = readFileSync(
			join(import.meta.dirname, "../../skills/portia/worker-brief.md"),
			"utf8",
		);
		const out = fill(
			template,
			briefVars(
				plan,
				child("ACME-2", { requirements: ["F2"] }),
				env,
				ticketText(raw),
			),
		);
		expect(out).toContain(
			"## The ticket\n\nShow the parent their next best action.",
		);
		expect(out).toContain(
			"https://www.figma.com/design/abc/Onboarding?node-id=1-2",
		);
		expect(out).toContain(
			"Scenario: a parent with no child\n  Given a parent with no child\n  When they open the dashboard\n  Then they are asked to add a child",
		);
		expect(out).not.toContain("```plan");
		expect(out).not.toContain("touches: src/app/**\n```");
	});
});

describe("briefVars", () => {
	it("gives a wave child only its own scenarios", () => {
		const v = briefVars(plan, plan.children[1]!, env, "desc");
		expect(v.scenarios).toBe("- F2: two");
		expect(v.role).toContain("wave 1");
		expect(v.design).toBe("");
	});
	it("shows a wave child the spine's spec path for each scenario it owns", () => {
		const c = child("ACME-2", { requirements: ["F2"] });
		const p = parent(
			[
				spine({
					acceptance: {
						F1: "packages/acme-web/e2e/a.e2e.ts",
						F2: "packages/acme-web/e2e/onboarding/checklist.e2e.ts",
					},
				}),
				c,
			],
			[
				{ id: "F1", text: "one" },
				{ id: "F2", text: "two" },
			],
		);
		expect(briefVars(p, c, env, "d").scenarios).toBe(
			"- F2: two (test in packages/acme-web/e2e/onboarding/checklist.e2e.ts)",
		);
	});
	it("gives the spine every scenario with its acceptance path", () => {
		const v = briefVars(plan, plan.children[0]!, env, "desc");
		expect(v.scenarios).toContain(
			"- F1: one (failing test in packages/acme-web/e2e/a.e2e.ts)",
		);
		expect(v.role).toContain("You are the spine");
		expect(v.role).toContain("Start each test's title with its scenario id");
		expect(v.role).not.toContain("You also own");
	});
	it("tells the spine which scenarios it owns must pass, and leaves the rest failing", () => {
		const s = spine({
			requirements: ["F1"],
			acceptance: {
				F1: "packages/acme-web/e2e/a.e2e.ts",
				F2: "packages/acme-web/e2e/b.e2e.ts",
			},
		});
		const v = briefVars(
			parent([s, child("ACME-2", { requirements: ["F2"] })], plan.scenarios),
			s,
			env,
			"desc",
		);
		expect(v.scenarios).toBe(
			[
				"- F1: one (test in packages/acme-web/e2e/a.e2e.ts)",
				"- F2: two (failing test in packages/acme-web/e2e/b.e2e.ts)",
			].join("\n"),
		);
		expect(v.role).toContain(
			"You also own F1: no later child can deliver it, so make its test pass here",
		);
		expect(v.role).toContain("Every other test must still fail.");
	});
	it("adds the design rules for a design-led child", () => {
		const c = child("ACME-4", {
			design: "https://x route=/discover persona=p frames=f-1440",
		});
		expect(
			briefVars(parent([spine(), c, child("ACME-5")]), c, env, "d").design,
		).toContain("design-system tokens");
	});
	it("tells the spine to export the persona helpers a design line names", () => {
		const c = child("ACME-4", {
			design: "https://x route=/discover persona=p frames=f-1440",
		});
		const v = briefVars(parent([spine(), c]), spine(), env, "d", {
			p: "onboarding/personas#pHelper",
		});
		expect(v.role).toContain("Export each persona helper");
		expect(v.role).toContain("fresh test user");
		expect(v.role).toContain("p = onboarding/personas#pHelper");
		expect(v.role).toContain("acceptance tests should reuse");
	});
	it("says nothing about personas when no child has a design line", () => {
		expect(briefVars(plan, plan.children[0]!, env, "d").role).not.toContain(
			"persona",
		);
	});
});

describe("previous attempt", () => {
	const row = (o: Partial<RunRow>): RunRow => ({
		at: "t",
		child: "ACME-2",
		attempt: 1,
		stage: "dispatched",
		...o,
	});
	it("names the newest recorded failure and is empty on a first attempt", () => {
		expect(previousAttempt([row({})], "ACME-2")).toBe("");
		const rows = [
			row({}),
			row({
				stage: "result",
				status: "failed",
				data: { message: "tests red" },
			}),
			row({ attempt: 2 }),
			row({
				attempt: 2,
				stage: "land",
				status: "failed",
				data: { reason: "CI failed on PR #9: lint" },
			}),
		];
		expect(previousAttempt(rows, "ACME-2")).toBe(
			"## Previous attempt\n\nAttempt 2 failed: CI failed on PR #9: lint. Fix that first.\n\nYour worktree may already hold partial work from an earlier attempt: check `git status` and `git log` first, and build on it rather than starting over.\n",
		);
		expect(previousAttempt(rows, "ACME-3")).toBe("");
		const v = briefVars(plan, child("ACME-2"), env, "d", {}, "X");
		expect(v.previous).toBe("\nX");
	});
	it("counts failures, not dispatches", () => {
		const rows = [
			row({}),
			row({ attempt: 2 }),
			row({ stage: "result", status: "done" }),
			row({ stage: "result", status: "failed", data: { message: "a" } }),
			row({ stage: "land", status: "failed", data: { reason: "b" } }),
		];
		expect(failures(rows, "ACME-2").map((f) => f.reason)).toEqual(["a", "b"]);
		expect(failures(rows.slice(0, 2), "ACME-2")).toEqual([]);
	});
	it("does not count a land CI or GitHub failed against the child's retries", () => {
		const rows = [
			row({}),
			row({ stage: "result", status: "done" }),
			row({
				stage: "land",
				status: "failed",
				data: { reason: "no CI checks appeared", infra: true },
			}),
			row({ stage: "land", status: "failed", data: { reason: "exit gate" } }),
		];
		expect(failures(rows, "ACME-2").map((f) => f.reason)).toEqual([
			"exit gate",
		]);
		expect(previousAttempt(rows.slice(0, 3), "ACME-2")).toBe("");
	});
	it("records a failed land in the run log only for failures", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-run-"));
		appendRow(dir, { child: "ACME-2", attempt: 1, stage: "dispatched" });
		recordLandFailure(dir, "ACME-2", { status: "landed", pr: 1, sha: "s" });
		recordLandFailure(dir, "ACME-2", {
			status: "failed",
			reason: "merge refused",
		});
		const rows = readRows(dir).rows;
		expect(failures(rows, "ACME-2")).toEqual([
			{ attempt: 1, reason: "merge refused" },
		]);
	});
});

describe("previous attempt rendering", () => {
	const template = readFileSync(
		join(__dirname, "../../skills/portia/worker-brief.md"),
		"utf8",
	);
	const render = (previous: string) =>
		fill(template, briefVars(plan, child("ACME-2"), env, "d", {}, previous));
	const r = (o: Partial<RunRow>): RunRow => ({
		at: "t",
		child: "ACME-2",
		attempt: 1,
		stage: "dispatched",
		...o,
	});

	it("leaves exactly one blank line before ## Evidence, with or without a previous section", () => {
		const failed = [
			r({}),
			r({ stage: "result", status: "failed", data: { message: "red" } }),
			r({ attempt: 2 }),
		];
		for (const previous of ["", previousAttempt(failed, "ACME-2")]) {
			const out = render(previous);
			expect(out).toMatch(/\S\n\n## Evidence/);
			expect(out).toMatch(/\S\n\n## Rules/);
			expect(out).not.toContain("\n\n\n");
		}
		const d = child("ACME-2", {
			design: "https://x route=/discover persona=p frames=f-1440",
		});
		const designed = fill(template, briefVars(plan, d, env, "d", {}, ""));
		expect(designed).toMatch(/mock data\.\n\n## Rules/);
		expect(designed).not.toContain("\n\n\n");
	});

	it("puts the person's answers after the ticket, and nothing without them", () => {
		const answers = answersSection(
			[{ id: "Q", kind: "open", question: "Which page?", answer: "settings" }],
			"ACME-2",
		);
		const out = fill(
			template,
			briefVars(plan, child("ACME-2"), env, "d", {}, "", "", answers),
		);
		expect(out).toMatch(
			/## The ticket\n\nd\n\n## Answers from the person\n\n.*\n\n- Which page\? Answer: settings\n\n## Scenarios/,
		);
		expect(out).not.toContain("\n\n\n");
		expect(render("")).toMatch(/## The ticket\n\nd\n\n## Scenarios/);
	});

	it("does not double a full stop the reason already has", () => {
		const rows = [
			r({}),
			r({ stage: "result", status: "failed", data: { message: "tests red." } }),
		];
		expect(previousAttempt(rows, "ACME-2")).toContain(
			"Attempt 1 failed: tests red. Fix that first.",
		);
		expect(previousAttempt(rows, "ACME-2")).not.toContain("..");
	});

	it("puts a multi-line reason's output in a code block", () => {
		const rows = [
			r({}),
			r({
				stage: "land",
				status: "failed",
				data: {
					reason:
						"exit gate failed on the rebased head (R6): unit\nFAIL a.test.ts\n1 failed",
				},
			}),
		];
		expect(previousAttempt(rows, "ACME-2")).toContain(
			"Attempt 1 failed: exit gate failed on the rebased head (R6): unit. Fix that first.\n\n```\nFAIL a.test.ts\n1 failed\n```\n",
		);
	});

	it("tells a redispatched worker its worktree may hold earlier work, from attempt 2 on", () => {
		const note = "may already hold partial work from an earlier attempt";
		expect(previousAttempt([r({})], "ACME-2")).toBe("");
		const redispatched = previousAttempt([r({}), r({ attempt: 2 })], "ACME-2");
		expect(redispatched).toContain("## Previous attempt");
		expect(redispatched).toContain(note);
		expect(render(redispatched)).toContain(note);
	});
});

describe("the Environment section", () => {
	const template = readFileSync(
		join(import.meta.dirname, "../../skills/portia/worker-brief.md"),
		"utf8",
	);
	const render = (environment: string) =>
		fill(
			template,
			briefVars(
				plan,
				plan.children[1] as (typeof plan.children)[number],
				env,
				"d",
				{},
				"",
				environment,
			),
		);

	it("is empty with no notes and a repo-root profile", () => {
		expect(environmentSection([])).toBe("");
		expect(
			environmentSection([], { file: "/repo/portia.config.ts", via: "repo" }),
		).toBe("");
		const out = render("");
		expect(out).not.toContain("## Environment");
		expect(out).toMatch(/layer\.\n\n## Your last message/);
	});

	it("tells the worker how to load the same profile when it came from PORTIA_PROFILE or ~/.portia/profiles", () => {
		for (const via of ["env", "home"] as const) {
			const s = environmentSection([], { file: "/p/acme-web.ts", via });
			expect(s).toContain("`PORTIA_PROFILE=/p/acme-web.ts portia …`");
		}
	});

	it("quotes a profile path the shell would split", () => {
		const s = environmentSection([], {
			file: "/Users/a b/it's.ts",
			via: "home",
		});
		expect(s).toContain("`PORTIA_PROFILE='/Users/a b/it'\\''s.ts' portia …`");
	});

	it("renders the profile's notes at the end, before the result contract", () => {
		const out = render(
			environmentSection(["Run one suite at a time.", "Park if unsure."], {
				file: "/p/acme-web.ts",
				via: "home",
			}),
		);
		expect(out).toMatch(
			/layer\.\n\n## Environment\n\n- Run every portia command as .*\n- Run one suite at a time\.\n- Park if unsure\.\n\n## Your last message/,
		);
		expect(out).not.toContain("\n\n\n");
	});
});

describe("a detached worker's brief", () => {
	const template = readFileSync(
		join(import.meta.dirname, "../../skills/portia/worker-brief.md"),
		"utf8",
	);
	const render = (resultFile?: string) =>
		fill(
			template,
			briefVars(plan, child("ACME-2"), env, "d", {}, "", "", "", resultFile),
		);

	it("names the result file after the result shape", () => {
		const out = render("/runs/ACME-0/result-ACME-2-1.json");
		expect(out.endsWith('"<only when failed>"}\n')).toBe(false);
		expect(out).toContain(
			"write the same object to `/runs/ACME-0/result-ACME-2-1.json`",
		);
		expect(out).not.toContain("\n\n\n");
	});

	it("is unchanged without one", () => {
		expect(render()).toBe(render(""));
		expect(render().endsWith('"reason":"<only when failed>"}\n')).toBe(true);
	});
});

describe("the tickets whose scenarios the spine writes", () => {
	const template = readFileSync(
		join(import.meta.dirname, "../../skills/portia/worker-brief.md"),
		"utf8",
	);
	const theSpine = spine({ requirements: ["R1"] });
	const wave1 = child("ACME-2", { requirements: ["R2"] });
	const p = parent(
		[theSpine, wave1, child("ACME-3", { wave: 2, requirements: ["R3", "R4"] })],
		[
			{ id: "R1", text: "manifest" },
			{ id: "R2", text: "price" },
			{ id: "R3", text: "surcharge" },
			{ id: "R4", text: "history" },
		],
	);
	const issues = [
		{
			key: "ACME-1",
			summary: "Manifest a paid order",
			description: "The spine's own ticket.",
		},
		{
			key: "ACME-2",
			summary: "Price a delivery from the zone table",
			description:
				"| Red Mesa | A |\n\n`POST /deliveries/:id/price`\n\n```plan\nwave: 1\ntouches: src/pricing/**\n```",
		},
		{
			key: "ACME-3",
			summary: "Add the canyon surcharge",
			description: "Coconino county adds 12%.",
		},
	];
	const render = (c: (typeof p.children)[number]) =>
		fill(
			template,
			briefVars(
				p,
				c,
				env,
				"d",
				{},
				"",
				"",
				"",
				undefined,
				scenarioTickets(p, c, issues),
			),
		);

	it("gives the spine each later child's ticket, without its plan block", () => {
		const out = render(theSpine);
		expect(out).toContain("## The tickets whose scenarios you write");
		expect(out).toContain(
			"### ACME-2: Price a delivery from the zone table (R2)\n\n| Red Mesa | A |\n\n`POST /deliveries/:id/price`",
		);
		expect(out).toContain(
			"### ACME-3: Add the canyon surcharge (R3, R4)\n\nCoconino county adds 12%.",
		);
		expect(out).not.toContain("```plan");
		expect(out).not.toContain("The spine's own ticket.");
		expect(out).not.toContain("\n\n\n");
	});

	it("gives a wave child none of its siblings' tickets", () => {
		expect(scenarioTickets(p, wave1, issues)).toBe("");
		const out = render(wave1);
		expect(out).not.toContain("## The tickets whose scenarios you write");
		expect(out).not.toContain("Coconino");
		expect(out).not.toContain("Red Mesa");
		expect(out).toBe(fill(template, briefVars(p, wave1, env, "d")));
	});
});

describe("the hooks the spine scaffolds", () => {
	const hook = "src/surcharge/rules.ts";
	const s = spine({
		key: "ACME-401",
		touches: ["src/delivery/**", hook],
		hooks: { [hook]: "surchargeCents(county, priceCents) returns 0" },
	});
	const pricing = child("ACME-402", { touches: ["src/pricing/**"] });
	const surcharge = child("ACME-403", {
		wave: 2,
		touches: ["src/surcharge/**"],
	});
	const p = parent([s, pricing, surcharge]);

	it("tells the spine to create each hook module as a stub", () => {
		const v = briefVars(p, s, env, "d");
		expect(v.role).toContain("Create the hook module under Hooks as stubs.");
		expect(v.role).toContain(
			"a helper the tests share goes inside your touches",
		);
		expect(v.hooks).toContain(
			"Create every one as a stub module both sides can use now",
		);
		expect(v.hooks).toContain(
			"- src/surcharge/rules.ts: surchargeCents(county, priceCents) returns 0\n",
		);
	});
	it("tells the child whose touches hold it to fill it, and every other to call it", () => {
		expect(hooksSection(p, surcharge)).toContain(
			"- src/surcharge/rules.ts: surchargeCents(county, priceCents) returns 0 (yours to fill)",
		);
		expect(hooksSection(p, pricing)).toContain(
			"- src/surcharge/rules.ts: surchargeCents(county, priceCents) returns 0 (call it; never edit it)",
		);
	});
	it("is empty when the plan names no hook, and the template renders it after the touches", () => {
		expect(hooksSection(plan, child("ACME-2"))).toBe("");
		expect(briefVars(plan, spine(), env, "d").role).not.toContain(
			"hook module",
		);
		const template = readFileSync(
			join(__dirname, "../../skills/portia/worker-brief.md"),
			"utf8",
		);
		const brief = fill(template, {
			...briefVars(p, pricing, env, "d"),
		});
		expect(brief).toMatch(
			/park\.\n\n## Hooks\n\n.+\n\n- src\/surcharge\/rules\.ts.+\n\n(## If a spec you own cannot pass\n\n.+\n\n)?## Evidence/,
		);
	});
});

it("asks a child to check a spec claim, and to name a sibling instead when one has not landed", () => {
	const text = claimSection(new Map([["R4", "specs/orders/R4.accept.ts"]]));
	expect(text).toContain("quote the failing assertion and its output");
	expect(text).toContain("is no claim: park naming that child's key");
	expect(claimSection(new Map())).toBe("");
	const template = readFileSync(
		join(__dirname, "../../skills/portia/worker-brief.md"),
		"utf8",
	);
	expect(template).toMatch(/name that child's key in your question/);
});
