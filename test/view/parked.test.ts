import { describe, expect, it } from "vitest";
import type { RunRow } from "../../src/core/types";
import { memoryFs } from "../../src/view/model/fs";
import { readHome } from "../../src/view/model/home";
import { frame, HOME } from "./helpers";

const row = (r: Omit<RunRow, "at"> & { at: string }) => JSON.stringify(r);
const at = (hms: string) => `2026-10-20T${hms}.000Z`;
const dispatched = (child: string, t: string): string =>
	row({
		at: at(t),
		child,
		attempt: 1,
		stage: "dispatched",
		model: { requested: "opus" },
	});
const parked = (child: string, t: string, message: string): string =>
	row({
		at: at(t),
		child,
		attempt: 1,
		stage: "result",
		status: "parked",
		tokens: 1000,
		data: { message },
	});
const LIMITED =
	"every account is at its usage limit or not logged in (work until 2026-10-20T15:30:00.000Z); the soonest frees at 2026-10-20T15:30:00.000Z. Run portia accounts clear <name> if one has reset sooner or been logged in";

/** ACME-700 waits on two questions and a usage limit; ACME-800 has a child working. */
function fs(extra: string[] = []) {
	const waiting = [
		dispatched("ACME-701", "10:00:00"),
		parked(
			"ACME-701",
			"12:00:00",
			"Which colour should the button be?\nRed matches the brand; blue matches the form.",
		),
		dispatched("ACME-702", "10:00:00"),
		parked("ACME-702", "13:30:00", "May I rename the export?"),
		dispatched("ACME-703", "10:00:00"),
		row({
			at: at("11:00:00"),
			child: "ACME-703",
			attempt: 1,
			stage: "result",
			status: "failed",
			data: { message: "usage-limit: You've hit your limit" },
		}),
		row({
			at: at("11:00:05"),
			child: "ACME-703",
			attempt: 0,
			stage: "decision",
			status: "park",
			data: { kind: "failure", answer: "park", by: "rule", why: LIMITED },
		}),
		...extra,
	];
	const working = [dispatched("ACME-801", "14:00:00")];
	return memoryFs({
		[`${HOME}/runs/ACME-700/runlog.jsonl`]: `${waiting.join("\n")}\n`,
		[`${HOME}/runs/ACME-800/runlog.jsonl`]: `${working.join("\n")}\n`,
	});
}
const NOW = Date.parse(at("14:02:31"));
const args = (...a: string[]) => [
	...a,
	"--now",
	at("14:02:31"),
	"--width",
	"120",
	"--height",
	"48",
	"--depth",
	"0",
];

describe("a child parked on a question for the person", () => {
	it("says on its Run page row that it waits on you, for how long, and the start of its question", () => {
		const text = frame(args("ACME-700"), { fs: fs(), machine: null });
		expect(text).toContain(
			"waiting on you · 2h02m  Which colour should the button be?",
		);
		expect(text).not.toContain("Red matches the brand");
		expect(text).toContain("waiting on you · 32m31s  May I rename the export?");
	});

	it("tells a park the run clears itself apart: every account at its limit, and when one frees", () => {
		const text = frame(args("ACME-700"), { fs: fs(), machine: null });
		expect(text).toContain("usage limit · frees 15:30");
		expect(text.match(/waiting on you · \d+h?\d+m/g)?.length).toBe(2);
	});

	it("shows the whole question at the top of its Child page, above the attempts", () => {
		const text = frame(args("ACME-700/ACME-701"), { fs: fs(), machine: null });
		const head = text.indexOf("waiting on you · 2h02m");
		const last = text.indexOf("Red matches the brand; blue matches the form.");
		expect(head).toBeGreaterThan(-1);
		expect(last).toBeGreaterThan(head);
		expect(last).toBeLessThan(text.search(/^ +evidence/m));
		expect(last).toBeLessThan(text.search(/^ +attempts/m));
	});

	it("counts the questions on Home and sorts that run first", () => {
		const home = readHome(fs(), HOME, NOW);
		expect(home.runs.map((r) => [r.key, r.group, r.questions])).toEqual([
			["ACME-700", "waiting", 2],
			["ACME-800", "session", 0],
		]);
		expect(home.needYou).toBe(1);
		const text = frame(args(), { fs: fs(), machine: null });
		expect(text).toContain("ACME-700  2 questions for you");
		expect(text.indexOf("ACME-700")).toBeLessThan(text.indexOf("ACME-800"));
	});

	it("says 1 question for you when one waits, and nothing once it is answered", () => {
		const one = readHome(
			fs([
				row({
					at: at("13:40:00"),
					child: "ACME-702",
					attempt: 0,
					stage: "decision",
					status: "answer",
					data: { kind: "parked", by: "eval", answer: "yes", why: "?" },
				}),
			]),
			HOME,
			NOW,
		);
		expect(one.runs[0]?.questions).toBe(1);
		expect(
			frame(args(), { fs: fs([dispatched("ACME-702", "13:50:00")]) }),
		).toContain("ACME-700  1 question for you");
		const none = readHome(
			fs([
				dispatched("ACME-701", "13:50:00"),
				dispatched("ACME-702", "13:50:00"),
			]),
			HOME,
			NOW,
		);
		expect(none.runs.map((r) => [r.key, r.group, r.questions])).toEqual([
			["ACME-800", "session", 0],
			["ACME-700", "session", 0],
		]);
	});
});
