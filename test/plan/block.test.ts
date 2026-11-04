import { describe, expect, it } from "vitest";
import {
	BlockError,
	extractBlock,
	PLAN_BLOCK,
	parseChild,
	parseParent,
	withPlanBlock,
} from "../../src/plan/block";
import { normaliseGlob } from "../../src/plan/paths";

const PKG = "packages/acme-web";
const top = ["packages", "apps", ".github", "scripts"];
const FENCE = "`".repeat(3);
const fence = (body: string) =>
	`Intro text.\n\n${FENCE}portia\n${body}\n${FENCE}\n`;
const raw = (body: string) => ({
	key: "ACME-2539",
	summary: "Setup actions",
	description: fence(body),
	blockedBy: ["ACME-9001"],
});

describe("normaliseGlob", () => {
	it("prefixes package-relative globs", () => {
		expect(normaliseGlob("./src/lib/onboarding/**", top, PKG)).toBe(
			"packages/acme-web/src/lib/onboarding/**",
		);
		expect(normaliseGlob("src/app/x.tsx", top, PKG)).toBe(
			"packages/acme-web/src/app/x.tsx",
		);
	});
	it("keeps repository-root globs", () => {
		expect(normaliseGlob("packages/db-acme/schema/**", top, PKG)).toBe(
			"packages/db-acme/schema/**",
		);
	});
	it("adds no ./ prefix when the package is the repository root", () => {
		expect(normaliseGlob("lib/new.ts", ["src"], ".")).toBe("lib/new.ts");
		expect(normaliseGlob("./lib/new.ts", ["src"], ".")).toBe("lib/new.ts");
	});
});

describe("parseChild", () => {
	it("parses every key", () => {
		const c = parseChild(
			raw(
				[
					"wave: 1",
					"needs: ACME-9001  # the spine: uses the ActionRegistry type",
					"touches: src/lib/onboarding/actions/setup*.ts, src/i18n/messages/**/onboarding.json",
					"requirements: F1, F2",
					"evidence: bun run --filter acme-web test -- src/lib/onboarding/actions",
					"tier: standard",
					"size: s",
					"design: https://claude.ai/artifact/abc route=/discover persona=parent-no-child",
				].join("\n"),
			),
			top,
			PKG,
		);
		expect(c.wave).toBe(1);
		expect(c.needs).toEqual([
			{ key: "ACME-9001", reason: "the spine: uses the ActionRegistry type" },
		]);
		expect(c.touches).toEqual([
			"packages/acme-web/src/lib/onboarding/actions/setup*.ts",
			"packages/acme-web/src/i18n/messages/**/onboarding.json",
		]);
		expect(c.requirements).toEqual(["F1", "F2"]);
		expect(c.size).toBe("S");
		expect(c.design).toContain("route=/discover");
		expect(c.blockedBy).toEqual(["ACME-9001"]);
	});
	it("reads acceptance lines on a spine", () => {
		const c = parseChild(
			raw(
				"wave: 0\nacceptance: F1 = e2e/onboarding/checklist.e2e.ts\nacceptance: F2 = e2e/onboarding/checklist.e2e.ts",
			),
			top,
			PKG,
		);
		expect(c.acceptance).toEqual({
			F1: "packages/acme-web/e2e/onboarding/checklist.e2e.ts",
			F2: "packages/acme-web/e2e/onboarding/checklist.e2e.ts",
		});
	});
	it("reads hook lines with what each stub holds, and refuses two files on one line", () => {
		const c = parseChild(
			raw(
				"wave: 0\nhook: src/surcharge/rules.ts # surchargeCents(county, priceCents) returns 0\nhook: src/launch/notify.ts",
			),
			top,
			PKG,
		);
		expect(c.hooks).toEqual({
			"packages/acme-web/src/surcharge/rules.ts":
				"surchargeCents(county, priceCents) returns 0",
			"packages/acme-web/src/launch/notify.ts": "",
		});
		expect(parseChild(raw("wave: 0"), top, PKG).hooks).toBeUndefined();
		expect(() =>
			parseChild(raw("wave: 0\nhook: src/a.ts, src/b.ts"), top, PKG),
		).toThrow(/a hook line names one file/);
	});
	it("reads a lane, leaves it unset when absent, and rejects an unknown one", () => {
		expect(parseChild(raw("wave: 1\nlane: light"), top, PKG).lane).toBe(
			"light",
		);
		expect(parseChild(raw("wave: 1"), top, PKG).lane).toBeUndefined();
		expect(() => parseChild(raw("wave: 1\nlane: fast"), top, PKG)).toThrow(
			/lane must be light or full/,
		);
	});
	it("rejects an unknown key by name", () => {
		expect(() =>
			parseChild(raw("wave: 1\ntuoches: src/x.ts"), top, PKG),
		).toThrow(/unknown key 'tuoches'/);
	});
	it("rejects a missing block and a missing wave", () => {
		expect(() =>
			parseChild({ ...raw(""), description: "no block" }, top, PKG),
		).toThrow(BlockError);
		expect(() => parseChild(raw("touches: src/x.ts"), top, PKG)).toThrow(
			/missing wave/,
		);
	});
	it("uses the last block when there are two", () => {
		expect(extractBlock(fence("wave: 1") + fence("wave: 2"))).toBe("wave: 2");
	});
});

