import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MachineView } from "../../../src/view/model/machine";
import { glyphs } from "../../../src/view/render/glyphs";
import { fgOf, hexOf, rgb } from "../../../src/view/render/ink";
import { bar, meter, spark, sparkText } from "../../../src/view/render/machine";
import { fixtureFs, frame, MACHINE, visible } from "../helpers";

const GB = 1024;
const file = (name: string) =>
	join(import.meta.dirname, "__frames__", `${name}.txt`);
const size = (w: number, h: number) => [
	"--width",
	String(w),
	"--height",
	String(h),
];
const sgrOf = (hex: string) => `38;2;${rgb(hex).join(";")}`;

/** The fixture home without the runs that wait on a person, so the finial can show pressure. */
const calm = () =>
	fixtureFs(
		{},
		(p) => !/runs\/ACME-(410|366)\//.test(p) && !p.endsWith("ACME-366"),
	);
const lowMem: MachineView = {
	...MACHINE,
	mem: { totalMb: 64 * GB, availableMb: 4 * GB, usedMb: 60 * GB },
};
/** Everything at once on an eight-core box: load 19.4, memory 97% used, 2.9 GB of disk free. */
const busy: MachineView = {
	...MACHINE,
	cpu: 0.98,
	load: [19.4, 17.2, 12.1],
	mem: { totalMb: 64 * GB, availableMb: 1.5 * GB, usedMb: 62.5 * GB },
	swap: { totalMb: 8 * GB, usedMb: 7.7 * GB },
	disks: [
		{
			labels: ["home", "worktrees"],
			path: "/home/acme/.portia",
			totalMb: 1024 * GB,
			freeMb: 2.9 * GB,
		},
	],
};
const fullDisk: MachineView = {
	...MACHINE,
	disks: [
		{
			labels: ["home", "worktrees"],
			path: "/home/acme/.portia",
			totalMb: 1024 * GB,
			freeMb: 3 * GB,
		},
	],
};

