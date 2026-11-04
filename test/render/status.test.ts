import { describe, expect, it } from "vitest";
import { renderStatus, type StatusView, toView } from "../../src/render/status";
import { detect, plain, widthOf } from "../../src/render/style";
import { child, parent, spine } from "../helpers/plan";

const long =
	"The dashboard renders the next set-up step in the checklist for a member with no team yet";
const view: StatusView = {
	parent: {
		key: "ACME-9000",
		summary: "Onboarding checklist: the one next step on the dashboard",
	},
	waves: [
		{
			wave: 0,
			children: [{ key: "ACME-9001", summary: "Spine", state: "landed" }],
		},
		{
			wave: 1,
			children: [
				{ key: "ACME-9002", summary: "Set-up dimension", state: "running" },
				{ key: "ACME-9003", summary: long, state: "parked" },
			],
		},
	],
	edges: [
		{
			from: "ACME-9001",
			to: "ACME-9003",
			reason: "uses the MemberState and StepRegistry types from the spine",
		},
	],
};

const slots = {
	cap: 3,
	memory: 2,
	used: 1,
	peers: 1,
	available: 0,
	running: ["ACME-9002"],
};

describe("renderStatus", () => {
	it("never emits a line wider than the style, at any width, coloured or not", () => {
		for (let width = 56; width <= 120; width++) {
			for (const colour of [true, false]) {
				for (const unicode of [true, false]) {
					for (const line of renderStatus(
						{ ...view, slots },
						{
							colour,
							unicode,
							width,
						},
					).split("\n")) {
						expect(
							widthOf(line),
							`width ${width}: "${line}"`,
						).toBeLessThanOrEqual(width);
					}
				}
			}
		}
	});
	it("renders a readable plain view", () => {
		const out = renderStatus(view, plain(72));
		expect(out).toContain("wave 0 · 1/1 landed");
		expect(out).toContain("   ✓ ACME-9001 Spine");
		expect(out).toContain("ACME-9001 → ACME-9003");
	});
	it("falls back to ASCII glyphs", () => {
		const out = renderStatus(view, { ...plain(72), unicode: false });
		expect(out).toContain("   + ACME-9001");
		expect(out).toContain("ACME-9001 -> ACME-9003");
	});
	it("shows worker slots only when there are some", () => {
		expect(renderStatus(view, plain(72))).not.toContain("slots");
		expect(renderStatus({ ...view, slots }, plain(120))).toContain(
			"slots  0 of 3 free · 1 running here · 1 in other runs · memory fits 2",
		);
	});
});

describe("lanes", () => {
	it("shows each child's lane after its state, only when the view has lanes", () => {
		const laned: StatusView = {
			...view,
			waves: view.waves.map((w) => ({
				...w,
				children: w.children.map((c) => ({
					...c,
					lane: c.key === "ACME-9002" ? ("light" as const) : ("full" as const),
				})),
			})),
		};
		for (let width = 56; width <= 120; width++)
			for (const line of renderStatus(laned, plain(width)).split("\n"))
				expect(widthOf(line)).toBeLessThanOrEqual(width);
		const out = renderStatus(laned, plain(100));
		expect(out).toMatch(/ACME-9002 .* running {2}light$/m);
		expect(out).toMatch(/ACME-9001 .* landed {3}full$/m);
		expect(renderStatus(view, plain(100))).not.toMatch(/light|full$/m);
	});
	it("toView carries the lanes it is given, and none by default", () => {
		const p = parent([spine(), child("ACME-2")]);
		const states = new Map();
		const lanes = (v: StatusView) =>
			v.waves.flatMap((w) => w.children.map((c) => c.lane));
		expect(lanes(toView(p, states))).toEqual([undefined, undefined]);
		expect(
			lanes(
				toView(p, states, {
					lanes: new Map([
						["ACME-1", "full" as const],
						["ACME-2", "light" as const],
					]),
				}),
			),
		).toEqual(["full", "light"]);
	});
});

describe("detect", () => {
	it("honours NO_COLOR and clamps the width", () => {
		expect(detect({ NO_COLOR: "1", COLUMNS: "300" }, true)).toEqual({
			colour: false,
			unicode: true,
			width: 120,
		});
		expect(detect({ COLUMNS: "20" }, true).width).toBe(56);
		expect(detect({}, false).colour).toBe(false);
	});
});