describe("parseParent", () => {
	it("reads scope and scenarios", () => {
		const p = parseParent({
			key: "ACME-9000",
			summary: "Cold start",
			blockedBy: [],
			description: fence(
				"scope: onboarding\nscenario: F1 = Given a parent, When they open the dashboard, Then content\nscenario: F2 = Given two steps, Then one ask",
			),
		});
		expect(p.scope).toBe("onboarding");
		expect(p.scenarios.map((s) => s.id)).toEqual(["F1", "F2"]);
		expect(p.scenarios[0]?.text).toContain("open the dashboard");
	});
});

describe("the plan fence", () => {
	const text = (lang: string) =>
		`Intro\n\n${FENCE}${lang}\nwave: 1\n${FENCE}\n\nOutro`;
	it.each(["plan", "portia"])("reads a ```%s block", (lang) => {
		expect(extractBlock(text(lang))).toBe("wave: 1");
	});
	it.each(["plan", "portia"])("strips a ```%s block from a brief", (lang) => {
		expect(text(lang).replace(PLAN_BLOCK, "").trim()).not.toContain("wave");
	});
	it("ignores other languages", () => {
		expect(extractBlock(text("ts"))).toBeNull();
	});
});

describe("withPlanBlock", () => {
	const F = "`".repeat(3);
	it("appends a block to text with none", () => {
		expect(withPlanBlock("Intro.", "wave: 1")).toBe(
			`Intro.\n\n${F}plan\nwave: 1\n${F}\n`,
		);
		expect(withPlanBlock("", "wave: 1")).toBe(`${F}plan\nwave: 1\n${F}\n`);
	});
	it("replaces plan and portia blocks, keeping the rest, block last", () => {
		const text = `A\n\n${F}portia\nwave: 0\n${F}\n\nB\n\n${F}plan\nwave: 1\n${F}\n\nC\n`;
		const out = withPlanBlock(text, "wave: 2");
		expect(out).toBe(`A\n\n\nB\n\n\nC\n\n${F}plan\nwave: 2\n${F}\n`);
		expect(withPlanBlock(out, "wave: 2")).toBe(out);
	});
	it("leaves other fenced blocks alone", () => {
		const out = withPlanBlock(`${F}ts\nx\n${F}\n`, "wave: 1");
		expect(out).toContain(`${F}ts\nx\n${F}`);
	});
});

describe("a needs line names one key", () => {
	it.each([
		"needs: ACME-1 # contract, ACME-2 # endpoint",
		"needs: ACME-1, ACME-2",
		"needs: ACME-1 ACME-2 # both",
	])("'%s' is a parse error naming the line", (line) => {
		expect(() =>
			parseChild(raw(`wave: 1\n${line}\nevidence: x`), top, PKG),
		).toThrow(
			new BlockError(
				`ACME-2539: a needs line names one key, one line per need: "${line}"`,
			),
		);
	});
	it("one key per line still parses, with its reason", () => {
		const c = parseChild(
			raw(
				"wave: 1\nneeds: acme-1 # contract\nneeds: ACME-2\nneeds:\nevidence: x",
			),
			top,
			PKG,
		);
		expect(c.needs).toEqual([
			{ key: "ACME-1", reason: "contract" },
			{ key: "ACME-2", reason: "" },
		]);
	});
});