describe("the header's machine strip", () => {
	for (const [w, h] of [
		[120, 36],
		[110, 36],
		[100, 36],
	] as const)
		it(`sits beside the hero at ${w} columns`, async () => {
			const top = frame(size(w, h), { machine: MACHINE })
				.split("\n")
				.slice(0, 10)
				.join("\n");
			await expect(`${top}\n`).toMatchFileSnapshot(file(`strip-${w}`));
		});
	for (const [w, h] of [
		[100, 40],
		[72, 40],
	] as const)
		it(`puts the machine on the tabs row when the hero leaves it no room, at ${w}×${h}`, async () => {
			const top = frame(size(w, h)).split("\n").slice(0, 13).join("\n");
			await expect(`${top}\n`).toMatchFileSnapshot(file(`strip-${w}x${h}`));
		});
	it("sets the census and the machine flush right as one labelled grid, clear of the word", () => {
		const rows = frame(size(120, 36)).split("\n");
		// Frame row 0 is blank and row 1 holds the finial; the word starts on row 2.
		expect(rows[2]).toMatch(/runs {5}! 2 need you · \S 1 in session/);
		expect(rows[3]).toMatch(/children 2 running · 23 landed this week/);
		expect(rows[4]).toMatch(/tokens {3}7\.56M · /);
		expect(rows[6]).toMatch(/host {5}acme-build-01 · up 3d 4h/);
		expect(rows[7]).toMatch(/cpu {6}[━╸─]{8} +37% {2}load 2\.1\/8c/);
		expect(rows[8]).toMatch(/memory {3}[━╸─]{8} +64% {2}41\.2\/64 GB/);
		expect(rows[9]).toMatch(/disk {5}[━╸─]{8} +69% {2}312G free · slots 3\/5/);
		// Every label in one column, and the widest row two cells from the right edge (§9.1).
		const labels = [2, 3, 4, 6, 7, 8, 9].map((i) =>
			(rows[i] ?? "").search(/(runs|children|tokens|host|cpu|memory|disk) /),
		);
		expect(new Set(labels).size).toBe(1);
		expect(
			Math.max(
				...[2, 3, 4, 6, 7, 8, 9].map((i) => rows[i]?.trimEnd().length ?? 0),
			),
		).toBe(119);
		// Six cells at least between the word and the block.
		const word = (rows[3] ?? "").trimEnd().indexOf("╗", 60);
		const at = (rows[7] ?? "").indexOf("cpu");
		expect(at - word - 1).toBeGreaterThanOrEqual(6);
	});
	it("holds the block's left edge still whatever the figures read", () => {
		for (const w of [120, 110, 100]) {
			const cols = [MACHINE, busy].map((machine) => {
				const rows = frame(size(w, 36), { machine }).split("\n");
				const line = rows.find((l) => /\bmem(ory)? /.test(l)) ?? "";
				return line.search(/\bmem(ory)? /);
			});
			expect(cols[0]).toBeGreaterThan(0);
			expect(cols[1]).toBe(cols[0]);
			// The same rows in each: no line comes or goes with a wider value.
			const shape = [MACHINE, busy].map((machine) =>
				frame(size(w, 36), { machine })
					.split("\n")
					.slice(0, 10)
					.map((l) => /\b(cpu|mem|disk|acme-build-01)\b/.exec(l)?.[1] ?? ""),
			);
			expect(shape[1]).toEqual(shape[0]);
		}
	});
	it("lines the shares up in one column and the graphics in another", () => {
		const rows = frame(size(120, 36)).split("\n").slice(7, 10);
		expect(new Set(rows.map((r) => r.indexOf("%"))).size).toBe(1);
		const starts = rows.map((r) => r.search(/[━╸─]/));
		expect(starts[0]).toBeGreaterThan(0);
		expect(new Set(starts).size).toBe(1);
	});
	it("drops the OS and the swap, then the units, and keeps the graphics as the room goes", () => {
		// Right of the word only: the hero is drawn in blocks too.
		const at110 = frame(size(110, 36))
			.split("\n")
			.slice(0, 10)
			.map((l) => [...l].slice(68).join(""))
			.join("\n");
		// The detail goes before the graphics do.
		expect(at110).not.toMatch(/Linux|swap|load|slots/);
		expect(at110).toMatch(/cpu {2}[━╸─]{8} +37%$/m);
		expect(at110).toMatch(/disk [━╸─]{8} +69% 312G free/);
		const at100 = frame(size(100, 36)).split("\n").slice(0, 10).join("\n");
		expect(at100).toMatch(/mem {2}[━╸─]{6} +64% 41\/64G/);
		expect(at100).toMatch(/disk [━╸─]{6} +69% 312G free/);
	});
	it("gives the compact header a short tail, and drops it in order", async () => {
		// Too short for the strip, the figures ride in the header line.
		const at72 = frame(size(72, 18)).split("\n").slice(0, 4).join("\n");
		await expect(`${at72}\n`).toMatchFileSnapshot(file("strip-72"));
		expect(at72.split("\n")[0]).toMatch(
			/⠋ 1 live · ! 2 · cpu 37% · mem 64% · disk 312G free · 14:02$/,
		);
		const wide = frame(size(120, 18)).split("\n")[0];
		expect(wide).toMatch(
			/7\.56M tok · cpu 37% · mem 64% · disk 312G free · 14:02$/,
		);
		// At 60 columns the disk goes first, then the CPU; memory stays longest.
		const at60 = frame(size(60, 18)).split("\n")[0] ?? "";
		expect(at60).toMatch(/mem 64% · 14:02$/);
		expect(at60).not.toMatch(/disk/);
	});
	it("keeps the graphics in a strip under the header when the hero has no room", async () => {
		const at72 = frame(size(72, 24)).split("\n").slice(0, 5).join("\n");
		await expect(`${at72}\n`).toMatchFileSnapshot(file("strip-72x24"));
		const [head = "", strip = ""] = frame(size(120, 24)).split("\n");
		expect(head).not.toMatch(/cpu|mem|disk/);
		expect(head).toMatch(/7\.56M tok · 14:02$/);
		expect(strip).toMatch(/cpu {2}[━╸─]+ +37% load 2\.1\/8c/);
		expect(strip).toMatch(/mem {2}[━╸─]+ +64% 41\.2\/64 GB/);
		expect(strip).toMatch(/disk [━╸─]+ +69% 312G free · slots 3\/5/);
		const at60 = frame(size(60, 24)).split("\n")[1] ?? "";
		expect(at60).toMatch(/cpu +[━╸─]+.*mem +[━╸─]+.*disk +[━╸─]+/);
	});
	it("shows nothing of the machine before the first sample", () => {
		const out = frame(size(120, 36), { machine: null });
		expect(out).not.toMatch(/acme-build-01|cpu|mem /);
	});
	it("works in ASCII and without colour", () => {
		const ascii = frame([...size(120, 36), "--ascii", "--depth", "0"]);
		expect(/^[\x20-\x7e\n]*$/.test(ascii)).toBe(true);
		expect(ascii).toMatch(/memory {3}=+-+ +64% {2}41\.2\/64 GB/);
		const plain = frame([...size(120, 36), "--depth", "0"], {
			machine: lowMem,
		});
		expect(plain).not.toContain("\x1b");
	});
});

