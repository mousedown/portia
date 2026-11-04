import { describe, expect, it } from "vitest";
import { parseViewArgs, stateFor } from "../../../src/view/args";
import { memoryFs } from "../../../src/view/model/fs";
import { readHome } from "../../../src/view/model/home";
import { render } from "../../../src/view/render";
import { detectInk } from "../../../src/view/render/ink";
import { decode } from "../../../src/view/runtime/keys";
import {
	flashesFor,
	nextDelay,
	signatures,
} from "../../../src/view/runtime/loop";
import { normaliseRemote, osc52 } from "../../../src/view/runtime/tty";
import { advance, readTail } from "../../../src/view/runtime/watch";
import { diffFrame } from "../../../src/view/runtime/writer";
import { fixtureFs, HOME, NOW } from "../helpers";

describe("decode", () => {
	it("reads printable text, controls and CSI keys", () => {
		const { keys, rest } = decode(
			"jé\r\x7f\t\x1b[Z\x1b[A\x1b[B\x1b[5~\x1b[6~\x1b[H\x1b[4~\x04\x15\x03\x1a",
		);
		expect(keys.map((k) => k.name + (k.ch ?? ""))).toEqual([
			"charj",
			"charé",
			"enter",
			"backspace",
			"tab",
			"stab",
			"up",
			"down",
			"pgup",
			"pgdn",
			"home",
			"end",
			"^d",
			"^u",
			"^c",
			"^z",
		]);
		expect(rest).toBe("");
	});
	it("holds a lone ESC or a cut sequence for the caller's 25 ms timer", () => {
		expect(decode("\x1b")).toEqual({ keys: [], rest: "\x1b" });
		expect(decode("j\x1b[")).toEqual({
			keys: [{ name: "char", ch: "j" }],
			rest: "\x1b[",
		});
		expect(decode("\x1bq").keys.map((k) => k.name)).toEqual(["esc", "char"]);
	});
	it("inserts a bracketed paste as text and reads OSC replies", () => {
		expect(decode("\x1b[200~a b\nc\x1b[201~").keys).toEqual([
			{ name: "paste", text: "a b\nc" },
		]);
		expect(decode("\x1b]11;rgb:1b1b/1b1b/1f1f\x07j").keys).toEqual([
			{ name: "osc", text: "11;rgb:1b1b/1b1b/1f1f" },
			{ name: "char", ch: "j" },
		]);
	});
});

describe("diffFrame", () => {
	it("repaints everything without a previous frame, inside one synchronized update", () => {
		const out = diffFrame(null, ["a", "b"]);
		expect(out).toBe(
			"\x1b[?2026h\x1b[1;1Ha\x1b[0m\x1b[K\x1b[2;1Hb\x1b[0m\x1b[K\x1b[?2026l",
		);
	});
	it("rewrites only the rows that changed: a spinner tick touches one row", () => {
		const prev = ["header", " ⠋ ACME-505", "footer"];
		expect(diffFrame(prev, ["header", " ⠙ ACME-505", "footer"])).toBe(
			"\x1b[?2026h\x1b[2;1H ⠙ ACME-505\x1b[0m\x1b[K\x1b[?2026l",
		);
		expect(diffFrame(prev, prev)).toBe("");
	});
});

describe("the scheduler", () => {
	it("sets no timer at all when nothing on screen moves or counts", () => {
		expect(
			nextDelay({ animating: false, seconds: false }, 1_000_500),
		).toBeUndefined();
	});
	it("ticks at 10 fps while something moves, on the second for clocks, and for a toast", () => {
		expect(nextDelay({ animating: true, seconds: true }, 1_000_500)).toBe(100);
		expect(nextDelay({ animating: false, seconds: true }, 1_000_500)).toBe(505);
		expect(
			nextDelay(
				{ animating: false, seconds: false, deadline: 1_002_000 },
				1_000_500,
			),
		).toBe(1500);
		expect(
			nextDelay({ animating: false, seconds: false, minute: true }, 59_000),
		).toBe(1005);
	});
});

