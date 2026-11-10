import { describe, expect, it } from "vitest";
import type { ChildPlan, ParentPlan } from "../../src/core/types";
import {
	groupNeeds,
	headline,
	planPage,
	splitScenario,
} from "../../src/plan/page";

const child = (o: Partial<ChildPlan> & { key: string }): ChildPlan => ({
	summary: `${o.key} summary`,
	wave: 1,
	needs: [],
	touches: ["src/a/**"],
	requirements: [],
	evidence: "bun test",
	tier: "standard",
	acceptance: {},
	blockedBy: [],
	...o,
});
const plan: ParentPlan = {
	key: "ACME-1",
	summary: "Checkout <v2> & more",
	scope: "checkout",
	scenarios: [{ id: "F1", text: "Given a cart, Then it pays" }],
	children: [
		child({ key: "ACME-2", wave: 0, summary: "Spine" }),
		child({
			key: "ACME-3",
			needs: [{ key: "ACME-2", reason: "the contract" }],
			requirements: ["F1"],
		}),
		child({ key: "ACME-4" }),
		child({
			key: "ACME-5",
			wave: 2,
			needs: [
				{ key: "ACME-2", reason: "the contract" },
				{ key: "ACME-3", reason: "the card" },
			],
		}),
	],
};
const at = "2026-11-03T10:00:00Z";
const edgeCount = (html: string) => html.match(/class="edge"/g)?.length ?? 0;

describe("planPage", () => {
	it("names the page by its key, as a page with no skeleton of its own", () => {
		const html = planPage(plan, at);
		expect(html.startsWith("<title>ACME-1 wave plan</title>")).toBe(true);
		expect(html).not.toMatch(/<!doctype|<html|<body/i);
	});
	it("escapes what the tickets say", () => {
		const html = planPage(plan, at);
		expect(html).toContain("Checkout &lt;v2&gt; &amp; more");
		expect(html).not.toContain("<v2>");
	});
	it("draws one column per wave and every child in it, with its needs and scenarios", () => {
		const html = planPage(plan, at);
		for (const k of ["ACME-2", "ACME-3", "ACME-4", "ACME-5"])
			expect(html).toContain(`id="${k}"`);
		expect(html).toContain(">Spine<");
		expect(html).toContain(">Wave 2<");
		expect(html).toContain("the contract");
		expect(html).toContain("<dt>Given</dt><dd>a cart</dd>");
		expect(html).toContain("<dt>Then</dt><dd>it pays</dd>");
	});
	it("puts each scenario under the child that delivers it, and keeps an unowned one", () => {
		const html = planPage(
			{ ...plan, scenarios: [...plan.scenarios, { id: "F2", text: "Loose" }] },
			at,
		);
		const card = html.slice(html.indexOf('id="ACME-3"'));
		expect(card.slice(0, card.indexOf("</article>"))).toContain(">F1<");
		expect(html).toContain("Not yet owned");
	});
	it("draws a need another need implies once, and a later child with no need from the spine", () => {
		// 2→3, 2→4 (no need named: the spine), 3→5. 2→5 is implied through 3.
		expect(edgeCount(planPage(plan, at))).toBe(3);
	});
	it("never names the tool, and themes every colour through tokens", () => {
		const html = planPage(plan, at);
		expect(html.toLowerCase()).not.toContain("portia");
		expect(html).toContain("@media (prefers-color-scheme: dark)");
		expect(html).toContain(':root[data-theme="dark"]');
		const style = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? "";
		const rules = style.slice(style.lastIndexOf('[data-theme="dark"]'));
		expect(rules.slice(rules.indexOf("}"))).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});
});

describe("splitScenario", () => {
	it("reads Given, When and Then, splitting the Then at each and", () => {
		expect(
			splitScenario(
				"Given a lesson, When the tutor cancels it, Then the lesson shows cancelled, and the room ends",
			),
		).toEqual({
			given: "a lesson",
			when: "the tutor cancels it",
			outcomes: ["the lesson shows cancelled", "the room ends"],
		});
	});
	it("reads a scenario with no When, and leaves free text alone", () => {
		expect(
			splitScenario("Given a date, Then it answers")?.when,
		).toBeUndefined();
		expect(splitScenario("Free text")).toBeUndefined();
	});
	it("heads a scenario with its When, else its Given", () => {
		expect(headline("Given a, When b happens, Then c")).toBe("When b happens");
		expect(headline("Given a date, Then c")).toBe("Given a date");
	});
});

describe("groupNeeds", () => {
	it("draws needs that share a reason as one group", () => {
		expect(
			groupNeeds([
				{ key: "A", reason: "ships once landed" },
				{ key: "B", reason: "the contract" },
				{ key: "C", reason: "ships once landed" },
			]),
		).toEqual([
			{ keys: ["A", "C"], reason: "ships once landed" },
			{ keys: ["B"], reason: "the contract" },
		]);
	});
});
