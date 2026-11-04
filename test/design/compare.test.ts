import { describe, expect, it } from "vitest";
import { compareProps } from "../../src/design/compare";
import { parseDesignRef } from "../../src/design/ref";
import type { ElementValues } from "../../src/design/types";
import { aggregate } from "../../src/design/verdict";

const el = (o: Partial<ElementValues> = {}): ElementValues => ({
	role: "button",
	name: "Link your child",
	color: "rgb(10, 20, 30)",
	background: "rgb(200, 255, 0)",
	fontFamily: "Inter",
	fontSize: 16,
	fontWeight: 600,
	lineHeight: 24,
	padding: [12, 16, 12, 16],
	radius: 12,
	width: 160,
	height: 48,
	...o,
});

describe("compareProps", () => {
	it("passes identical values and tolerates rounding", () => {
		expect(
			compareProps(
				[el()],
				[el({ fontSize: 16.3, color: "rgb(11, 21, 31)" })],
			).every((c) => c.verdict === "PASS"),
		).toBe(true);
	});
	it("fails a wrong colour and a small tap target", () => {
		const v = compareProps(
			[el()],
			[el({ color: "rgb(90, 20, 30)", height: 30 })],
		);
		expect(v.filter((c) => c.verdict === "FAIL").map((c) => c.prop)).toEqual([
			"color",
			"tap-target",
		]);
	});
	it("is UNCERTAIN about an element it cannot find (mock data may be absent)", () => {
		expect(compareProps([el()], [])).toEqual([
			{
				name: "Link your child",
				prop: "element",
				verdict: "UNCERTAIN",
				expected: "button 'Link your child'",
				actual: "not found",
			},
		]);
	});
});

describe("aggregate", () => {
	it("is NOT_RUN with no frames, FAIL on any fail, and lands UNCERTAIN", () => {
		expect(aggregate([], [], 0)).toMatchObject({
			verdict: "NOT_RUN",
			ok: false,
		});
		expect(
			aggregate(
				[
					{
						name: "a",
						prop: "color",
						verdict: "FAIL",
						expected: "",
						actual: "",
					},
				],
				[],
				1,
			),
		).toMatchObject({ verdict: "FAIL", ok: false });
		expect(
			aggregate([], [{ ratio: 0.05, verdict: "UNCERTAIN", note: "" }], 1),
		).toMatchObject({ verdict: "UNCERTAIN", ok: true });
	});
	const four = ["Link your child", "Ada Lovelace", "£25/hr", "Book"].map(
		(name) => el({ name }),
	);
	it("one missing element is UNCERTAIN and does not block", () => {
		const r = aggregate(compareProps(four, four.slice(0, 3)), [], 1);
		expect(r).toMatchObject({ verdict: "UNCERTAIN", ok: true });
		expect(r.summary).toContain("UNCERTAIN Book element");
	});
	it("an effectively empty page (under half the elements found) blocks", () => {
		const r = aggregate(compareProps(four, four.slice(0, 1)), [], 1);
		expect(r).toMatchObject({ verdict: "FAIL", ok: false });
		expect(r.summary).toContain(
			"FAIL page looks empty: found 1 of 4 designed elements",
		);
		expect(
			aggregate(compareProps(four, four.slice(0, 2)), [], 1),
		).toMatchObject({ verdict: "UNCERTAIN", ok: true });
	});
	it("caps a pixel FAIL at UNCERTAIN: advisory, never blocks", () => {
		const r = aggregate(
			[],
			[{ ratio: 0.4, verdict: "FAIL", note: "40.0% of pixels differ" }],
			1,
		);
		expect(r).toMatchObject({ verdict: "UNCERTAIN", ok: true });
		expect(r.summary).toContain("40.0% of pixels differ");
		expect(r.summary).toContain("advisory");
	});
});

it("parses a design line", () => {
	expect(
		parseDesignRef(
			"https://claude.ai/artifact/abc#p2 route=/discover persona=parent-no-child frames=cold-start-1440,cold-start-390",
		),
	).toEqual({
		link: "https://claude.ai/artifact/abc#p2",
		route: "/discover",
		persona: "parent-no-child",
		frames: ["cold-start-1440", "cold-start-390"],
	});
});
