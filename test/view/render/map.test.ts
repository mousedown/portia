import { describe, expect, it } from "vitest";
import { readHome } from "../../../src/view/model/home";
import type { ChildView, RunView } from "../../../src/view/model/types";
import { makeCtx } from "../../../src/view/render/common";
import type { Ink } from "../../../src/view/render/ink";
import { compactMap, runMap } from "../../../src/view/render/map";
import { runScreen } from "../../../src/view/render/screens/run";
import type { Line } from "../../../src/view/render/text";
import { initialState } from "../../../src/view/runtime/state";
import { fixtureFs, frame, HOME, NOW } from "../helpers";

const ink = (unicode = true): Ink => ({
	depth: 0,
	theme: "dark",
	unicode,
	motion: false,
});
const home = readHome(fixtureFs(), HOME, NOW);
const base = home.runs.find((r) => r.key === "ACME-500") as RunView;
const ctxOf = (cols = 120, rows = 36, unicode = true) =>
	makeCtx(initialState(), { home }, ink(unicode), { cols, rows }, { now: NOW });
const text = (l: Line) => l.map((s) => s.text).join("");
const tmpl = base.children[0] as ChildView;
const kids = (spec: [number, number, ChildView["state"]?][]): ChildView[] =>
	spec.flatMap(([wave, n, state], w) =>
		Array.from({ length: n }, (_, i) => ({
			...tmpl,
			key: `GH-${w}${i}`,
			wave,
			state: state ?? "pending",
			needs: [],
		})),
	);
const run = (children: ChildView[]): RunView => ({ ...base, children });
/** A large epic's shape: too tall for the full map. */
const tall = run(
	kids([
		[0, 1, "landed"],
		[1, 6],
		[2, 10],
		[3, 2],
	]),
);

describe("compactMap", () => {
	it("draws each wave with its counts", () => {
		const lines = compactMap(ctxOf(), tall, 110).map(text);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^ spine ✓ ?1 ─+▶ wave 1 · ?6 ─+▶ wave 2 · ?10 ─+▶ wave 3 · ?2$/,
		);
	});
	it("counts each state of a wave apart", () => {
		const mixed = run(
			kids([
				[0, 1, "landed"],
				[1, 2, "landed"],
				[1, 1, "failed"],
				[1, 3],
			]),
		);
		const line = compactMap(ctxOf(), mixed, 110).map(text).join("");
		expect(line).toMatch(/wave 1 .*2/);
		expect(line).toMatch(/✗ ?1/);
		expect(line).toMatch(/· ?3/);
	});
	it("wraps at an arrow rather than running off a narrow terminal", () => {
		const lines = compactMap(ctxOf(40, 34), tall, 30);
		expect(lines.length).toBeGreaterThan(1);
		for (const l of lines) expect(text(l).length).toBeLessThanOrEqual(30);
	});
	it("writes ASCII arrows in an ASCII terminal", () => {
		const line = compactMap(ctxOf(120, 36, false), tall, 110)
			.map(text)
			.join("");
		expect(line).toContain("-->");
		expect(line).not.toContain("▶");
	});
	it("has nothing to draw for one wave", () => {
		expect(compactMap(ctxOf(), run(kids([[1, 3]])), 110)).toEqual([]);
	});
});

describe("the Run page's shape", () => {
	const page = (r: RunView, cols = 120, rows = 34) =>
		runScreen(ctxOf(cols, rows), r).map(text).join("\n");
	it("falls back to the compact map only when the tree leaves the list too little", () => {
		expect(page(tall, 120, 24)).toMatch(
			/spine .*▶ wave 1 .*▶ wave 2 .*▶ wave 3/,
		);
	});
	it("draws the whole tree for a run with many children when there is room", () => {
		const out = page(tall, 120, 44);
		expect(out).not.toMatch(/spine .*▶ wave 1/);
		for (const k of ["00", "10", "15", "20", "29", "30", "31"])
			expect(out).toMatch(new RegExp(`(^|[^0-9])${k}( |$)`, "m"));
		expect(runMap(ctxOf(), tall, 110).length).toBeGreaterThan(8);
	});
	it("gives up the tree when the terminal is too narrow, as ever", () => {
		expect(runMap(ctxOf(), tall, 20)).toEqual([]);
	});
	it("keeps the full map when it fits", () => {
		const small = run(
			kids([
				[0, 1],
				[1, 2],
			]),
		);
		expect(runMap(ctxOf(), small, 110).length).toBeGreaterThan(0);
		expect(page(small)).not.toMatch(/spine . ?\d+ ─/);
	});
});

describe("the plan row", () => {
	const url =
		"https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-123456789abc";
	const dir = `${HOME}/runs/ACME-500/plan-link.json`;
	it("shows a recorded link on the Run page, as a link", () => {
		const fs = fixtureFs({ [dir]: JSON.stringify({ url }) });
		const r = readHome(fs, HOME, NOW).runs.find((x) => x.key === "ACME-500");
		expect(r?.planUrl).toBe(url);
		const lines = runScreen(ctxOf(), r as RunView);
		const row = lines.find((l) => /^\s*plan\s/.test(text(l)));
		expect(row && text(row)).toContain(url);
		expect(row?.some((s) => s.link === url)).toBe(true);
	});
	it("shows no row without one, and ignores a file that is not an artifact link", () => {
		expect(frame(["ACME-500", "--width", "120", "--height", "36"])).not.toMatch(
			/^\s*plan\s/m,
		);
		const bad = "https://evil.example/\x1b]8;;x";
		const fs = fixtureFs({ [dir]: JSON.stringify({ url: bad }) });
		const r = readHome(fs, HOME, NOW).runs.find((x) => x.key === "ACME-500");
		expect(r?.planUrl).toBeUndefined();
	});
});