describe("an idle screen", () => {
	const idle = (args: string[], keep?: (p: string) => boolean) => {
		const home = readHome(fixtureFs({}, keep), HOME, NOW);
		const a = parseViewArgs([...args, "--frame"], false);
		const ink = {
			...detectInk({}, false, undefined, { depth: 0 }),
			motion: true,
		};
		const out = render(
			stateFor(a, home, NOW),
			{ home },
			ink,
			{ cols: 120, rows: 36 },
			{ now: NOW },
		);
		return nextDelay(out, NOW);
	};
	it("sets no timer on a parked run, whose start ages by the hour", () => {
		expect(idle(["ACME-410"])).toBeUndefined();
		expect(idle(["ACME-410", "--page", "gates"])).toBeUndefined();
	});
	it("sets no timer on Home with the dock of a run at rest", () => {
		const resting = (p: string) => !/ACME-(500|390)/.test(p);
		expect(idle(["--select", "ACME-410"], resting)).toBeUndefined();
	});
});

describe("live refresh", () => {
	it("flashes the rows that changed and settles a child that stopped running", () => {
		const before = readHome(fixtureFs(), HOME, NOW);
		const extra = `${JSON.stringify({ at: "2026-10-20T14:02:30.000Z", child: "ACME-506", attempt: 1, stage: "result", status: "done", tokens: 5 })}\n`;
		const fs = fixtureFs();
		const log = `${HOME}/runs/ACME-500/runlog.jsonl`;
		const grown = fixtureFs({ [log]: `${fs.read(log)}${extra}` });
		const after = readHome(grown, HOME, NOW);
		const counts = new Map(before.runs.map((r) => [r.key, r.events.length]));
		const f = flashesFor(
			signatures(before),
			signatures(after),
			NOW,
			after,
			counts,
		);
		expect(f["ACME-506"]).toBe(NOW);
		expect(f["settle:ACME-506"]).toBe(NOW);
		expect(f["ACME-500"]).toBe(NOW);
		expect(f["ACME-505"]).toBeUndefined();
		expect(
			Object.keys(f).filter((k) => k.startsWith("ACME-500:")),
		).toHaveLength(1);
	});
	it("reads a grown runlog from its offset and waits for a whole line", () => {
		const line = (n: number) =>
			`${JSON.stringify({ at: "2026-10-20T10:00:00.000Z", child: "ACME-1", attempt: n, stage: "dispatched" })}\n`;
		const path = "/h/runs/ACME-0/runlog.jsonl";
		const t1 = readTail(
			memoryFs({ [path]: `${line(1)}${line(2).slice(0, 10)}` }),
			path,
		);
		expect(t1?.log.rows).toHaveLength(1);
		const t2 = advance(
			memoryFs({ [path]: `${line(1)}${line(2)}${line(3).slice(0, 5)}` }),
			path,
			t1,
		);
		expect(t2?.log.rows.map((r) => r.attempt)).toEqual([1, 2]);
		const shrunk = advance(memoryFs({ [path]: line(9) }), path, t2);
		expect(shrunk?.log.rows.map((r) => r.attempt)).toEqual([9]);
	});
});

describe("tty helpers", () => {
	it("normalises remotes to https", () => {
		expect(normaliseRemote("git@github.com:acme/app.git")).toBe(
			"https://github.com/acme/app",
		);
		expect(normaliseRemote("https://github.com/acme/app.git\n")).toBe(
			"https://github.com/acme/app",
		);
		expect(normaliseRemote("https://token@git.example.com/acme/app")).toBe(
			"https://git.example.com/acme/app",
		);
		expect(normaliseRemote("ssh://git@git.example.com/acme/app.git")).toBe(
			"https://git.example.com/acme/app",
		);
	});
	it("copies with OSC 52", () => {
		expect(osc52("ACME-505")).toBe(
			`\x1b]52;c;${Buffer.from("ACME-505").toString("base64")}\x07`,
		);
	});
});
