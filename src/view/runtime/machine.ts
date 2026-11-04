import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountStatus, accountsOf } from "../../core/accounts";
import { loadProfileFile, type Profile } from "../../core/config";
import { profilesHome } from "../../core/profile-file";
import { readRows } from "../../core/runlog";
import type { RunRow } from "../../core/types";
import { liveWorkers, MAX_AGE_MS, type Probes, probes } from "../../env/slots";
import type { ViewFs } from "../model/fs";
import {
	type MachineAccount,
	type MachineProbes,
	MachineSampler,
	type MachineSlots,
	type MachineView,
	nodeMachineProbes,
	parseMachineFixture,
} from "../model/machine";
import type { HomeView } from "../model/types";

/**
 * The profile the machine figures use, first match wins: PORTIA_PROFILE, a
 * portia.config.ts in the working directory or above it, or the only profile in
 * ~/.portia/profiles. None of them is required: without one the view uses defaults.
 */
export async function resolveViewProfile(
	env: Record<string, string | undefined>,
	cwd = process.cwd(),
): Promise<Profile | undefined> {
	const candidates: string[] = [];
	if (env.PORTIA_PROFILE) candidates.push(env.PORTIA_PROFILE);
	for (let d = cwd; ; d = dirname(d)) {
		const f = join(d, "portia.config.ts");
		if (existsSync(f)) {
			candidates.push(f);
			break;
		}
		if (dirname(d) === d) break;
	}
	try {
		const dir = profilesHome(env);
		const all = readdirSync(dir).filter((n) => n.endsWith(".ts"));
		if (all.length === 1 && all[0]) candidates.push(join(dir, all[0]));
	} catch {
		// no profiles directory
	}
	for (const f of candidates)
		try {
			return await loadProfileFile(f);
		} catch {
			// an unreadable profile is the same as none here
		}
	return undefined;
}

/** A run whose last dispatch is older than this has no live worker to look for. */
const RECENT_MS = MAX_AGE_MS;

/**
 * Worker slots for the whole machine: every run's live workers against the profile.
 * Takes the rows the caller already holds, and asks ps only about runs that
 * dispatched within a day.
 */
export function machineSlots(
	p: Profile,
	runs: RunRow[][],
	probe: Probes = probes(),
): MachineSlots | undefined {
	if (p.perWorkerMb === undefined) return undefined;
	const now = probe.now();
	const live = runs
		.filter((rows) =>
			rows.some(
				(r) => r.stage === "dispatched" && now - Date.parse(r.at) < RECENT_MS,
			),
		)
		.flatMap((rows) => liveWorkers(rows, probe));
	const starting = live.filter((w) => w.starting).length;
	const memory = Math.max(
		0,
		Math.floor((probe.freeMb() - p.minFreeMb) / p.perWorkerMb) - starting,
	);
	const used = live.length;
	return {
		used,
		free: Math.max(0, Math.min(p.waveCap - used, memory)),
		cap: p.waveCap,
		memory,
		perWorkerMb: p.perWorkerMb,
	};
}

/**
 * The profile's accounts and any usage limit each is under, from the state every run
 * shares; undefined without accounts in the profile, or when the state cannot be read.
 */
export function machineAccounts(
	p: Profile,
	home: string,
): MachineAccount[] | undefined {
	if (!p.workers.accounts.length) return undefined;
	try {
		return accountStatus(accountsOf(p.workers), { home }).map((a) => ({
			name: a.name,
			...(a.notLoggedIn
				? { notLoggedIn: true, reason: a.reason }
				: a.limitedUntil
					? { limitedUntil: a.limitedUntil, reason: a.reason }
					: {}),
		}));
	} catch {
		return undefined;
	}
}

/** The filesystems worth watching: the Portia home and where worktrees live. */
export function diskPaths(
	home: string,
	profile: Profile | undefined,
	h: HomeView | undefined,
): { label: string; path: string }[] {
	const out = [{ label: "home", path: home }];
	if (profile) out.push({ label: "worktrees", path: profile.worktreesDir });
	else {
		const tree = h?.runs
			.flatMap((r) => r.children.map((c) => c.env?.worktree))
			.find((w): w is string => typeof w === "string");
		if (tree) out.push({ label: "worktrees", path: dirname(tree) });
	}
	return out;
}

/** Every child worktree still on disk. */
export function worktreesOf(
	h: HomeView,
	fs: ViewFs,
): { key: string; path: string }[] {
	const seen = new Set<string>();
	const out: { key: string; path: string }[] = [];
	for (const r of h.runs)
		for (const c of r.children) {
			const w = c.env?.worktree;
			if (!w || seen.has(w) || !fs.exists(w)) continue;
			seen.add(w);
			out.push({ key: c.key, path: w });
		}
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One machine reading for `--frame`, `--plain` and `--json`: the fixture when
 * PORTIA_VIEW_MACHINE_FIXTURE names one, otherwise two samples 250 ms apart, so CPU
 * has a figure, plus processes, and worktree sizes only when asked for: du can take
 * seconds on a large tree.
 */
export async function machineOnce(o: {
	env: Record<string, string | undefined>;
	home: string;
	h: HomeView;
	fs: ViewFs;
	read: (path: string) => string | undefined;
	procs: boolean;
	worktrees: boolean;
	probes?: MachineProbes;
}): Promise<MachineView | undefined> {
	const fixture = o.env.PORTIA_VIEW_MACHINE_FIXTURE;
	if (fixture) return parseMachineFixture(o.read(fixture) ?? "");
	const profile = await resolveViewProfile(o.env);
	const s = new MachineSampler(o.probes ?? nodeMachineProbes, {
		disks: diskPaths(o.home, profile, o.h),
		minFreeMb: profile?.minFreeMb,
	});
	if (profile)
		try {
			s.slots = machineSlots(
				profile,
				o.h.runs.map((r) => readRows(join(o.home, "runs", r.key)).rows),
			);
		} catch {
			// no slots line
		}
	if (profile) s.accounts = machineAccounts(profile, o.home);
	// Every reading is optional: one that fails leaves its part of the view out.
	await Promise.allSettled([s.refreshDisks(0), s.refreshMemory()]);
	s.sample();
	await Promise.allSettled([
		sleep(250),
		o.procs ? s.refreshProcs(0) : undefined,
		o.worktrees ? s.refreshWorktrees(worktreesOf(o.h, o.fs), 0) : undefined,
	]);
	// A second ps gives Linux a recent CPU figure per process.
	if (o.procs) await Promise.allSettled([s.refreshProcs(0)]);
	s.sample();
	return s.view();
}
