import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/main";

const FIXTURE = join(import.meta.dirname, "../fixtures/view/home");
const MACHINE = join(import.meta.dirname, "../fixtures/view/machine.json");
const saved = process.env.PORTIA_HOME;
beforeEach(() => {
	process.env.PORTIA_HOME = FIXTURE;
	process.env.PORTIA_VIEW_MACHINE_FIXTURE = MACHINE;
});
afterEach(() => {
	if (saved === undefined) delete process.env.PORTIA_HOME;
	else process.env.PORTIA_HOME = saved;
	delete process.env.PORTIA_VIEW_MACHINE_FIXTURE;
});

async function portia(...argv: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, {
		out: (s) => out.push(s),
		err: (s) => err.push(s),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}
const NOW = ["--now", "2026-10-20T14:02:31Z"];

describe("portia view, piped", () => {
	it("prints the runs as a plain table", async () => {
		const r = await portia("view", ...NOW);
		expect(r.code).toBe(0);
		const lines = r.out.split("\n");
		expect(lines[0]).toMatch(
			/^RUN +GROUP +STATE +LANDED +TOTAL +TOKENS +PR +LAST_AT +LAST_EVENT +SUMMARY$/,
		);
		// The run waiting on the person's answer comes first.
		expect(lines[1]).toMatch(/^ACME-410 +waiting +parked +8 +9 /);
		expect(lines[2]).toMatch(
			/^ACME-500 +session +running +4 +8 +662162 +412 +2026-10-20T14:02:19.000Z +ACME-505 task gate ✓ 3\/3 +Self-serve invoices/,
		);
		expect(r.out).toMatch(
			/ACME-352 +rest +empty +- +- +- +- +- +not started +-/,
		);
		expect(r.out).not.toContain("\x1b");
		for (const l of lines) expect(l).toBe(l.trimEnd());
	});
	it("ends the runs table with a one-line machine summary", async () => {
		const r = await portia("view", ...NOW);
		const lines = r.out.split("\n");
		expect(lines.at(-2)).toBe("");
		expect(lines.at(-1)).toBe(
			"machine  acme-build-01 · Linux 6.8 · up 3d 4h · cpu 37% · load 2.1/8 · mem 41.2/64 GB (64%) · home+worktrees 312 GB free · 2 running · slots 3/5",
		);
		// A run's or a child's table is about that run alone.
		expect((await portia("view", "ACME-500", ...NOW)).out).not.toContain(
			"machine ",
		);
	});
	it("puts a machine object in the home's JSON", async () => {
		const r = await portia("view", "--json", ...NOW);
		const j = JSON.parse(r.out);
		expect(j.machine).toMatchObject({
			host: "acme-build-01",
			cores: 8,
			load: [2.1, 1.84, 1.62],
			slots: { used: 3, free: 2, cap: 5 },
		});
		expect(j.machine.history.cpu).toHaveLength(300);
		expect(j.runs).toHaveLength(6);
	});
	it("prints a run's children with the gate field", async () => {
		const r = await portia("view", "ACME-500", ...NOW);
		expect(r.out).toMatch(
			/ACME-505 +running +exit gate +2 +- +sonnet +127315 +724 +task:pass exit:running/,
		);
		expect(r.out).toMatch(
			/ACME-506 +running +working +1 +- +opus +0 +231 +task:running exit:-/,
		);
		expect(r.out).toMatch(
			/ACME-501 +landed +- +1 +415 +opus +139204 +2460 +task:pass exit:pass/,
		);
	});
	it("prints one child's rows in order, attempts numbered", async () => {
		const r = await portia("view", "ACME-500/ACME-505", ...NOW);
		const lines = r.out.split("\n");
		expect(lines[0]).toMatch(/^AT +ATTEMPT +STAGE +STATUS +DETAIL$/);
		expect(r.out).toMatch(
			/2026-10-20T13:49:40.000Z +1 +gate +fail +typecheck ✓ {2}lint ✓ {2}unit ✗/,
		);
		expect(r.out).toMatch(
			/2026-10-20T13:50:27.000Z +2 +dispatched +- +attempt 2 · sonnet/,
		);
		expect(lines.at(-1)).toMatch(/14:02:19.000Z +2 +gate +pass/);
	});
	it("prints the model as JSON", async () => {
		const r = await portia("view", "ACME-500", "ACME-505", "--json", ...NOW);
		expect(JSON.parse(r.out)).toMatchObject({
			key: "ACME-505",
			state: "running",
			phase: "exit gate",
		});
	});
	it("exits 11 for a run or child that is not there, or a bad flag", async () => {
		expect((await portia("view", "ACME-9")).err).toMatch(
			/no run ACME-9 in .*runs/,
		);
		expect((await portia("view", "ACME-9")).code).toBe(11);
		expect((await portia("view", "ACME-500", "ACME-9")).code).toBe(11);
		expect((await portia("view", "--depth", "7")).code).toBe(11);
		expect((await portia("view", "--bogus")).code).toBe(11);
	});
	it("prints one frame with --frame", async () => {
		const r = await portia(
			"view",
			"--frame",
			"--width",
			"100",
			"--height",
			"20",
			...NOW,
		);
		expect(r.out.split("\n")).toHaveLength(20);
		expect(r.out).toContain("P O R T I A");
	});
	it("never passes a control sequence from the runlog to the terminal", async () => {
		const home = mkdtempSync(join(tmpdir(), "portia-view-plain-"));
		try {
			cpSync(FIXTURE, home, { recursive: true });
			const evil = "\x1b]0;PWNED\x07\x1b[2J\x1b[31m\x1b]52;c;aGk=\x07 done";
			appendFileSync(
				join(home, "runs/ACME-366/runlog.jsonl"),
				`${JSON.stringify({
					at: "2026-10-20T11:30:00.000Z",
					child: "ACME-367",
					attempt: 1,
					stage: "result",
					status: "parked",
					data: { message: evil },
				})}\n`,
			);
			process.env.PORTIA_HOME = home;
			const r = await portia("view", "ACME-366", "ACME-367", ...NOW);
			expect(r.code).toBe(0);
			expect(r.out).toContain("PWNED");
			// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
			expect(r.out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("portia view into a slow pipe", () => {
	it("writes all of a large --json before it exits", () => {
		const home = mkdtempSync(join(tmpdir(), "portia-view-pipe-"));
		try {
			cpSync(FIXTURE, home, { recursive: true });
			const rows: string[] = [];
			for (let i = 0; i < 3000; i++)
				rows.push(
					JSON.stringify({
						at: "2026-10-20T13:00:00.000Z",
						child: "ACME-504",
						attempt: 0,
						stage: "gate",
						status: "pass",
						data: { kind: "task", steps: [{ name: "lint", ok: true }] },
					}),
				);
			appendFileSync(
				join(home, "runs/ACME-500/runlog.jsonl"),
				`${rows.join("\n")}\n`,
			);
			const main = join(import.meta.dirname, "../../src/cli/main.ts");
			const r = spawnSync(
				"sh",
				["-c", `bun "${main}" view --json | (sleep 1; cat)`],
				{
					env: { ...process.env, PORTIA_HOME: home },
					encoding: "utf8",
					maxBuffer: 64 * 1024 * 1024,
				},
			);
			expect(r.stdout.length).toBeGreaterThan(65_536);
			expect(() => JSON.parse(r.stdout)).not.toThrow();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 30_000);
});
