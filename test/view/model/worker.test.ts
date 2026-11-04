import { describe, expect, it } from "vitest";
import { memoryFs } from "../../../src/view/model/fs";
import { readHome } from "../../../src/view/model/home";
import { gatherRun } from "../../../src/view/model/run";
import {
	LOG_TAIL,
	type LogCache,
	logLines,
	readWorkerFiles,
} from "../../../src/view/model/worker";
import { fixtureFs, HOME, NOW, stalledFs, withMtimes } from "../helpers";

const RUN = `${HOME}/runs/ACME-500`;
const child = (fs = fixtureFs(), key = "ACME-506") =>
	readHome(fs, HOME, NOW)
		.runs.find((r) => r.key === "ACME-500")
		?.children.find((c) => c.key === key);

describe("a worker's log", () => {
	it("reads stream-json as what was said, the tool called and what it answered", () => {
		const line = (v: unknown) => logLines(JSON.stringify(v));
		expect(
			line({ type: "system", subtype: "init", model: "claude-opus" }),
		).toEqual([{ kind: "init", text: "session started · claude-opus" }]);
		expect(
			line({
				type: "assistant",
				message: {
					content: [
						{ type: "thinking", thinking: "hidden" },
						{ type: "text", text: "First.\n\nSecond." },
						{
							type: "tool_use",
							name: "Bash",
							input: { command: "bun test\n--watch" },
						},
					],
				},
			}),
		).toEqual([
			{ kind: "say", text: "First." },
			{ kind: "say", text: "Second." },
			{ kind: "tool", text: "Bash  bun test" },
		]);
		expect(
			line({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							is_error: true,
							content: [{ type: "text", text: "\n  error: 1 failed\nmore" }],
						},
					],
				},
			}),
		).toEqual([{ kind: "error", text: "error: 1 failed" }]);
		expect(
			line({
				type: "result",
				subtype: "success",
				duration_ms: 61_400,
				result: '{"status":"done"}',
			}),
		).toEqual([
			{ kind: "result", text: 'result · success · 61s · {"status":"done"}' },
		]);
		expect(logLines("plain text from a wrapper script")).toEqual([
			{ kind: "raw", text: "plain text from a wrapper script" },
		]);
		expect(logLines("   ")).toEqual([]);
	});
	it("reads only the tail of a long log, from its first whole line", () => {
		const long = `${"x".repeat(100)}\n`.repeat(Math.ceil(LOG_TAIL / 50));
		const fs = memoryFs({
			"/r/worker-ACME-1.json": JSON.stringify({ attempt: 1, pid: 7 }),
			"/r/worker-ACME-1-1.log": `first line\n${long}last line\n`,
		});
		const w = readWorkerFiles(fs, "/r", "ACME-1");
		expect(w?.log?.cut).toBe(true);
		const lines = w?.log?.lines ?? [];
		expect(lines[0]?.text.startsWith("x")).toBe(true);
		expect(lines.at(-1)?.text).toBe("last line");
		expect(lines.length).toBeLessThanOrEqual(LOG_TAIL / 100);
		expect(w?.alive).toBe(false);
	});
});

