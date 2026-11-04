import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRepeat } from "../src/run";

describe("nextRepeat", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "eval-repeat-"));

	it("is 1 for a missing or empty results folder", () => {
		expect(nextRepeat(join(tmpdir(), "eval-repeat-none", "x"))).toBe(1);
		expect(nextRepeat(dir())).toBe(1);
	});

	it("numbers after the last scored result", () => {
		const d = dir();
		for (const n of [1, 2]) {
			mkdirSync(join(d, String(n)));
			writeFileSync(join(d, `${n}.json`), "{}");
		}
		expect(nextRepeat(d)).toBe(3);
	});

	it("numbers past the folder a run stopped before scoring left behind", () => {
		const d = dir();
		mkdirSync(join(d, "1"));
		writeFileSync(join(d, "1.json"), "{}");
		mkdirSync(join(d, "2", "clone"), { recursive: true });
		expect(nextRepeat(d)).toBe(3);
	});

	it("ignores anything that is not a repeat", () => {
		const d = dir();
		writeFileSync(join(d, "1.json"), "{}");
		mkdirSync(join(d, "notes"));
		writeFileSync(join(d, "7.json.bak"), "");
		expect(nextRepeat(d)).toBe(2);
	});
});