describe("thresholds", () => {
	it("turns low memory amber and a nearly full disk rose", () => {
		const mem = frame([...size(120, 36), "--depth", "24"], { machine: lowMem })
			.split("\n")
			.find((l) => /\bmemory /.test(visible(l)));
		expect(mem).toContain(`${sgrOf(hexOf("warn", "dark"))}m60.0/64 GB`);
		const disk = frame([...size(120, 36), "--depth", "24"], {
			machine: fullDisk,
		})
			.split("\n")
			.find((l) => /\bdisk {2}/.test(visible(l)));
		expect(disk).toContain(`${sgrOf(hexOf("failed", "dark"))}m3.0G`);
		// The calm fixture keeps every figure in its usual ink. (A run's bar is amber
		// while it waits on a person, so only the machine's own lines are looked at.)
		const ok = frame([...size(120, 36), "--depth", "24"])
			.split("\n")
			.filter((l) => /\b(cpu|memory|disk) {2}/.test(visible(l)));
		expect(ok.length).toBe(3);
		for (const l of ok) expect(l).not.toContain(sgrOf(hexOf("warn", "dark")));
		const tab = frame(["--page", "machine", ...size(120, 36), "--depth", "24"]);
		expect(tab).not.toContain(sgrOf(hexOf("warn", "dark")));
	});
	it("marks a figure past its threshold with ▲, so it shows without colour", () => {
		const out = frame([...size(120, 36), "--depth", "0"], { machine: busy });
		expect(out).toMatch(/cpu {6}[━╸─]+ +▲98%/);
		expect(out).toMatch(/memory {3}[━╸─]+ +▲97%/);
		expect(out).toMatch(/disk {5}[━╸─]+ +▲99% {2}2\.9G free/);
		const ascii = frame([...size(72, 18), "--depth", "0", "--ascii"], {
			machine: busy,
		});
		expect(ascii.split("\n")[0]).toMatch(/mem !97%/);
		const tab = frame(["--page", "machine", ...size(120, 36), "--depth", "0"], {
			machine: busy,
		});
		expect(tab).toMatch(/disk +▲2\.9 GB free/);
		expect(tab).toMatch(/load {3}▲19\.4/);
		expect(frame(size(120, 36), { machine: MACHINE })).not.toContain("▲");
	});
	it("keeps the finial to the run state: the machine never takes it", () => {
		const finial = (machine: MachineView, fs = calm()) =>
			frame([...size(120, 36), "--depth", "24"], { machine, fs }).split(
				"\n",
			)[1] ?? "";
		const warn = sgrOf(fgOf("warn", "dark").hex);
		expect(finial(lowMem)).not.toContain(warn);
		expect(finial(busy)).toBe(finial(MACHINE));
		expect(finial(lowMem, fixtureFs())).toContain(
			`${sgrOf(hexOf("parked", "dark"))}m◆`,
		);
	});
	it("gives amber its own code at 16 colours, apart from the accent", () => {
		const c16 = (r: "warn" | "accent" | "accentBright" | "failed") =>
			fgOf(r, "dark").c16;
		expect(c16("warn")).not.toBe(c16("accent"));
		expect(c16("warn")).not.toBe(c16("accentBright"));
		expect(c16("warn")).not.toBe(c16("failed"));
	});
});