describe("reading a live log", () => {
	const say = (text: string) =>
		`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
	/** A file that grows between reads, and every read the view makes of it. */
	function growing(first: string) {
		let text = first;
		const reads: number[] = [];
		const base = memoryFs({
			"/r/worker-ACME-1.json": JSON.stringify({ attempt: 1, pid: 7 }),
		});
		const fs = {
			...base,
			stat: (p: string) =>
				p.endsWith(".log")
					? {
							size: Buffer.byteLength(text),
							mtimeMs: Buffer.byteLength(text),
							dir: false,
						}
					: base.stat(p),
			read: (p: string) => {
				if (!p.endsWith(".log")) return base.read(p);
				reads.push(0);
				return text;
			},
			readFrom: (p: string, at: number) => {
				if (!p.endsWith(".log")) return base.readFrom(p, at);
				reads.push(at);
				return Buffer.from(text).subarray(at).toString("utf8");
			},
		};
		return {
			fs,
			reads,
			add: (t: string) => {
				text += t;
			},
		};
	}
	it("reads only the bytes added since, and keeps the lines array while nothing changed", () => {
		const g = growing(say("one"));
		const cache: LogCache = new Map();
		const a = readWorkerFiles(g.fs, "/r", "ACME-1", { cache });
		const b = readWorkerFiles(g.fs, "/r", "ACME-1", { cache });
		expect(b?.log?.lines).toBe(a?.log?.lines);
		expect(g.reads).toEqual([0]);
		const size = Buffer.byteLength(say("one"));
		g.add(say("two"));
		const c = readWorkerFiles(g.fs, "/r", "ACME-1", { cache });
		expect(g.reads).toEqual([0, size]);
		expect(c?.log?.lines.map((l) => l.text)).toEqual(["one", "two"]);
	});
	it("holds a half-written line until its newline arrives", () => {
		const whole = say("three");
		const g = growing(say("one") + whole.slice(0, 20));
		const cache: LogCache = new Map();
		readWorkerFiles(g.fs, "/r", "ACME-1", { cache });
		g.add(whole.slice(20));
		const out = readWorkerFiles(g.fs, "/r", "ACME-1", { cache });
		expect(out?.log?.lines.map((l) => l.text)).toEqual(["one", "three"]);
	});
	it("only stats the log of a child whose page is not open", () => {
		const g = growing(say("one"));
		const w = readWorkerFiles(g.fs, "/r", "ACME-1", {
			cache: new Map(),
			read: false,
		});
		expect(g.reads).toEqual([]);
		expect(w?.log).toMatchObject({
			lines: [],
			unread: true,
			size: Buffer.byteLength(say("one")),
		});
		// Through a run: only the wanted child's log is read.
		const run = gatherRun(fixtureFs(), HOME, "ACME-500", undefined, {
			cache: new Map(),
			want: () => false,
		});
		expect(run.workers["ACME-506"]?.log?.unread).toBe(true);
	});
});

describe("a child's worker", () => {
	it("is detached when worker-<KEY>.json names its newest attempt", () => {
		const w = child()?.worker;
		expect(w).toMatchObject({
			kind: "detached",
			attempt: 1,
			pid: 48211,
			status: "alive",
			quietMs: 12_000,
			worktree: "/home/acme/.portia/worktrees/acme-app/ACME-506",
		});
		expect(w?.lines.at(-1)).toEqual({
			kind: "tool",
			text: "Bash  portia gate task ACME-506 --parent ACME-500",
		});
	});
	it("is stalled once its log has not grown for 20 minutes", () => {
		const w = child(stalledFs())?.worker;
		expect(w?.status).toBe("stalled");
		expect(w?.quietMs).toBe(22 * 60_000 + 31_000);
	});
	it("has exited when its pid no longer answers, and finished once it wrote a result", () => {
		expect(child(withMtimes({ alive: [4242] }))?.worker?.status).toBe("exited");
		const done = withMtimes(
			{ alive: [4242] },
			{ [`${RUN}/result-ACME-506-1.json`]: '{"status":"done"}' },
		);
		expect(child(done)?.worker?.status).toBe("finished");
	});
	it("is a subagent otherwise, with the orchestrator's pid when dispatch recorded it", () => {
		expect(child(fixtureFs(), "ACME-505")?.worker).toEqual({
			kind: "subagent",
			attempt: 2,
			lines: [],
			owner: {
				pid: 4242,
				started: "Tue Oct 20 08:00:00 2026",
				alive: true,
				tty: "ttys003",
			},
		});
		// A pid that answers but started at another time is another process.
		const reused = child(
			withMtimes({ procs: { "4242": { start: "Wed Oct 21 07:00:00 2026" } } }),
			"ACME-505",
		)?.worker;
		expect(reused?.owner?.alive).toBe(false);
		const gone = child(withMtimes({ alive: [] }), "ACME-505")?.worker;
		expect(gone?.owner?.alive).toBe(false);
		// No pid recorded: a subagent all the same.
		expect(child(fixtureFs(), "ACME-504")?.worker).toEqual({
			kind: "subagent",
			attempt: 1,
			lines: [],
			owner: undefined,
		});
		expect(child(fixtureFs(), "ACME-507")?.worker).toBeUndefined();
	});
	it("reads a record from an older attempt as no detached worker for this one", () => {
		const fs = fixtureFs({
			[`${RUN}/worker-ACME-505.json`]: JSON.stringify({ attempt: 1, pid: 1 }),
		});
		expect(child(fs, "ACME-505")?.worker?.kind).toBe("subagent");
	});
	it("ignores the settings and CPU files that sit beside a record", () => {
		const fs = fixtureFs({
			[`${RUN}/worker-ACME-506-1.settings.json`]: "{}",
			[`${RUN}/worker-ACME-506-1.cpu.json`]: "{}",
		});
		const run = readHome(fs, HOME, NOW).runs.find((r) => r.key === "ACME-500");
		expect(run?.children.find((c) => c.key === "ACME-506")?.worker?.kind).toBe(
			"detached",
		);
	});
});
