import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../core/atomic";
import type { Profile } from "../../core/config";
import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { PLAN_FILE } from "../../core/plan-snapshot";
import { runDir } from "../../core/rundir";
import { readRows } from "../../core/runlog";
import { gatedWaves, waveGateDue, waveOpen } from "../../core/state";
import type { ParentPlan } from "../../core/types";
import { designGate } from "../../design/check";
import { readEnv } from "../../env/env";
import { type GateReport, runGate } from "../../gate/run";
import { touchedFiles } from "../../gate/touched";
import { newTypeErrors, parseTsc } from "../../gate/typecheck";
import { runWaveGate, type WaveReport } from "../../gate/wave";
import { integrationWorktree } from "../../land/integration";
import { childLanes } from "../../plan/check";
import { ownedForGate } from "../../plan/owned";
import { inPackage, pkgRelative } from "../../plan/paths";
import { repoFiles } from "../../plan/repo";
import { parsePlanSnapshot } from "../../view/model/snapshot";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

/**
 * Incremental, with one build-info file per worktree in the run directory, so a
 * re-gate only re-checks what changed; tsc still reports every error.
 */
export const tscArgs = (dir: string, key: string) => [
	"tsc",
	"--noEmit",
	"--incremental",
	"--tsBuildInfoFile",
	join(dir, `tsc-${key}.tsbuildinfo`),
];

/**
 * A TypeScript older than 4.0 rejects `--incremental` with `--noEmit` in an
 * error that names no file, which parseTsc would read as a clean check.
 */
export const rejectsIncremental = (out: string) =>
	/^error TS\d+:.*\b(incremental|tsBuildInfoFile)\b/m.test(out);

const tsc = async (cwd: string, dir: string, key: string) => {
	const run = async (args: string[]) => {
		const r = await realExec("bunx", args, { cwd });
		return r.stdout + r.stderr;
	};
	const out = await run(tscArgs(dir, key));
	return rejectsIncremental(out) ? run(["tsc", "--noEmit"]) : out;
};

export function formatReport(report: GateReport): string {
	return report.steps
		.map((s) => {
			const uncertain = s.ok && s.tail.startsWith("design UNCERTAIN");
			const mark = !s.ok ? "FAIL" : uncertain ? "warn" : "pass";
			return `${mark}  ${s.name}${!s.ok || uncertain ? `\n${s.tail}` : ""}`;
		})
		.join("\n");
}

/** The plan dispatch recorded; one unreadable or of another shape (an older Portia) is none. */
function recordedPlan(dir: string): ParentPlan | undefined {
	try {
		return parsePlanSnapshot(readFileSync(join(dir, PLAN_FILE), "utf8"))?.plan;
	} catch {
		return undefined;
	}
}

/**
 * The wave gate after the wave `asked` names, or by default the one due, else the last wave
 * that has fully landed, so running it again after a pass reports that pass, at whatever tip
 * it passed, rather than gating a tip that moved since. Refuses a wave with a child still to
 * land.
 */
async function waveGate(
	profile: Profile,
	key: string,
	asked: string | undefined,
	io: Parameters<Command>[1],
): Promise<number> {
	if (!profile.waveGate)
		throw new PortiaProblem(
			"the profile has no waveGate: name the gates.epic steps to run between waves",
		);
	const { plan, dir } = await loadForCli(key);
	const rows = readRows(dir).rows;
	const gated = gatedWaves(plan);
	const due = asked === undefined ? waveGateDue(plan, rows) : undefined;
	const wave =
		asked !== undefined
			? Number(asked)
			: (due ??
				gated.filter((w) => !waveOpen(plan, rows, w).length).at(-1) ??
				gated[0]);
	if (wave === undefined || !plan.children.some((c) => c.wave === wave))
		throw new PortiaProblem(
			asked === undefined
				? `${plan.key} has one wave; the epic gate follows it`
				: `wave ${asked} has no children`,
		);
	const open = waveOpen(plan, rows, wave);
	if (open.length)
		throw new PortiaProblem(
			`wave ${wave} has not fully landed: ${open.join(", ")}`,
		);
	const pass =
		asked === undefined && due === undefined
			? rows
					.filter(
						(r) =>
							r.stage === "wave-gate" &&
							r.status === "pass" &&
							r.data?.wave === wave,
					)
					.at(-1)
			: undefined;
	if (pass) {
		const report: WaveReport = {
			ok: true,
			wave,
			tip: String(pass.data?.tip),
			steps: [],
			reused: true,
		};
		io.out(JSON.stringify(report));
		return EXIT.OK;
	}
	const report = await runWaveGate(
		{
			exec: realExec,
			profile,
			dir,
			plan,
			integration: integrationWorktree(profile, plan.key),
			repoRoot: process.cwd(),
		},
		wave,
	);
	io.out(JSON.stringify(report));
	return report.ok ? EXIT.OK : EXIT.PROBLEM;
}

export const gateCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	const { profile } = await cliContext();
	if (sub === "baseline" && key) {
		const dir = runDir(key);
		const out = await tsc(
			join(profile.worktreesDir, profile.repo, key, profile.packageDir),
			dir,
			key,
		);
		writeFileAtomic(
			join(dir, "baseline.json"),
			JSON.stringify([...parseTsc(out)]),
		);
		return EXIT.OK;
	}
	if (sub === "wave" && key)
		return waveGate(profile, key, flag(args, "--wave"), io);
	const parent = flag(args, "--parent")?.toUpperCase();
	if (!key || !parent)
		throw new PortiaProblem(
			"usage: portia gate baseline|wave <PARENT> | portia gate typecheck-touched|task|exit <KEY> --parent <PARENT> [--json]",
		);
	const dir = runDir(parent);
	const env = readEnv(dir, key);
	const touched = await touchedFiles(realExec, profile, env.worktree, parent);
	if (sub === "typecheck-touched") {
		const baseline = new Map<string, number>(
			JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")),
		);
		const pkgRel = touched
			.filter((f) => inPackage(f, profile.packageDir))
			.map((f) => pkgRelative(f, profile.packageDir));
		const found = newTypeErrors(
			baseline,
			parseTsc(await tsc(join(env.worktree, profile.packageDir), dir, key)),
			pkgRel,
		);
		io.out(
			found.length ? found.join("\n") : "no new type errors in touched files",
		);
		return found.length ? EXIT.PROBLEM : EXIT.OK;
	}
	if (sub !== "task" && sub !== "exit")
		throw new PortiaProblem(`unknown gate '${sub}'`);
	// A worker runs these gates again and again, so they read the plan its dispatch
	// recorded rather than the tracker: no tracker round trips, and an outage fails no
	// gate. The re-gate at land reads the tracker, so what lands is gated on the live plan.
	const recorded = recordedPlan(dir);
	const { plan, files } = recorded?.children.some((c) => c.key === key)
		? { plan: recorded, files: await repoFiles(realExec, process.cwd()) }
		: await loadForCli(parent);
	const child = plan.children.find((c) => c.key === key);
	const rows = readRows(dir).rows;
	const report = await runGate(sub, {
		exec: realExec,
		profile,
		dir,
		env,
		parent,
		touched,
		designCheck: designGate(child, { exec: realExec, profile, dir, env }),
		...ownedForGate(plan, child, rows),
		lane: childLanes(plan, files, profile, rows)?.get(key),
	});
	io.out(
		args.includes("--json") ? JSON.stringify(report) : formatReport(report),
	);
	return report.ok ? EXIT.OK : EXIT.PROBLEM;
};
