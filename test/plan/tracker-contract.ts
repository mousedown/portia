import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PortiaProblem } from "../../src/core/exit";
import { extractBlock, PLAN_BLOCK } from "../../src/plan/block";
import type { Tracker } from "../../src/plan/tracker";

/** The graph a subject is seeded with; the contract asserts against it. */
export interface ContractGraph {
	parent: string;
	/** child key -> keys it is blocked by */
	children: Record<string, string[]>;
	missingKey: string;
	/** A key that comment/transition may be written to. */
	writeKey: string;
	/** [blocker, blocked]: two issues with no link between them yet. */
	linkPair: [string, string];
}

const FENCES = /```(?:plan|portia)[ \t]*\n/g;
const withoutBlocks = (d: string) => d.replace(PLAN_BLOCK, "").trim();

export interface ContractSubject {
	tracker: Tracker;
	/** How many write operations the backend has seen. */
	writes: () => number;
}

export function trackerContract(
	name: string,
	graph: ContractGraph,
	make: () => ContractSubject,
): void {
	describe(`Tracker contract: ${name}`, () => {
		it("round-trips a parent and its children", async () => {
			const { tracker } = make();
			const parent = await tracker.issue(graph.parent);
			expect(parent.key).toBe(graph.parent);
			expect(typeof parent.summary).toBe("string");
			expect(typeof parent.description).toBe("string");
			const kids = await tracker.children(graph.parent);
			expect(kids.map((k) => k.key)).toEqual(Object.keys(graph.children));
			for (const k of kids) expect(tracker.keyPattern.test(k.key)).toBe(true);
		});
		it("lists only blockers in blockedBy, not the issues it blocks", async () => {
			const { tracker } = make();
			for (const [key, blockers] of Object.entries(graph.children)) {
				const i = await tracker.issue(key);
				expect([...i.blockedBy].sort()).toEqual([...blockers].sort());
			}
		});
		it("raises PortiaProblem for a missing key", async () => {
			const { tracker } = make();
			await expect(tracker.issue(graph.missingKey)).rejects.toBeInstanceOf(
				PortiaProblem,
			);
		});
		it("records writes outside dry run (positive control)", async () => {
			const saved = process.env.PORTIA_DRY_RUN;
			delete process.env.PORTIA_DRY_RUN;
			try {
				const s = make();
				await s.tracker.comment(graph.writeKey, "hello");
				expect(s.writes()).toBe(1);
				await s.tracker.transition(graph.writeKey, "In Development");
				expect(s.writes()).toBe(2);
			} finally {
				if (saved !== undefined) process.env.PORTIA_DRY_RUN = saved;
			}
		});
		describe("plan blocks and links (outside dry run)", () => {
			let saved: string | undefined;
			beforeEach(() => {
				saved = process.env.PORTIA_DRY_RUN;
				delete process.env.PORTIA_DRY_RUN;
			});
			afterEach(() => {
				if (saved !== undefined) process.env.PORTIA_DRY_RUN = saved;
			});
			it("setPlanBlock twice leaves one block at the end and the rest intact", async () => {
				const s = make();
				const before = (await s.tracker.issue(graph.writeKey)).description;
				await s.tracker.setPlanBlock(graph.writeKey, "wave: 3\nsize: M");
				expect(s.writes()).toBeGreaterThan(0);
				await s.tracker.setPlanBlock(graph.writeKey, "wave: 4\nsize: L");
				const after = (await s.tracker.issue(graph.writeKey)).description;
				expect(after.match(FENCES)).toHaveLength(1);
				expect(extractBlock(after)).toBe("wave: 4\nsize: L");
				expect(after.trimEnd().endsWith("```")).toBe(true);
				expect(withoutBlocks(after)).toBe(withoutBlocks(before));
			});
			it("link twice creates one link", async () => {
				const s = make();
				const [blocker, blocked] = graph.linkPair;
				const w0 = s.writes();
				await s.tracker.link(blocker, blocked);
				expect(s.writes()).toBe(w0 + 1);
				await s.tracker.link(blocker, blocked);
				expect(s.writes()).toBe(w0 + 1);
				const i = await s.tracker.issue(blocked);
				expect(i.blockedBy.filter((k) => k === blocker)).toHaveLength(1);
			});
		});
		describe("under PORTIA_DRY_RUN=1", () => {
			let saved: string | undefined;
			beforeEach(() => {
				saved = process.env.PORTIA_DRY_RUN;
				process.env.PORTIA_DRY_RUN = "1";
			});
			afterEach(() => {
				if (saved === undefined) delete process.env.PORTIA_DRY_RUN;
				else process.env.PORTIA_DRY_RUN = saved;
			});
			it("comment and transition write nothing", async () => {
				const s = make();
				await s.tracker.comment(graph.writeKey, "hello");
				await s.tracker.transition(graph.writeKey, "In Development");
				expect(s.writes()).toBe(0);
			});
			it("setPlanBlock and link write nothing", async () => {
				const s = make();
				const [blocker, blocked] = graph.linkPair;
				const before = await s.tracker.issue(graph.writeKey);
				await s.tracker.setPlanBlock(graph.writeKey, "wave: 3");
				await s.tracker.link(blocker, blocked);
				expect(s.writes()).toBe(0);
				expect(await s.tracker.issue(graph.writeKey)).toEqual(before);
				expect((await s.tracker.issue(blocked)).blockedBy).not.toContain(
					blocker,
				);
			});
		});
	});
}
