import { describe, expect, it } from "vitest";
import { readHome } from "../../../src/view/model/home";
import {
	linked,
	makeCtx,
	tabBar,
	webOf,
} from "../../../src/view/render/common";
import { type Ink, osc8, sgr } from "../../../src/view/render/ink";
import { initialState } from "../../../src/view/runtime/state";
import { fixtureFs, frame, HOME, NOW } from "../helpers";

const ink = (o: Partial<Ink> = {}): Ink => ({
	depth: 24,
	theme: "dark",
	unicode: true,
	motion: false,
	...o,
});
const home = readHome(fixtureFs(), HOME, NOW);
const REPO = "https://github.com/acme/shop";
const ctxOf = (repos?: Record<string, string>, jira?: string) =>
	makeCtx(
		initialState(),
		{ home, repos, jira },
		ink(),
		{ cols: 120, rows: 36 },
		{ now: NOW },
	);

describe("links", () => {
	it("wraps a linked span in OSC 8 only when the ink allows links", () => {
		const line = [
			{ text: "see " },
			...linked([{ text: "#42", role: "accent" as const }], `${REPO}/pull/42`),
			{ text: " now" },
		];
		const on = sgr(line, ink({ links: true }));
		expect(on).toContain(`${osc8(`${REPO}/pull/42`)}\x1b[0;`);
		expect(on).toContain(`#42${osc8()}`);
		expect(sgr(line, ink())).not.toContain("\x1b]8");
		expect(sgr(line, ink({ depth: 0, links: true }))).toBe(
			`see ${osc8(`${REPO}/pull/42`)}#42${osc8()} now`,
		);
		expect(sgr(line, ink({ depth: 0 }))).toBe("see #42 now");
	});
	it("never links the padding around a key", () => {
		const spans = linked([{ text: "ACME-1" }, { text: "   " }], REPO);
		expect(spans[0]?.link).toBe(REPO);
		expect(spans[1]?.link).toBeUndefined();
	});
	it("builds PR, branch and issue URLs from the run's repository and the Jira site", () => {
		const web = webOf(
			ctxOf({ "ACME-500": REPO }, "https://acme.atlassian.net/"),
			"ACME-500",
		);
		expect(web.pr(7)).toBe(`${REPO}/pull/7`);
		expect(web.branch("epic/ACME-500")).toBe(`${REPO}/tree/epic/ACME-500`);
		expect(web.issue("GH-12")).toBe(`${REPO}/issues/12`);
		expect(web.issue("ACME-505")).toBe(
			"https://acme.atlassian.net/browse/ACME-505",
		);
	});
	it("links nothing it cannot place", () => {
		const web = webOf(ctxOf(), "ACME-500");
		expect(web.pr(7)).toBeUndefined();
		expect(web.issue("ACME-505")).toBeUndefined();
		// A repository that is not on GitHub has no pull or tree pages to link.
		const gitlab = webOf(
			ctxOf({ "ACME-500": "https://gitlab.com/acme/shop" }),
			"ACME-500",
		);
		expect(gitlab.pr(7)).toBeUndefined();
	});
	it("writes no link escapes into frames, whatever the depth", () => {
		for (const depth of ["0", "16", "256", "24"])
			expect(
				frame([
					"ACME-500",
					"--width",
					"120",
					"--height",
					"36",
					"--depth",
					depth,
				]),
			).not.toContain("\x1b]8");
	});
});

describe("the tab bar", () => {
	const text = (screen: string, matrix = false) =>
		tabBar({
			...ctxOf(),
			state: { ...initialState(), screen, matrix } as never,
		})
			.map((s) => s.text)
			.join("");
	it("numbers the pages beside the one shown, and marks the one shown in reverse video", () => {
		expect(text("home")).toBe(" 1 runs    2 activity    3 machine ");
		expect(text("machine")).toBe(" 1 runs    2 activity    3 machine ");
		expect(text("run")).toBe(" 1 children    2 gate matrix ");
		expect(text("run", true)).toBe(" 1 children    2 gate matrix ");
		expect(text("worker")).toBe(" 1 child    2 worker ");
		const on = (screen: string) =>
			tabBar({ ...ctxOf(), state: { ...initialState(), screen } as never })
				.filter((x) => x.reverse)
				.map((x) => x.text);
		expect(on("activity")).toEqual([" 2 activity "]);
		expect(on("worker")).toEqual([" 2 worker "]);
	});
	it("sits under the two-row logo on the inner pages, and gives way to one line when narrow", () => {
		const wide = frame(["ACME-500", "--width", "120", "--height", "36"]).split(
			"\n",
		);
		expect(wide[0]).toMatch(/^ {2}◆ {2}█▀█ █▀█ █▀█ ▀█▀ █ ▄▀█ {3}ACME-500 /);
		expect(wide[1]).toMatch(
			/^ ▀█▀ █▀▀ █▄█ █▀▄ {2}█ {2}█ █▀█ {4}1 children {4}2 gate matrix$/,
		);
		const narrow = frame(["ACME-500", "--width", "72", "--height", "30"]);
		expect(narrow.split("\n")[0]).toMatch(/^ ◆ PORTIA › ACME-500 /);
		const ascii = frame([
			"ACME-500",
			"--width",
			"120",
			"--height",
			"36",
			"--ascii",
		]);
		expect(ascii.split("\n")[0]).toMatch(/^ o P O R T I A {2}> {2}ACME-500 /);
	});
});