describe("sparklines and meters", () => {
	const levels = glyphs(true).spark;
	it("puts the newest reading at the right and leaves the unread past blank", () => {
		expect(sparkText(levels, [0, 1], 4)).toBe("  ▁█");
		expect(sparkText(levels, [null, 0.5], 3)).toBe("  ▅");
		expect(sparkText(levels, [], 3)).toBe("   ");
	});
	it("averages a long window into its cells", () => {
		expect(sparkText(levels, [0, 0, 1, 1, 0.5, 0.5], 3)).toBe("▁█▅");
		expect(sparkText(levels, Array(300).fill(1), 10)).toBe("█".repeat(10));
	});
	it("draws a cell with no reading as a faint dot, never as the lowest level", () => {
		const ctx = { g: glyphs(true) } as never;
		const cells = spark(ctx, [null, null, 0], 3);
		expect(cells.map((c) => c.text).join("")).toBe("··▁");
		expect(cells[0]?.role).toBe("faint");
		const ascii = { g: glyphs(false) } as never;
		expect(
			spark(ascii, [null, 0], 2)
				.map((c) => c.text)
				.join(""),
		).toBe(" _");
	});
	it("rises visibly in ASCII", () => {
		expect(glyphs(false).spark).toEqual([
			"_",
			".",
			"-",
			"~",
			"=",
			"+",
			"*",
			"#",
		]);
	});
	it("draws a size bar with no ends and no track", () => {
		const ctx = { g: glyphs(true) } as never;
		expect(
			bar(ctx, 1, 8, "ink2")
				.map((s) => s.text)
				.join(""),
		).toBe("████████");
		expect(
			bar(ctx, 0.5, 8, "ink2")
				.map((s) => s.text)
				.join(""),
		).toBe("████    ");
	});
	it("draws a meter as a thin rule w cells wide, with a half cell at the edge", () => {
		const ctx = { g: glyphs(true) } as never;
		const text = (f: number, w: number) =>
			meter(ctx, f, w, "ink2")
				.map((s) => s.text)
				.join("");
		expect(text(0.66, 10)).toBe("━━━━━━╸───");
		expect(text(0.6, 10)).toBe("━━━━━━────");
		expect(text(0, 4)).toBe("────");
		expect(text(1.4, 4)).toBe("━━━━");
		const spans = meter(ctx, 0.5, 4, "warn");
		expect(spans[0]).toMatchObject({ text: "━━", role: "warn" });
		expect(spans[1]).toMatchObject({ text: "──", role: "faint" });
		const ascii = { g: glyphs(false) } as never;
		expect(
			meter(ascii, 0.5, 6, "ink2")
				.map((s) => s.text)
				.join(""),
		).toBe("===---");
	});
});

