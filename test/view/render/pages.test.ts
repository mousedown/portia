import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseViewArgs, stateFor } from "../../../src/view/args";
import type { ViewFs } from "../../../src/view/model/fs";
import { readHome } from "../../../src/view/model/home";
import { render } from "../../../src/view/render";
import type { Ink } from "../../../src/view/render/ink";
import { strWidth } from "../../../src/view/render/text";
import { refuseAsk, settleAsk } from "../../../src/view/runtime/ask";
import {
	initialState,
	reduce,
	type ViewState,
} from "../../../src/view/runtime/state";
import {
	answeredFs,
	askingFs,
	fixtureFs,
	frame,
	HOME,
	MACHINE,
	NOW,
	stalledFs,
	visible,
	withMtimes,
} from "../helpers";

const size = (w: number, h: number) => [
	"--width",
	String(w),
	"--height",
	String(h),
];
const lines = (s: string) => s.split("\n");
const file = (name: string) =>
	join(import.meta.dirname, "__frames__", `${name}.txt`);
const INK: Ink = { depth: 0, theme: "dark", unicode: true, motion: false };

/** A frame from a state the keys reached, which `--frame` flags cannot express. */
function frameOf(
	args: string[],
	change: (s: ViewState) => ViewState,
	fs = fixtureFs(),
	cols = 120,
	rows = 60,
): string[] {
	const home = readHome(fs, HOME, NOW);
	const s = change(stateFor(parseViewArgs(args, false), home, NOW));
	return render(
		s,
		{ home, machine: MACHINE },
		INK,
		{ cols, rows },
		{ now: NOW, frozen: true },
	).lines.map((l) => l.trimEnd());
}

const LONG =
	"invoice-mail.itest.ts 4 passed: closing a period sends one email per team admin with the PDF attached, " +
	"a team with no admin sends none, a closed period never sends twice, and a failed send retries on the next tick " +
	"without closing the period again.";

describe("the Child page's evidence", () => {
	it("lists what the child proves, with the evidence its worker reported", () => {
		const out = lines(frame(["ACME-500", "ACME-503", ...size(120, 40)]));
		const at = out.findIndex((l) => /^ +evidence /.test(l));
		expect(out[at]).toMatch(/1 of 1 proven$/);
		expect(out[at + 2]).toMatch(
			/^▌ {2}R3 {2}✓ {2}tax follows the billing country/,
		);
		expect(out[at + 3]).toMatch(/^ {10}▎ tax\.itest\.ts 6 passed$/);
	});
	it("quotes a result row's data.evidence, two lines until ⏎ expands it", () => {
		const log = `${HOME}/runs/ACME-500/runlog.jsonl`;
		const row = JSON.stringify({
			at: "2026-10-20T14:02:30.000Z",
			child: "ACME-506",
			attempt: 1,
			stage: "result",
			status: "done",
			tokens: 90_000,
			touchesMatched: true,
			data: { message: "done", evidence: { R6: LONG } },
		});
		const fs = fixtureFs({ [log]: `${fixtureFs().read(log)}${row}\n` });
		const args = ["ACME-500", "ACME-506"];
		const closed = frameOf(args, (s) => s, fs);
		const quoted = (l: string[]) => l.filter((x) => /^ {10}▎ /.test(x));
		expect(quoted(closed)).toHaveLength(2);
		expect(quoted(closed)[0]).toContain("invoice-mail.itest.ts 4 passed");
		// A cut quote ends in the fold mark.
		expect(quoted(closed)[1]).toMatch(/⏎$/);
		const open = frameOf(
			args,
			(s) => ({ ...s, expanded: ["ev:ACME-506:R6"] }),
			fs,
		);
		expect(quoted(open).length).toBeGreaterThan(2);
		expect(quoted(open).join(" ")).toContain(
			"without closing the period again.",
		);
		expect(quoted(open).at(-1)).not.toMatch(/⏎$/);
		// It counts once the attempt is done, and the Run page's dock says so too.
		expect(closed.find((l) => l.includes("evidence"))).toMatch(
			/1 of 1 proven$/,
		);
		const run = frameOf(
			["ACME-500", "--select", "ACME-506"],
			(s) => s,
			fs,
			120,
			36,
		);
		// One requirement says what it is in the dock, after the child it belongs to.
		expect(run.find((l) => l.includes("proves"))).toMatch(
			/proves +R6 ✓ the invoice is emailed when a period closes$/,
		);
		expect(run.find((l) => l.includes("ACME-506 · attempt 1"))).toBeDefined();
	});
	it("shows evidence from an attempt that did not land, dimmed and named", () => {
		const out = lines(frame(["ACME-500", "ACME-505", ...size(120, 40)]));
		expect(out.join("\n")).toContain(
			"▎ attempt 1, not landed: invoice-pdf.spec.ts 5 passed",
		);
		expect(out.find((l) => l.includes("evidence"))).toMatch(
			/0 of 1 proven so far$/,
		);
	});
});

