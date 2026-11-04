import { join } from "node:path";
import { EXIT, PortiaProblem } from "../../core/exit";
import { portiaHome } from "../../core/rundir";
import { parseViewArgs, stateFor, type ViewArgs } from "../../view/args";
import { fixedMtimes, nodeFs, type ViewFs } from "../../view/model/fs";
import { readHome } from "../../view/model/home";
import {
	type MachineView,
	machineSummary,
	parseMachineFixture,
} from "../../view/model/machine";
import type { HomeView } from "../../view/model/types";
import { effectiveInk, render } from "../../view/render";
import { detectInk, type Ink, sgr } from "../../view/render/ink";
import { plainChild, plainHome, plainRun } from "../../view/render/plain";
import type { Line } from "../../view/render/text";
import { machineOnce } from "../../view/runtime/machine";
import type { Command } from "../main";

function check(a: ViewArgs, home: HomeView, where: string): void {
	if (!a.run) {
		if (a.page === "gates" || a.page === "worker")
			throw new PortiaProblem(
				`--page ${a.page} needs a ${a.page === "gates" ? "RUN" : "RUN and a CHILD"}`,
			);
		return;
	}
	if (a.page === "activity" || a.page === "machine")
		throw new PortiaProblem(`--page ${a.page} is a Home page: leave out RUN`);
	if (a.page === "gates" && a.child)
		throw new PortiaProblem("--page gates is a Run page: leave out CHILD");
	if (a.page === "worker" && !a.child)
		throw new PortiaProblem("--page worker needs a CHILD");
	const run = home.runs.find((r) => r.key === a.run);
	if (!run) throw new PortiaProblem(`no run ${a.run} in ${where}`);
	if (a.child && !run.children.some((c) => c.key === a.child))
		throw new PortiaProblem(`no child ${a.child} in run ${a.run}`);
}

/** Trailing blanks go, except under the selection's background. */
function trimLine(l: Line, depth: number): Line {
	const out = [...l];
	while (out.length) {
		const last = out.at(-1);
		if (!last || (last.sel && depth > 0)) break;
		const t = last.text.replace(/\s+$/, "");
		if (t) {
			out[out.length - 1] = { ...last, text: t };
			break;
		}
		out.pop();
	}
	return out;
}

export function frameText(
	a: ViewArgs,
	opts: {
		fs: ViewFs;
		home: string;
		env: Record<string, string | undefined>;
		isTTY: boolean;
		/** The machine to show; without one, PORTIA_VIEW_MACHINE_FIXTURE, else none. */
		machine?: MachineView;
	},
): string {
	const now = a.now ?? Date.now();
	const home = readHome(opts.fs, opts.home, now);
	check(a, home, tildeRuns(opts.home, opts.env));
	const ink: Ink = {
		...detectInk(opts.env, opts.isTTY, undefined, {
			depth: a.depth ?? (opts.isTTY ? undefined : 0),
			theme: a.theme,
			ascii: a.ascii,
		}),
		motion: !a.noMotion,
	};
	const size = { cols: a.width ?? 120, rows: a.height ?? 36 };
	const state = stateFor(a, home, now);
	const fixture = opts.env.PORTIA_VIEW_MACHINE_FIXTURE;
	const machine =
		opts.machine ??
		(fixture ? parseMachineFixture(opts.fs.read(fixture) ?? "") : undefined);
	const out = render(state, { home, machine }, ink, size, {
		now,
		frozen: true,
	});
	return out.spans
		.map((l) => sgr(trimLine(l, ink.depth), effectiveInk(ink, state)))
		.join("\n");
}

const tildeRuns = (home: string, env: Record<string, string | undefined>) => {
	const h = env.HOME ?? "";
	const runs = join(home, "runs");
	return h && runs.startsWith(h) ? `~${runs.slice(h.length)}` : runs;
};

export const viewCommand: Command = async (args, io) => {
	const isTTY = Boolean(process.stdout.isTTY);
	// The live view needs both ends: with input from a pipe or /dev/null it prints plain.
	const a = parseViewArgs(args, isTTY && Boolean(process.stdin.isTTY));
	const env = process.env;
	const home = portiaHome(env);
	const now = a.now ?? Date.now();
	const machineFor = (h: HomeView, procs: boolean, worktrees: boolean) =>
		machineOnce({
			env,
			home,
			h,
			fs: nodeFs,
			read: nodeFs.read,
			procs,
			worktrees,
		});
	if (a.mode === "frame") {
		const fs = fixedMtimes(nodeFs, home);
		// Home, Machine and the Run page show the machine; the Machine page also lists processes.
		const machine =
			a.child || env.PORTIA_VIEW_MACHINE_FIXTURE
				? undefined
				: await machineFor(
						readHome(fs, home, now),
						a.page === "machine",
						a.page === "machine",
					);
		io.out(frameText(a, { fs, home, env, isTTY, machine }));
		return EXIT.OK;
	}
	if (a.mode === "plain" || a.mode === "json") {
		const h = readHome(nodeFs, home, now);
		check(a, h, tildeRuns(home, env));
		const run = h.runs.find((r) => r.key === a.run);
		const child = run?.children.find((c) => c.key === a.child);
		const machine = run
			? undefined
			: await machineFor(h, a.mode === "json", false);
		if (a.mode === "json")
			io.out(JSON.stringify(child ?? run ?? { ...h, machine }, null, 2));
		else if (child) io.out(plainChild(child));
		else if (run) io.out(plainRun(run));
		else
			io.out(
				machine
					? `${plainHome(h)}\n\n${machineSummary(machine, h.runningChildren)}`
					: plainHome(h),
			);
		return EXIT.OK;
	}
	const { runView } = await import("../../view/runtime/loop");
	return runView({ args: a, home, env });
};