describe("the Machine page", () => {
	it("lays CPU, memory and disk beside workers, worktrees and processes", () => {
		const out = frame(["--page", "machine", ...size(120, 36)]).split("\n");
		expect(out[0]).toMatch(/^ {2}◆ {2}█▀█ .* {3}machine /);
		expect(out[1]).toMatch(/ 1 runs {4}2 activity {4}3 machine$/);
		expect(out[3]).toMatch(
			/^ {3}acme-build-01 · Linux 6\.8 · up 3d 4h · 8 cores$/,
		);
		const cpu = out.find((l) => /^ +cpu /.test(l)) ?? "";
		expect(cpu).toMatch(/37% {4}workers/);
		expect(out.join("\n")).toMatch(/ACME-505 +4\.1 GB/);
		expect(out.join("\n")).toMatch(/41233 +node +3\.4 GB +112%/);
	});
	it("puts Portia's own figures first at 72 columns, and says which machine", () => {
		const out = frame(["--page", "machine", ...size(72, 30)]).split("\n");
		expect(out[0]).toMatch(/^ ◆ PORTIA › machine /);
		expect(out[2]).toMatch(
			/^ {2}acme-build-01 · Linux 6\.8 · up 3d 4h · 8 cores$/,
		);
		const order = ["workers", "memory", "disk", "cpu"].map((h) =>
			out.findIndex((l) => l.includes(h)),
		);
		expect(order.every((i) => i > 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});
	it("keeps the rhythm of its sections: a figure on each heading, a label on each row", () => {
		const out = frame(["--page", "machine", ...size(120, 36)]);
		expect(out).toMatch(/disk +312 GB free/);
		expect(out).toMatch(/used {3}━+╸?─* +69%/);
		expect(out).toMatch(/free {3}312 GB of 1\.0 TB/);
		// One filesystem for the home and the worktrees needs no name line.
		expect(out).not.toMatch(/home · worktrees/);
		// Memory over the window, on its own scale, with the range beside it.
		expect(out).toMatch(/trend {2}[▁-█]+ {2}52–65%/);
		// Worktree sizes against the largest: no ends, no track, no repeated key.
		expect(out).toMatch(/ACME-505 +4\.1 GB {2}█{8}\s/);
		expect(out).not.toMatch(/\/…\/ACME-505/);
	});
	it("drops the load's note in whole parts, never mid-word", () => {
		const busy64 = { ...busy, cores: 64 };
		for (const w of [120, 100]) {
			const load =
				frame(["--page", "machine", ...size(w, 36)], { machine: busy64 })
					.split("\n")
					.find((l) => l.includes("load   ")) ?? "";
			expect(load).not.toMatch(/…/);
			expect(load).toMatch(/19\.4 {2}17\.2 {2}12\.1/);
		}
	});
	it("keeps a process's figures close to its name at 180 columns", () => {
		const out = frame(["--page", "machine", ...size(180, 36)]);
		const node = out.split("\n").find((l) => l.includes("41233")) ?? "";
		const gap = node.indexOf("3.4 GB") - node.indexOf("node");
		expect(gap).toBeLessThanOrEqual(32);
	});
	it("shows missing readings as missing, never as 0%", () => {
		const out = frame(["--page", "machine", ...size(120, 36), "--depth", "0"], {
			machine: {
				...MACHINE,
				cpu: undefined,
				perCore: undefined,
				history: { cpu: [null], mem: [0.64], stepMs: 2000 },
				procs: undefined,
				worktrees: undefined,
			},
		});
		expect(out).toMatch(/cpu +—/);
		expect(out).toMatch(/·{40}/);
		expect(out).not.toMatch(/▁{10}/);
		expect(out).toContain("no readings yet");
	});
	it("scrolls with the cursor keys at 72 columns", () => {
		const out = frame(["--page", "machine", ...size(72, 30)]);
		expect(out).toMatch(/↓ \d+ more/);
	});
	it("says it is sampling before the first reading", () => {
		const out = frame(["--page", "machine", ...size(120, 36)], {
			machine: null,
		});
		expect(out).toContain("sampling the machine…");
	});
	it("can be shown from a fixture named in the environment", () => {
		const path = "/fx/machine.json";
		const fs = fixtureFs({
			[path]: JSON.stringify({ ...MACHINE, host: "acme-env-02" }),
		});
		const out = frame(["--page", "machine"], {
			fs,
			machine: null,
			env: { PORTIA_VIEW_MACHINE_FIXTURE: path },
		});
		expect(out).toContain("acme-env-02");
	});
});