describe("the breadcrumb", () => {
	it("starts at activity for a child opened from the feed", () => {
		const out = frameOf(["ACME-500", "ACME-505"], (s) => ({
			...s,
			stack: [
				{ screen: "home", matrix: false },
				{ screen: "activity", matrix: false },
			],
		}));
		expect(out[0]).toMatch(/^ {2}◆ {2}█▀█ .* {3}activity {2}› {2}ACME-505 /);
		expect(frameOf(["ACME-500", "ACME-505"], (s) => s)[0]).toMatch(
			/^ {2}◆ {2}█▀█ .* {3}ACME-500 {2}› {2}ACME-505 /,
		);
	});
});

describe("the Child page's other sections", () => {
	it("goes status, evidence, gates, files, worker, attempts", () => {
		const out = frame(["ACME-500", "ACME-505", ...size(120, 80)]);
		const order = [
			/^ +state +\S running · attempt 2/m,
			/^ +evidence /m,
			/^ +gates$/m,
			/^ +files$/m,
			/^ +worker /m,
			/^ +attempts /m,
		].map((h) => out.search(h));
		expect(order.every((i) => i > 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});
	it("expands a failed gate with the reason that followed it", () => {
		const out = frame(["ACME-500", "ACME-505", ...size(120, 60)]);
		expect(out).toMatch(/attempt 1 {2}typecheck ✓ {2}lint ✓ {2}unit ✗/);
		expect(out).toContain("▎ exit gate failed on the rebased head: unit");
		// Attempts are words, never a1 or a2.
		expect(out).not.toMatch(/\ba\d\b/);
	});
	it("opens a failed gate's whole reason on ⏎, from the row the cursor lands on", () => {
		const id = "gate:ACME-505:exit:1";
		const closed = frameOf(["ACME-500", "ACME-505"], (s) => s).join("\n");
		expect(closed).not.toContain("expected 10.05, received 10.04");
		const open = frameOf(["ACME-500", "ACME-505"], (s) => ({
			...s,
			expanded: [id],
		}));
		const quoted = open.filter((l) => /^ {21}▎ /.test(l));
		expect(quoted.join(" ")).toContain("both rounding half-cents the");
		expect(quoted.join(" ")).toContain("expected 10.05, received 10.04");
		expect(quoted.at(-1)).not.toMatch(/⏎$/);
	});
	it("says where the files went in plain words, each file once", () => {
		const landed = frame(["ACME-500", "ACME-503", ...size(120, 60)]);
		expect(landed).toContain(
			"changed 2 files outside its 1 declared path, both approved by a person on Oct 20:",
		);
		expect(landed).toContain(
			"· src/tax/rates.ts — the shared rate table had to learn about reverse charge",
		);
		// The approval the files used is told once, not again as a list.
		expect(landed).not.toContain("approved extra paths");
		expect(landed.match(/src\/tax\/rates\.ts/g)).toHaveLength(1);
		expect(frame(["ACME-500", "ACME-501", ...size(120, 60)])).toContain(
			"stayed inside its 1 declared path",
		);
		const pdf = frame(["ACME-500", "ACME-505", ...size(120, 60)]);
		expect(pdf).toContain(
			"changed 1 file outside its 1 declared path, approved by a person on Oct 20:",
		);
		expect(pdf).not.toContain("accepted by rule");
		// An approval no file used is listed under its own heading.
		const spare = `${HOME}/runs/ACME-500/touches-ACME-501.json`;
		const fs = fixtureFs({
			[spare]: JSON.stringify([
				{
					glob: "src/invoice/legacy/**",
					at: "2026-10-20T07:00:00Z",
					by: "person",
					why: "the old exporter may need a shim",
				},
			]),
		});
		const unused = frame(["ACME-500", "ACME-501", ...size(120, 60)], { fs });
		expect(unused).toContain("approved extra paths");
		expect(unused).toContain("src/invoice/legacy/**");
	});
	it("never says touches: not on a Child page, not in Activity", () => {
		const home = readHome(fixtureFs(), HOME, NOW);
		for (const r of home.runs)
			for (const c of r.children) {
				const text = frame([r.key, c.key, ...size(120, 80)]);
				expect(text.toLowerCase(), `${r.key}/${c.key}`).not.toContain(
					"touches",
				);
			}
		const feed = frameOf(
			["--page", "activity"],
			(s) => s,
			fixtureFs(),
			160,
			400,
		);
		expect(feed.join("\n").toLowerCase()).not.toContain("touches");
		expect(feed.join("\n")).toContain(
			"files ok     outside paths accepted · automatically",
		);
	});
	it("shows a failed land's PR on the status line, and offers o for it", () => {
		const out = lines(frame(["ACME-366", "ACME-369", ...size(120, 36)]));
		expect(out.join("\n")).toMatch(/^ +state +✗ failed · /m);
		expect(out.join("\n")).toMatch(/^ +pr +#360 · land failed$/m);
		expect(out.join("\n")).not.toContain("no PR yet");
		expect(out.at(-1)).toContain("o PR");
	});
	it("keeps the attempts before the current one closed until ⏎ opens them", () => {
		const out = frame(["ACME-500", "ACME-505", ...size(120, 80)]);
		expect(out).toMatch(
			/1 {2}✗ land failed · 46m 18s · 127k tokens · 9 rows {2}─+ ⏎/,
		);
		expect(out).not.toContain("13:03:40   ▸ dispatched");
		const open = frameOf(["ACME-500", "ACME-505"], (s) => ({
			...s,
			expanded: ["att:ACME-505:1"],
		}));
		expect(open.join("\n")).toContain("13:03:40   ▸ dispatched");
	});
});

describe("the worker", () => {
	it("shows a detached worker's process, where it works and its last 8 log lines", () => {
		const out = lines(frame(["ACME-500", "ACME-506", ...size(120, 60)]));
		const text = out.join("\n");
		expect(text).toMatch(/worker +detached/);
		expect(text).toMatch(
			/process +pid 48211 · alive · started 13:58 · log quiet 12s/,
		);
		expect(text).toMatch(
			/branch +epic\/ACME-506 +port 3102 +db portia_acme_506/,
		);
		const log = out.filter((l) => /^ {3}▎ /.test(l));
		expect(log).toHaveLength(8);
		expect(log[0]).toContain("‹ error: expected 1 email, received 0");
		expect(log.at(-1)).toContain(
			"› Bash  portia gate task ACME-506 --parent ACME-500",
		);
		expect(text).toContain("w opens the full log");
	});
	it("says when a detached worker has stalled", () => {
		const out = frame(["ACME-500", "ACME-506", ...size(120, 60)], {
			fs: stalledFs(),
		});
		expect(out).toMatch(
			/pid 48211 · stalled · started 13:30 · no log output for 22m/,
		);
		const page = frame(["ACME-500", "ACME-506", "--page", "worker"], {
			fs: stalledFs(),
		});
		expect(lines(page)[0]).toMatch(/› {2}worker .* stalled · 14:02$/);
	});
	it("says when a detached worker's process has gone", () => {
		expect(
			frame(["ACME-500", "ACME-506", ...size(120, 60)], {
				fs: withMtimes({ alive: [4242] }),
			}),
		).toMatch(/pid 48211 · exited/);
	});
	it("shows the whole log on the Worker page, following its end", async () => {
		const out = lines(frame(["ACME-500", "ACME-506", "--page", "worker"]));
		expect(out[0]).toMatch(
			/^ {2}◆ {2}█▀█ .* {3}ACME-500 {2}› {2}ACME-506 {2}› {2}worker/,
		);
		expect(out[1]).toMatch(/ 1 child {4}2 worker$/);
		expect(out[4]).toMatch(/following the end$/);
		expect(out.join("\n")).toContain("session started · claude-opus");
		expect(out.join("\n")).toContain("› Bash portia gate task ACME-506");
		await expect(
			`${frame(["ACME-500", "ACME-506", "--page", "worker", ...size(120, 36), "--depth", "0"], { fs: stalledFs() })}\n`,
		).toMatchFileSnapshot(file("worker-stalled-120x36"));
	});
	it("searches the log and says which match it is on", () => {
		const out = frameOf(
			["ACME-500", "ACME-506", "--page", "worker"],
			(s) => ({ ...s, filter: { text: "on-close", editing: false }, match: 0 }),
			fixtureFs(),
			120,
			36,
		);
		expect(out[4]).toMatch(/1 of 8 matches$/);
		expect(out.find((l) => l.startsWith("▌"))).toContain(
			"Write src/invoice/mail/on-close.ts",
		);
	});
	it("says how to reach a subagent: through the orchestrator's session", () => {
		const text = frame(["ACME-500", "ACME-505", ...size(120, 60)]);
		expect(text).toMatch(/worker +subagent/);
		expect(text).toMatch(
			/session +runs inside the orchestrator's Claude Code session/,
		);
		expect(text).toMatch(
			/orchestrator +pid 4242 · alive · ttys003 · switch to that terminal/,
		);
		expect(text).toMatch(
			/worktree +\/home\/acme\/\.portia\/worktrees\/acme-app\/ACME-505/,
		);
		expect(text).toContain("y copies the worktree · e opens it in $EDITOR");
		expect(text).not.toContain("w opens the full log");
		const page = frame(["ACME-500", "ACME-505", "--page", "worker"]);
		expect(page).toContain("This worker is a subagent");
	});
	it("says a subagent's session has ended when its orchestrator has gone", () => {
		const text = frame(["ACME-500", "ACME-505", ...size(120, 60)], {
			fs: withMtimes({ alive: [48211] }),
		});
		expect(text).toMatch(
			/session +ran inside the orchestrator's Claude Code session, which has ended/,
		);
		expect(text).toMatch(
			/orchestrator +pid 4242 · gone · portia resume ACME-500 picks this child up/,
		);
		expect(text).not.toContain("runs inside");
	});
	it("takes a reused pid for a gone process: its start time is not the recorded one", () => {
		const text = frame(["ACME-500", "ACME-506", ...size(120, 60)], {
			fs: withMtimes({
				procs: { "48211": { start: "Wed Oct 21 09:00:00 2026" } },
			}),
		});
		expect(text).toMatch(/pid 48211 · exited/);
	});
	it("says a torn-down worktree was removed, and offers no y or e for it", () => {
		const text = lines(frame(["ACME-500", "ACME-503", ...size(120, 60)]));
		expect(text.join("\n")).toMatch(
			/worktree +removed 09:17 \(was \/home\/acme\/\.portia\/worktrees\/acme-app\/ACME-503\)/,
		);
		expect(text.join("\n")).not.toContain("y copies the worktree");
		expect(text.at(-1)).not.toMatch(/\by copy|\be editor/);
	});
	it("says a child that was never dispatched has no worker", () => {
		const page = frame(["ACME-500", "ACME-507", "--page", "worker"]);
		expect(page).toContain("Not dispatched yet: there is no worker");
		expect(page).not.toContain("subagent");
	});
	it("puts in the footer only the keys that work on the page", () => {
		const foot = (args: string[]) => lines(frame(args)).at(-1) ?? "";
		expect(foot(["ACME-500", "ACME-506"])).toContain("w worker log");
		expect(foot(["ACME-500", "ACME-505"])).not.toContain("w worker log");
		expect(foot(["ACME-500", "ACME-505"])).not.toContain("o PR");
		expect(foot(["ACME-500", "ACME-503"])).toContain("o PR");
		for (const args of [[], ["ACME-500"], ["ACME-500", "ACME-505"]])
			expect(foot(args)).not.toMatch(/\btab\b/);
		// No run in the fixture has an epic diff, so d is not offered.
		expect(foot(["ACME-500"])).not.toContain("d epic diff");
		const fs = fixtureFs({ [`${HOME}/runs/ACME-500/epic.diff`]: "diff\n" });
		expect(lines(frame(["ACME-500"], { fs })).at(-1)).toContain("d epic diff");
	});
	it("labels every key in every footer, down to 60 columns, and keeps ? help on Home's list", () => {
		const pages: string[][] = [
			[],
			["--page", "activity"],
			["--page", "machine"],
			["ACME-500"],
			["ACME-500", "--page", "gates"],
			["ACME-500", "ACME-505"],
			["ACME-500", "ACME-506"],
			["ACME-500", "ACME-506", "--page", "worker"],
		];
		for (const args of pages)
			for (const [w, h] of [
				[120, 36],
				[72, 30],
				[60, 24],
			] as const) {
				const foot = (lines(frame([...args, ...size(w, h)])).at(-1) ?? "")
					.replace(/[●*] live\s*$/, "")
					.replace(/! \d+ questions? on Home\s*$/, "")
					.trim();
				const tokens = foot.split(/ {2,}/).filter(Boolean);
				for (const t of tokens)
					expect(t, `${args.join(" ")} ${w}x${h}: ${foot}`).toMatch(
						/^\S+ [a-z$]/,
					);
				// A question waits on Home, so its keys are the panel's, until esc gives them back.
				if (!args.length) {
					expect(foot).toContain("esc list");
					const list = lines(frame([...size(w, h)], { fs: answeredFs() })).at(
						-1,
					);
					expect(list).toContain("? help");
				}
			}
	});
});

describe("Home's question panel", () => {
	const WORDS = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
	const OPTIONS = [
		"Allow read-only gh api",
		"Put copies in the worktree",
		"Design the motion fresh",
		`A very long choice that goes on ${WORDS}`,
	];
	const asking = askingFs;
	const withOptions = () => asking({ options: OPTIONS, recommended: 0 });
	const at = (
		cols = 120,
		rows = 33,
		fs = withOptions(),
		ch?: (s: ViewState) => ViewState,
	) => frameOf([], ch ?? ((s) => s), fs, cols, rows);
	const chosen = (out: string[]) => out.filter((l) => l.includes("❯"));

	it("shows the question, the choices and the keys, on the list's key column", () => {
		const out = at();
		const q = out.find((l) => l.includes("May I add the search index")) ?? "";
		expect(q.search(/May/)).toBe(4);
		expect(chosen(out)).toHaveLength(1);
		expect(chosen(out)[0]).toMatch(
			/^ {2}❯ 1 {2}Allow read-only gh api \(recommended\)$/,
		);
		expect(out.join("\n")).toContain("2  Put copies in the worktree");
		expect(out.join("\n")).toContain("or just type your own answer");
		expect(out.join("\n")).toMatch(/ACME-418 .*1 of 1/);
		expect(out.at(-1)).toMatch(/↑↓ choose · ⏎ send · esc list/);
		expect(out.at(-1)).not.toContain("tab next");
	});
	it("offers tab with two questions", () => {
		const two = fixtureFs({
			[join(HOME, "runs", "ACME-999", "runlog.jsonl")]: `${JSON.stringify({
				at: "2026-10-20T09:00:00.000Z",
				child: "ACME-998",
				attempt: 1,
				stage: "result",
				status: "parked",
				data: { message: "Another?" },
			})}\n`,
		});
		const out = at(120, 33, two);
		expect(out.at(-1)).toContain("tab next");
		expect(out.join("\n")).toMatch(/of 2/);
	});
	it("says type your answer, with no choices, and offers no ↑↓", () => {
		const out = at(120, 33, fixtureFs());
		expect(out.join("\n")).toContain("type your answer");
		expect(out.join("\n")).not.toContain("or just type");
		expect(chosen(out)).toEqual([]);
		expect(out.at(-1)).toMatch(/esc list/);
		expect(out.at(-1)).not.toContain("choose");
	});
	it("during the pause says what works now, and does not offer ⏎", () => {
		const out = at(120, 33, withOptions(), (s) => ({
			...s,
			lastKeyAt: NOW - 100,
		}));
		expect(out.at(-1)).toMatch(/type to answer · esc list/);
		expect(out.at(-1)).not.toContain("⏎");
		expect(out.at(-1)).not.toContain("↑↓");
		expect(out.join("\n")).toContain("May I add the search index");
	});
	it("offers ⏎ answer only once dismissed, and only on a waiting run's row", () => {
		const dismissed = (fs: ViewFs, sel: string) =>
			at(120, 33, fs, (s) => {
				const home = readHome(fs, HOME, NOW);
				const shown = settleAsk(s, home, NOW - 60_000);
				return {
					...reduce(shown, { name: "esc" }, { home, now: NOW - 5000, rows: 33 })
						.state,
					selection: { "home:runs": sel },
				};
			});
		const on = dismissed(withOptions(), "ACME-410");
		expect(on.at(-1)).toMatch(/↑↓ move · → open · ⏎ answer · a activity/);
		const quiet = dismissed(withOptions(), "ACME-500");
		expect(quiet.at(-1)).toMatch(/↑↓ move · → open · a activity/);
		expect(quiet.at(-1)).not.toContain("⏎ answer");
	});
	it("does not offer ⏎ send over typed text until ⏎ would send it", () => {
		const fs = withOptions();
		const home = readHome(fs, HOME, NOW);
		const typed = reduce(
			settleAsk(initialState(), home, NOW),
			{ name: "char", ch: "o" },
			{ home, now: NOW + 100, rows: 33 },
		).state;
		const at2 = (now: number) =>
			render(
				typed,
				{ home, machine: MACHINE },
				INK,
				{ cols: 120, rows: 33 },
				{ now },
			);
		const before = at2(NOW + 100);
		expect(before.deadline).toBe(NOW + 2000);
		expect(visible(before.lines.at(-1) ?? "")).not.toContain("⏎ send");
		expect(visible(before.lines.at(-1) ?? "")).toContain("esc choices");
		expect(visible(at2(NOW + 2000).lines.at(-1) ?? "")).toContain("⏎ send");
	});
	it("a question with no choices offers no ⏎ until something is typed", () => {
		const out = at(120, 33, fixtureFs());
		expect(out.at(-1)).toMatch(/type to answer · esc list/);
		expect(out.at(-1)).not.toContain("⏎");
	});
	it("a word wider than the panel wraps, so the end of a pasted path shows", () => {
		const path = `/${"very-long-directory/".repeat(8)}the-end.txt`;
		const out = at(60, 40, withOptions(), (s) => {
			const home = readHome(withOptions(), HOME, NOW);
			const shown = settleAsk(s, home, NOW - 60_000);
			return { ...shown, ask: shown.ask && { ...shown.ask, text: path } };
		});
		expect(out.join("").replace(/\s/g, "")).toContain(path);
		for (const l of out) expect(strWidth(l)).toBeLessThanOrEqual(59);
	});
	it("gives the question room before it scrolls while the list has rows to spare", () => {
		// A row too tall for the five list rows it could keep, and fine beside three.
		const out = at(60, 24, withOptions());
		const panel = out
			.slice(out.findIndex((l) => /^ {4}ACME-418/.test(l)))
			.join("\n");
		expect(panel).not.toMatch(/\d+ more/);
		expect(panel).toContain("May I add the search index");
		expect(panel).toMatch(/database\.$/m);
		expect(chosen(out)).toHaveLength(1);
	});
	it("uses > for the pointer in ASCII, and only ASCII", () => {
		const out = frame(["--ascii", "--depth", "0", ...size(60, 24)], {
			fs: withOptions(),
		});
		expect(out).toMatch(/^ {2}> 1 {2}/m);
		expect(/^[\x20-\x7e\n]*$/.test(out), out).toBe(true);
	});
	it("truncates a long option with an ellipsis, and wraps typed text", () => {
		const out = at(60, 40);
		expect(out.join("\n")).toMatch(/4 {2}A very long choice.*…/);
		const typed = at(60, 40, withOptions(), (s) => ({
			...s,
			ask: {
				run: "ACME-410",
				child: "ACME-418",
				since:
					readHome(withOptions(), HOME, NOW).runs[0]?.children.find(
						(c) => c.key === "ACME-418",
					)?.wait?.at ?? "",
				takenAt: NOW - 60_000,
				text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
			},
		}));
		const text = typed.join("\n");
		expect(text).toContain("one two three");
		expect(text).toContain("fifteen");
		expect(chosen(typed)).toEqual([]);
	});
	it("shows a refused send on the panel, with the text kept", () => {
		const fs = withOptions();
		const out = at(120, 33, fs, (s) => {
			const home = readHome(fs, HOME, NOW);
			const shown = settleAsk(s, home, NOW);
			return refuseAsk(
				{
					...shown,
					ask: shown.ask && { ...shown.ask, text: "my typed answer" },
				},
				home,
				"ACME-418 is no longer waiting on this question",
			);
		}).join("\n");
		expect(out).toContain("ACME-418 is no longer waiting on this question");
		expect(out).toContain("my typed answer");
	});
	it("asks to be painted when the pause ends, and only until then", () => {
		const fs = withOptions();
		const home = readHome(fs, HOME, NOW);
		const out = (lastKeyAt: number) =>
			render(
				{ ...initialState(), lastKeyAt },
				{ home, machine: MACHINE },
				INK,
				{ cols: 120, rows: 33 },
				{ now: NOW, frozen: true },
			).deadline;
		expect(out(NOW - 500)).toBe(NOW + 1500);
		// A deadline in the past would repaint as fast as the loop can go.
		const dismissed = reduce(
			initialState(),
			{ name: "esc" },
			{ home, now: NOW - 60_000, rows: 33 },
		).state;
		expect(
			render(
				dismissed,
				{ home, machine: MACHINE },
				INK,
				{ cols: 120, rows: 33 },
				{ now: NOW, frozen: true },
			).deadline,
		).toBeUndefined();
		expect(
			render(
				{ ...initialState(), toast: undefined, lastKeyAt: NOW - 5000 },
				{ home, machine: MACHINE },
				INK,
				{ cols: 120, rows: 33 },
				{ now: NOW, frozen: true },
			).deadline,
		).toBeUndefined();
	});
	it("takes control characters out of what a worker wrote", () => {
		const out = frameOf(
			[],
			(s) => s,
			asking({
				message: "Which\u001b[31m way?",
				options: ["red\u001b[2Jx", "blue\nsky"],
			}),
			120,
			33,
		).join("\n");
		expect(out).not.toContain("\u001b[31m");
		expect(out).not.toContain("\u001b[2J");
		expect(out).toContain("blue sky");
	});

	const LONG = `${Array.from({ length: 60 }, (_, i) => `line${i} of the question`).join("\n")}\nthe last line`;
	it("grows: the whole question reads when there is room", () => {
		const out = at(
			120,
			60,
			asking({
				message: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl",
				options: OPTIONS,
			}),
		);
		for (const ch of "abcdefghijkl")
			expect(
				out.some((l) => l.trim() === ch),
				ch,
			).toBe(true);
		expect(out.join("\n")).not.toMatch(/↓ \d+ more\s*$/m);
	});
	it("the hero gives way before the list does", () => {
		const out = at(
			120,
			33,
			asking({ message: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj", options: OPTIONS }),
		);
		expect(out.join("\n")).not.toContain("██████╗");
		expect(out[0]).toContain("P O R T I A");
		for (const ch of "abcdefghij")
			expect(
				out.some((l) => l.trim() === ch),
				ch,
			).toBe(true);
	});
	it("scrolls the question inside the panel when it cannot fit, and keeps the choices", () => {
		const fs = asking({ message: LONG, options: OPTIONS });
		const out = at(120, 24, fs);
		expect(out.join("\n")).toMatch(/↓ \d+ more/);
		expect(out.join("\n")).toContain("line0 of the question");
		expect(out.join("\n")).not.toContain("the last line");
		expect(chosen(out)).toHaveLength(1);
		expect(out.join("\n")).toContain("or just type your own answer");
		// PgDn goes to the end and stops there, however far it is pushed.
		const home = readHome(fs, HOME, NOW);
		const since =
			home.runs.flatMap((r) => r.children).find((c) => c.key === "ACME-418")
				?.wait?.at ?? "";
		const end = at(120, 24, fs, (s) => ({
			...s,
			scroll: { [`ask:ACME-410:ACME-418:${since}`]: 9999 },
		}));
		const panel = end.slice(end.findIndex((l) => /^ {4}ACME-418/.test(l)));
		expect(panel.join("\n")).toContain("the last line");
		expect(panel.join("\n")).toMatch(/↑ \d+ more/);
		expect(panel.join("\n")).not.toMatch(/↓ \d+ more/);
		expect(chosen(end)).toHaveLength(1);
	});
	it("at every size: the frame fits, the choices and the typing line show, and the list keeps 3 rows", () => {
		const fs = asking({ message: LONG, options: OPTIONS, recommended: 3 });
		const home = readHome(fs, HOME, NOW);
		const since =
			home.runs.flatMap((r) => r.children).find((c) => c.key === "ACME-418")
				?.wait?.at ?? "";
		const inks: Ink[] = [INK, { ...INK, unicode: false }];
		for (const ink of inks)
			for (const text of ["", `typed ${WORDS}`])
				for (const cols of [60, 61, 72, 85, 99, 100, 120, 160])
					for (let rows = 16; rows <= 50; rows++) {
						const s = settleAsk(initialState(), home, NOW);
						const out = render(
							{ ...s, ask: s.ask && { ...s.ask, since, text } },
							{ home, machine: MACHINE },
							ink,
							{ cols, rows },
							{ now: NOW, frozen: true },
						).lines.map(visible);
						const where = `${cols}x${rows} ${text ? "typing" : "choosing"} ${ink.unicode ? "unicode" : "ascii"}`;
						expect(out, where).toHaveLength(rows);
						for (const l of out)
							expect(strWidth(l), where).toBeLessThanOrEqual(cols - 1);
						const opt = out.findIndex((l) =>
							/ {2}1 {2}Allow read-only/.test(l),
						);
						expect(opt, where).toBeGreaterThan(0);
						for (const n of [2, 3, 4])
							expect(out[opt + n - 1], where).toMatch(
								new RegExp(`^ {2}. ${n} {2}|^ {4}${n} {2}`),
							);
						expect(out[opt + 4], where).toMatch(
							text ? /typed|word/ : /or just type/,
						);
						// The list's rows: from its first line to the panel, under any rule of the panel's.
						const head = out.findIndex((l) => /^ {4}ACME-418/.test(l));
						const list = out.findIndex((l) =>
							/waiting on you|[↑^] (\d+ )?more/.test(l),
						);
						const end = /^ *[─-]{20,}$/.test(out[head - 1] ?? "")
							? head - 1
							: head;
						expect(list, where).toBeGreaterThanOrEqual(0);
						expect(end - list, where).toBeGreaterThanOrEqual(3);
						expect(out.slice(list, end).join("\n"), where).toMatch(/ACME-410/);
					}
	}, 120_000);
});

describe("the footer on other pages", () => {
	const PAGES: string[][] = [
		["--page", "activity"],
		["--page", "machine"],
		["ACME-500"],
		["ACME-500", "ACME-505"],
		["ACME-500", "ACME-506", "--page", "worker"],
	];
	it("says how many questions wait, in the parked colour, at every width", () => {
		for (const args of PAGES)
			for (const cols of [60, 72, 120]) {
				const out = lines(frame([...args, ...size(cols, 30), "--depth", "0"]));
				expect(out.at(-1), `${args.join(" ")} at ${cols}`).toContain(
					"! 1 question on Home",
				);
			}
		const dark = lines(frame(["--page", "activity", "--depth", "24"]));
		expect(visible(dark.at(-1) ?? "")).toContain("! 1 question on Home");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: reading the colour
		expect(dark.at(-1)).toMatch(/\x1b\[[0-9;]*m! 1 question/);
	});
	it("does not on Home, or with no question waiting, or for a spec claim", () => {
		expect(frame(size(120, 33))).not.toContain("question on Home");
		expect(
			frame(["--page", "activity", ...size(120, 30)], { fs: answeredFs() }),
		).not.toContain("question on Home");
		const run = "ACME-418";
		const fs = fixtureFs();
		const log = join(HOME, "runs", "ACME-410", "runlog.jsonl");
		const claim = (fs.read(log) ?? "")
			.split("\n")
			.map((l) =>
				l.includes(run) && l.includes('"status":"parked"')
					? JSON.stringify({
							...JSON.parse(l),
							data: {
								...JSON.parse(l).data,
								spec: { path: "a", assertion: "b", evidence: "c" },
							},
						})
					: l,
			)
			.join("\n");
		expect(
			frame(["--page", "activity", ...size(120, 30)], {
				fs: fixtureFs({ [log]: claim }),
			}),
		).not.toContain("question on Home");
	});
	it("the Child page has no answer box and no Q", () => {
		const out = frame(["ACME-410/ACME-418", ...size(120, 40)]);
		expect(out).not.toContain("your answer");
		expect(out).not.toContain("Q answer");
		expect(out).toContain("May I add the search index");
	});
});

describe("accounts", () => {
	const RECORD = join(HOME, "runs", "ACME-500", "worker-ACME-506.json");
	const onWork = () => {
		const rec = JSON.parse(fixtureFs().read(RECORD) ?? "{}");
		return fixtureFs({ [RECORD]: JSON.stringify({ ...rec, account: "work" }) });
	};

	it("the run page gives each child the account its worker ran under, and the dock names it", () => {
		const text = visible(
			frame(["ACME-500", "--select", "ACME-506", ...size(160, 40)], {
				fs: onWork(),
			}),
		);
		expect(text).toMatch(/ACME-506 .* opus +work +attempt/);
		expect(text).toMatch(/ACME-506 · attempt 1 · .* · account work/);
	});

	it("the child page shows the account beside the pid", () => {
		const text = visible(
			frame(["ACME-500", "ACME-506", ...size(120, 60)], { fs: onWork() }),
		);
		expect(text).toMatch(/process +pid 48211 · account work · /);
	});

	it("without accounts nothing about them shows", () => {
		const text = visible(
			frame(["ACME-500", "--select", "ACME-506", ...size(160, 40)]),
		);
		expect(text).toMatch(/ACME-506 .* opus +attempt/);
		expect(text).not.toContain("· account ");
	});

	it("the machine page lists each account: its live workers, or the limit it waits out", () => {
		const text = visible(
			frame(["--page", "machine", ...size(120, 50)], {
				fs: onWork(),
				machine: {
					...MACHINE,
					accounts: [
						{ name: "work" },
						{
							name: "home",
							limitedUntil: "2026-10-20T15:00:00.000Z",
							reason: "5-hour limit reached",
						},
					],
				},
			}),
		);
		expect(text).toContain("accounts");
		expect(text).toMatch(/work +1 running · available/);
		expect(text).toMatch(
			/home +idle · limited until \d\d:00 · 5-hour limit reach/,
		);
	});
});

describe("the dock under Home's list", () => {
	const at = (cols = 130, rows = 36) =>
		frameOf([...size(cols, rows)], (s) => s, answeredFs());
	it("keeps the footer to what most pages need", () => {
		const foot = at()
			.filter((l) => l.includes("↑↓ move"))
			.join("");
		for (const k of ["a activity", "/ filter", "n new", "? help", "q quit"])
			expect(foot).toContain(k);
		for (const k of ["m machine", "o epic PR", "x archive", "s sort"])
			expect(foot).not.toContain(k);
	});
	it("lines the run's key up with the list's keys, and a child's glyph with the list's glyphs", () => {
		const out = at();
		const listRow = out.find((l) => /^.{2}. ACME-\d+ /.test(l)) ?? "";
		const listKey = listRow.search(/ACME-/);
		const rule = out.map((l) => /^ *─{20,}/.test(l)).lastIndexOf(true);
		const dock = out.slice(Math.max(0, rule));
		const head = dock.find((l) => /^ +ACME-\d+ {2}/.test(l)) ?? "";
		expect(head.search(/ACME-/)).toBe(listKey);
	});
	it("draws the strip in one still cell per child, solid once started", () => {
		const strip = at().find((l) => /of \d+ landed/.test(l)) ?? "";
		expect(strip).toMatch(/[■□·]/);
		expect(strip).not.toMatch(/[●○⠁-⣿]/);
	});
});

describe("which repository a run belongs to", () => {
	const run = `${HOME}/runs/ACME-500`;
	const fs = fixtureFs({
		[`${run}/repo.json`]: JSON.stringify({ repo: "shop-ios" }),
		[`${HOME}/runs/ACME-410/repo.json`]: JSON.stringify({ repo: "shop-web" }),
	});
	it("names it on Home beside the run's summary", () => {
		const out = frameOf([...size(120, 36)], (s) => s, fs).join("\n");
		expect(out).toMatch(/shop-ios · /);
	});
	it("leaves it off Home when every run is from one repository", () => {
		const out = frameOf([...size(120, 36)], (s) => s, fixtureFs()).join("\n");
		expect(out).not.toMatch(/acme-app · /);
	});
	it("names it on the Run page's epic row", () => {
		const out = frameOf(["ACME-500", ...size(120, 36)], (s) => s, fs);
		expect(out.find((l) => /^ +epic /.test(l))).toContain("shop-ios");
	});
	it("falls back to where the run's worktrees live", () => {
		const out = frameOf(["ACME-500", ...size(120, 36)], (s) => s, fixtureFs());
		expect(out.find((l) => /^ +epic /.test(l))).toContain("acme-app");
	});
});
