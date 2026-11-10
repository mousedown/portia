import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRow, readRows } from "../../src/core/runlog";
import type { ViewFs } from "../../src/view/model/fs";
import { readHome } from "../../src/view/model/home";
import { readRun } from "../../src/view/model/run";
import { answerPark } from "../../src/view/runtime/answer";
import { archiveRun } from "../../src/view/runtime/archive";
import { fixtureFs, HOME, NOW } from "./helpers";

const SRC = join(import.meta.dirname, "../../src/view");
const walk = (p: string): string[] =>
	statSync(p).isDirectory()
		? readdirSync(p).flatMap((n) => walk(join(p, n)))
		: [p];

const IMPORTS = [
	/\bappendRow\b/,
	/\brunDir\b/,
	/from "[./]*\/plan\//,
	/from "[./]*\/land\//,
	/from "[./]*\/decide\//,
	/ledger\/publish/,
	/core\/exec/,
];
const CALLS = [
	/writeFileSync/,
	/appendFileSync/,
	/mkdirSync/,
	/renameSync/,
	/rmSync/,
	/unlinkSync/,
	/\.writeFile\(/,
];

describe("portia view is read-only", () => {
	it("imports nothing that writes, and calls nothing that writes", () => {
		const hits = walk(SRC).flatMap((f) => {
			const rel = relative(SRC, f);
			const text = readFileSync(f, "utf8");
			// tty.ts writes to the terminal and nowhere else; archive.ts moves a finished
			// run's directory aside, and may make the directory it goes into, nothing more.
			const banned =
				rel === join("runtime", "tty.ts")
					? IMPORTS
					: rel === join("runtime", "answer.ts")
						? IMPORTS
						: rel === join("runtime", "archive.ts")
							? [
									...IMPORTS,
									...CALLS.filter(
										(re) => !/mkdirSync|renameSync/.test(re.source),
									),
								]
							: [...IMPORTS, ...CALLS];
			return banned.filter((re) => re.test(text)).map((re) => `${rel} ${re}`);
		});
		expect(hits).toEqual([]);
	});
	it("only lists, reads, stats and checks: any other call throws", () => {
		const real = fixtureFs();
		// `alive` asks whether a worker's pid answers signal 0, which sends nothing;
		// `identity` returns what ps said of it, and `prTitle` what gh said of a PR, both asked
		// off the render thread.
		const allowed = new Set([
			"list",
			"read",
			"stat",
			"readFrom",
			"exists",
			"alive",
			"identity",
			"prTitle",
		]);
		const strict = new Proxy(real, {
			get(target, prop: string) {
				if (!allowed.has(prop)) throw new Error(`the view called fs.${prop}`);
				return target[prop as keyof ViewFs];
			},
		});
		expect(() => readHome(strict, HOME, NOW)).not.toThrow();
		expect(() => readRun(strict, HOME, "ACME-500", NOW)).not.toThrow();
	});
	it("archives only by moving a run into runs/.archive, keeping an earlier copy", () => {
		const runs = join(mkdtempSync(join(tmpdir(), "portia-archive-")), "runs");
		const make = () => {
			mkdirSync(join(runs, "ACME-1"), { recursive: true });
			writeFileSync(join(runs, "ACME-1", "runlog.jsonl"), "{}\n");
		};
		make();
		const first = archiveRun(runs, "ACME-1");
		expect(first).toBe(join(runs, ".archive", "ACME-1"));
		expect(existsSync(join(runs, "ACME-1"))).toBe(false);
		expect(readFileSync(join(first, "runlog.jsonl"), "utf8")).toBe("{}\n");
		make();
		const second = archiveRun(runs, "ACME-1");
		expect(second).toMatch(/\.archive\/ACME-1-\d+$/);
		expect(existsSync(first)).toBe(true);
		expect(() => archiveRun(runs, "../elsewhere")).toThrow(/not a run key/);
	});
	it("answer.ts is the only view file that imports core/park-answer", () => {
		const importers = walk(SRC)
			.filter((f) => /core\/park-answer/.test(readFileSync(f, "utf8")))
			.map((f) => relative(SRC, f));
		expect(importers).toEqual([join("runtime", "answer.ts")]);
	});
	it("answers a question once: a second send to it is refused and adds no row", () => {
		const runs = join(mkdtempSync(join(tmpdir(), "portia-answer-")), "runs");
		const dir = join(runs, "ACME-1");
		mkdirSync(dir, { recursive: true });
		const at = "2026-01-01T00:00:00.000Z";
		appendRow(dir, {
			at,
			child: "ACME-2",
			attempt: 1,
			stage: "result",
			status: "parked",
			data: { message: "which way?" },
		});
		answerPark(runs, "ACME-1", "ACME-2", at, "left");
		expect(() => answerPark(runs, "ACME-1", "ACME-2", at, "right")).toThrow(
			/no longer waiting/,
		);
		expect(
			readRows(dir).rows.filter((r) => r.status === "answer"),
		).toHaveLength(1);
		expect(() => answerPark(runs, "../x", "ACME-2", at, "y")).toThrow(
			/not a run key/,
		);
	});
});
