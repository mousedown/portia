import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import {
	cpus,
	freemem,
	hostname,
	loadavg,
	release,
	totalmem,
	uptime,
} from "node:os";
import { basename, dirname } from "node:path";
import {
	type Cgroup,
	cgroupOf,
	linuxMemory,
	type Mem,
	parseVmStat,
} from "../../env/memory";

export { type Mem, parseMeminfo } from "../../env/memory";

/**
 * The machine Portia runs on: CPU, load, memory, disk and Portia's own share of it.
 * Every reading goes through `MachineProbes`, so tests feed fixtures; nothing here
 * writes, and the only programs it may start are vm_stat, sysctl, ps, nice, ionice and du.
 */

const MB = 1_048_576;

export interface CpuTimes {
	user: number;
	nice: number;
	sys: number;
	idle: number;
	irq: number;
}
export interface Statfs {
	bsize: number;
	blocks: number;
	bavail: number;
}
export interface MachineProbes {
	platform: string;
	hostname(): string;
	release(): string;
	/** Seconds since boot. */
	uptime(): number;
	cpus(): { times: CpuTimes }[];
	loadavg(): number[];
	totalmem(): number;
	freemem(): number;
	/** A small file under /proc or /sys, or undefined. */
	read(path: string): string | undefined;
	/** `vm_stat` output on macOS. */
	vmStat(): Promise<string | undefined>;
	/** `sysctl -n vm.swapusage` on macOS. */
	swapusage(): Promise<string | undefined>;
	/** May never settle on a network filesystem whose server has gone: the caller bounds it. */
	statfs(path: string): Promise<Statfs | undefined>;
	/** The device a path lives on, to tell two paths on one filesystem apart. */
	dev(path: string): number | undefined;
	/** `ps -A -o pid=,rss=,pcpu=,comm=`. */
	ps(): Promise<string | undefined>;
	/** `du -sk <path>` at the lowest CPU and I/O priority. */
	du(path: string): Promise<string | undefined>;
	now(): number;
}

/** One core's ticks: idle (with iowait), everything, and the iowait and steal in it. */
export interface Tick {
	idle: number;
	total: number;
	iowait: number;
	steal: number;
}
export interface Disk {
	/** What lives there: `home`, `worktrees`. */
	labels: string[];
	path: string;
	totalMb: number;
	freeMb: number;
	/** The last reading timed out: these figures are from before. */
	stale?: boolean;
}
export interface Proc {
	pid: number;
	name: string;
	rssMb: number;
	/** Recent %CPU, 100 being one core; undefined until a second reading on Linux. */
	cpu?: number;
}
export interface WorktreeUse {
	key: string;
	path: string;
	mb: number;
	/** du could not finish on the last pass: the size is from before. */
	stale?: boolean;
}
export interface MachineSlots {
	/** Live workers across every run. */
	used: number;
	/** Workers that could start now: the cap less those running, bounded by memory. */
	free: number;
	cap: number;
	/** Workers free memory above minFreeMb fits. */
	memory: number;
	perWorkerMb: number;
}
export interface MachineAccount {
	name: string;
	limitedUntil?: string;
	/** Not logged in, until `portia accounts clear` lifts it. */
	notLoggedIn?: boolean;
	reason?: string;
}
export interface MachineView {
	host: string;
	os: string;
	uptimeS: number;
	/** The cores the figures are against: a cgroup's CPU quota when it has one. */
	cores: number;
	at: number;
	/** Busy share since the previous sample, 0–1; absent on the first. */
	cpu?: number;
	/** The share of CPU time spent waiting on I/O, and taken by the hypervisor. */
	iowait?: number;
	steal?: number;
	perCore?: number[];
	load: [number, number, number];
	mem: { totalMb: number; availableMb: number; usedMb: number };
	swap?: { totalMb: number; usedMb: number };
	/** Which figures are a cgroup's limits rather than the machine's. */
	cgroup?: { mem?: boolean; cpu?: boolean };
	disks: Disk[];
	/** Oldest first, one point per sample; a null CPU point is the first sample. */
	history: { cpu: (number | null)[]; mem: number[]; stepMs: number };
	procs?: Proc[];
	worktrees?: WorktreeUse[];
	slots?: MachineSlots;
	/** The accounts detached workers rotate over, and any usage limit each is under. */
	accounts?: MachineAccount[];
	/** The profile's minFreeMb, when a profile was found. */
	minFreeMb?: number;
}

// ── parsing ────────────────────────────────────────────────────────────────

/** `vm.swapusage: total = 2048.00M  used = 1203.50M  free = 844.50M  (encrypted)`. */
export function parseSwapusage(
	text: string,
): { totalMb: number; usedMb: number } | undefined {
	const v = (k: string) => {
		const m = new RegExp(`${k} = ([\\d.]+)([KMG])`).exec(text);
		if (!m) return undefined;
		const n = Number(m[1]);
		return m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : n;
	};
	const total = v("total");
	const used = v("used");
	return total === undefined || used === undefined
		? undefined
		: { totalMb: total, usedMb: used };
}

/** Per-core ticks from /proc/stat's `cpuN` lines (the aggregate `cpu` line is skipped). */
export function parseProcStat(text: string): Tick[] | undefined {
	const out: Tick[] = [];
	for (const line of text.split("\n")) {
		const m = /^cpu\d+\s+(.*)$/.exec(line);
		if (!m) continue;
		// user nice system idle iowait irq softirq steal; guest time is already in user.
		// Steal arrived in 2.6.11 and iowait in 2.6; an older line simply has fewer fields.
		const f = (m[1] ?? "").trim().split(/\s+/).slice(0, 8).map(Number);
		if (f.length < 4 || f.some((n) => !Number.isFinite(n))) return undefined;
		const iowait = f[4] ?? 0;
		out.push({
			idle: (f[3] ?? 0) + iowait,
			total: f.reduce((s, n) => s + n, 0),
			iowait,
			steal: f[7] ?? 0,
		});
	}
	return out.length ? out : undefined;
}

export const ticksOf = (list: { times: CpuTimes }[]): Tick[] =>
	list.map(({ times: t }) => ({
		idle: t.idle,
		total: t.user + t.nice + t.sys + t.idle + t.irq,
		iowait: 0,
		steal: 0,
	}));

export interface Busy {
	overall: number;
	perCore: number[];
	iowait: number;
	steal: number;
}

/** Busy share per core between two readings, and overall: 1 − Δidle / Δtotal. */
export function cpuBusy(prev: Tick[], next: Tick[]): Busy | undefined {
	if (!prev.length || prev.length !== next.length) return undefined;
	let idle = 0;
	let total = 0;
	let iowait = 0;
	let steal = 0;
	const perCore = next.map((n, i) => {
		const p = prev[i] ?? n;
		const di = Math.max(0, n.idle - p.idle);
		const dt = Math.max(0, n.total - p.total);
		idle += di;
		total += dt;
		iowait += Math.max(0, n.iowait - p.iowait);
		steal += Math.max(0, n.steal - p.steal);
		return dt > 0 ? clamp01(1 - di / dt) : 0;
	});
	return {
		overall: total > 0 ? clamp01(1 - idle / total) : 0,
		perCore,
		iowait: total > 0 ? clamp01(iowait / total) : 0,
		steal: total > 0 ? clamp01(steal / total) : 0,
	};
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** `ps -A -o pid=,rss=,pcpu=,comm=`, largest resident memory first. */
export function parsePs(text: string, top = 10): Proc[] {
	const out: Proc[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line);
		if (!m) continue;
		out.push({
			pid: Number(m[1]),
			rssMb: Number(m[2]) / 1024,
			cpu: Number(m[3]),
			// macOS gives the whole path; Linux the 15-character name.
			name: basename(m[4] ?? "") || (m[4] ?? ""),
		});
	}
	return out.sort((a, b) => b.rssMb - a.rssMb || a.pid - b.pid).slice(0, top);
}

/**
 * /proc/<pid>/stat: CPU ticks used (utime + stime) and when the process started, in
 * ticks since boot. The name is in parentheses and may hold spaces, so fields count
 * from the last `)`.
 */
export function parsePidStat(
	text: string,
): { ticks: number; start: number } | undefined {
	const i = text.lastIndexOf(")");
	if (i < 0) return undefined;
	const f = text
		.slice(i + 1)
		.trim()
		.split(/\s+/);
	const ticks = Number(f[11]) + Number(f[12]);
	const start = Number(f[19]);
	return Number.isFinite(ticks) && Number.isFinite(start)
		? { ticks, start }
		: undefined;
}

/** USER_HZ: /proc counts CPU time in hundredths of a second on every mainstream build. */
const HZ = 100;

/** `du -sk` lines: kilobytes, a tab, the path. */
export function parseDu(text: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of text.split("\n")) {
		const m = /^(\d+)\s+(.+)$/.exec(line);
		if (m) out.set(m[2] ?? "", Number(m[1]) / 1024);
	}
	return out;
}

/**
 * Available memory: MemAvailable on Linux, narrowed to the cgroup's limit; free +
 * inactive + speculative on macOS, from the last vm_stat the sampler read.
 */
export function memoryOf(
	p: MachineProbes,
	darwin: { vmStat?: string; swapusage?: string } = {},
): Mem {
	if (p.platform === "linux") {
		const m = linuxMemory((path) => p.read(path));
		if (m) return m;
	}
	const totalMb = p.totalmem() / MB;
	if (p.platform === "darwin") {
		const swap = parseSwapusage(darwin.swapusage ?? "");
		const sw = swap
			? { swapTotalMb: swap.totalMb, swapUsedMb: swap.usedMb }
			: {};
		try {
			if (darwin.vmStat)
				return {
					totalMb,
					availableMb: Math.min(totalMb, parseVmStat(darwin.vmStat)),
					...sw,
				};
		} catch {
			// fall through to the portable figure
		}
		return { totalMb, availableMb: p.freemem() / MB, ...sw };
	}
	return { totalMb, availableMb: p.freemem() / MB };
}

export function ticksNow(p: MachineProbes): Tick[] {
	if (p.platform === "linux") {
		const t = parseProcStat(p.read("/proc/stat") ?? "");
		if (t) return t;
	}
	try {
		return ticksOf(p.cpus());
	} catch {
		return [];
	}
}

export function osLabel(platform: string, rel: string): string {
	if (platform === "linux")
		return `Linux ${rel.split(/[.-]/).slice(0, 2).join(".")}`.trim();
	if (platform === "darwin") return "macOS";
	return platform;
}

// ── thresholds ─────────────────────────────────────────────────────────────

export type Level = "ok" | "warn" | "critical";

/** When a figure turns amber (warn) and rose (critical), always with a ▲ before it. */
export const THRESHOLDS = {
	/** Without a profile, memory available under this share of total warns. */
	memFloorShare: 0.1,
	/** Memory under this share of the floor is critical. */
	memCriticalShare: 0.5,
	diskWarnShare: 0.1,
	diskWarnMb: 10 * 1024,
	diskCriticalShare: 0.05,
	diskCriticalMb: 5 * 1024,
	/** The 1-minute load average against the core count. */
	loadWarn: 1.5,
	loadCritical: 2,
};

/** The memory floor: the profile's minFreeMb, else 10% of total. */
export const memFloorMb = (totalMb: number, minFreeMb?: number) =>
	minFreeMb ?? totalMb * THRESHOLDS.memFloorShare;

export function memLevel(
	availableMb: number,
	totalMb: number,
	minFreeMb?: number,
): Level {
	const floor = memFloorMb(totalMb, minFreeMb);
	if (availableMb < floor * THRESHOLDS.memCriticalShare) return "critical";
	return availableMb < floor ? "warn" : "ok";
}

export function diskLevel(freeMb: number, totalMb: number): Level {
	const share = totalMb > 0 ? freeMb / totalMb : 1;
	if (
		share < THRESHOLDS.diskCriticalShare ||
		freeMb < THRESHOLDS.diskCriticalMb
	)
		return "critical";
	if (share < THRESHOLDS.diskWarnShare || freeMb < THRESHOLDS.diskWarnMb)
		return "warn";
	return "ok";
}

export function loadLevel(load1: number, cores: number): Level {
	const per = load1 / Math.max(1, cores);
	if (per > THRESHOLDS.loadCritical) return "critical";
	return per > THRESHOLDS.loadWarn ? "warn" : "ok";
}

const RANK: Record<Level, number> = { ok: 0, warn: 1, critical: 2 };
export const worst = (...l: Level[]): Level =>
	l.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok" as Level);

export interface Pressure {
	mem: Level;
	load: Level;
	/** The worst of the filesystems. */
	disk: Level;
	any: boolean;
}
export function pressureOf(m: MachineView): Pressure {
	const mem = memLevel(m.mem.availableMb, m.mem.totalMb, m.minFreeMb);
	const load = loadLevel(m.load[0], m.cores);
	const disk = worst(...m.disks.map((d) => diskLevel(d.freeMb, d.totalMb)));
	return { mem, load, disk, any: worst(mem, load, disk) !== "ok" };
}

// ── the ring and the sampler ───────────────────────────────────────────────

/** The newest `cap` values, oldest first. */
export class Ring<T> {
	private buf: T[] = [];
	private start = 0;
	constructor(readonly cap: number) {}
	push(v: T): void {
		if (this.buf.length < this.cap) this.buf.push(v);
		else {
			this.buf[this.start] = v;
			this.start = (this.start + 1) % this.cap;
		}
	}
	get size(): number {
		return this.buf.length;
	}
	values(): T[] {
		return [...this.buf.slice(this.start), ...this.buf.slice(0, this.start)];
	}
}

export const SAMPLE_MS = 2_000;
export const PROCS_MS = 10_000;
/** Filesystems change slowly, and a stuck network mount must not be asked every frame. */
export const DISK_MS = 10_000;
export const DISK_TIMEOUT_MS = 3_000;
export const DU_MS = 60_000;
/** Ten minutes of samples. */
export const HISTORY = (10 * 60_000) / SAMPLE_MS;

interface Point {
	cpu: number | null;
	mem: number;
}

const TIMEOUT = Symbol("timeout");
/** The promise, or TIMEOUT after `ms`; the promise itself carries on. */
export function within<T>(
	p: Promise<T>,
	ms: number,
): Promise<T | typeof TIMEOUT> {
	let t: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		p,
		new Promise<typeof TIMEOUT>((r) => {
			t = setTimeout(() => r(TIMEOUT), ms);
		}),
	]).finally(() => clearTimeout(t));
}
export const isTimeout = (v: unknown): v is typeof TIMEOUT => v === TIMEOUT;

/**
 * Filesystems by device, so the home and the worktrees on one disk show once. Each
 * statfs is bounded by `timeout`; one that runs out sets `timedOut` and ends the pass.
 */
export async function disksOf(
	p: MachineProbes,
	paths: { label: string; path: string }[],
	timeout = DISK_TIMEOUT_MS,
): Promise<{ disks: Disk[]; timedOut: boolean }> {
	const out: Disk[] = [];
	const byDev = new Map<string, Disk>();
	let timedOut = false;
	const stat = async (path: string) => {
		const s = await within(
			p.statfs(path).catch(() => undefined),
			timeout,
		);
		if (isTimeout(s)) {
			timedOut = true;
			return undefined;
		}
		// An automount such as macOS's /home reports no blocks: no reading, so climb on.
		return s?.blocks ? s : undefined;
	};
	for (const { label, path } of paths) {
		// A worktrees dir that does not exist yet still has a filesystem above it.
		let at = path;
		let s = await stat(at);
		while (!s && !timedOut && dirname(at) !== at) {
			at = dirname(at);
			s = await stat(at);
		}
		if (timedOut) break;
		if (!s) continue;
		const totalMb = (s.blocks * s.bsize) / MB;
		const freeMb = (s.bavail * s.bsize) / MB;
		const id = String(p.dev(at) ?? `${s.blocks}:${s.bsize}`);
		const seen = byDev.get(id);
		if (seen) {
			if (!seen.labels.includes(label)) seen.labels.push(label);
			continue;
		}
		const d: Disk = { labels: [label], path, totalMb, freeMb };
		byDev.set(id, d);
		out.push(d);
	}
	return { disks: out, timedOut };
}

export interface SamplerOpts {
	disks: { label: string; path: string }[];
	minFreeMb?: number;
	cap?: number;
}

/**
 * Samples on demand. `sample` never blocks: it reads /proc (or os) and folds in what
 * the slower, asynchronous refreshes last found. The runtime calls `sample` every 2 s
 * with `refreshDisks` and `refreshMemory` beside it, and the rest on the Machine tab.
 */
export class MachineSampler {
	private prev?: Tick[];
	private prevCg?: { us: number; at: number };
	private ring: Ring<Point>;
	private last?: MachineView;
	private procs?: Proc[];
	private procsAt = Number.NEGATIVE_INFINITY;
	private procsBusy = false;
	private procTicks = new Map<
		number,
		{ start: number; ticks: number; at: number }
	>();
	private trees?: WorktreeUse[];
	private duAt = Number.NEGATIVE_INFINITY;
	private duEvery = DU_MS;
	private duBusy = false;
	private disks: Disk[] = [];
	private disksAt = Number.NEGATIVE_INFINITY;
	private disksBusy = false;
	private darwin: { vmStat?: string; swapusage?: string } = {};
	private darwinBusy = false;
	slots?: MachineSlots;
	accounts?: MachineAccount[];

	constructor(
		private p: MachineProbes,
		public opts: SamplerOpts,
	) {
		this.ring = new Ring<Point>(opts.cap ?? HISTORY);
	}

	sample(): MachineView {
		const p = this.p;
		const ticks = ticksNow(p);
		const busy = this.prev ? cpuBusy(this.prev, ticks) : undefined;
		this.prev = ticks;
		const mem = memoryOf(p, this.darwin);
		const cg: Cgroup | undefined =
			p.platform === "linux" ? cgroupOf((x) => p.read(x)) : undefined;
		const hostCores = ticks.length || safeCores(p);
		const quota = cg?.cpus;
		const cgCpu = quota !== undefined && quota < hostCores;
		const cores = cgCpu ? Math.max(1, Math.ceil(quota)) : hostCores;
		const now = p.now();
		// Under a CPU quota the share is the cgroup's own use against what it may take.
		let cpu = busy?.overall;
		if (cgCpu && cg?.cpuUsageUs !== undefined) {
			const prev = this.prevCg;
			this.prevCg = { us: cg.cpuUsageUs, at: now };
			cpu =
				prev && now > prev.at
					? clamp01(
							(cg.cpuUsageUs - prev.us) / ((now - prev.at) * 1000 * quota),
						)
					: undefined;
		}
		const usedMb = Math.max(0, mem.totalMb - mem.availableMb);
		this.ring.push({
			cpu: cpu ?? null,
			mem: mem.totalMb > 0 ? usedMb / mem.totalMb : 0,
		});
		const pts = this.ring.values();
		const la = p.loadavg();
		const host = p.hostname().replace(/\.local$/, "");
		this.last = {
			host,
			os: osLabel(p.platform, p.release()),
			uptimeS: p.uptime(),
			cores,
			at: now,
			...(cpu !== undefined ? { cpu } : {}),
			...(busy
				? {
						iowait: busy.iowait,
						steal: busy.steal,
						// The host's cores say nothing about a cgroup's share of them.
						...(cgCpu ? {} : { perCore: busy.perCore }),
					}
				: {}),
			load: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
			mem: { totalMb: mem.totalMb, availableMb: mem.availableMb, usedMb },
			...(mem.swapTotalMb !== undefined && mem.swapTotalMb > 0
				? { swap: { totalMb: mem.swapTotalMb, usedMb: mem.swapUsedMb ?? 0 } }
				: {}),
			...(mem.cgroup || cgCpu
				? { cgroup: { mem: Boolean(mem.cgroup), cpu: cgCpu } }
				: {}),
			disks: this.disks,
			history: {
				cpu: pts.map((x) => x.cpu),
				mem: pts.map((x) => x.mem),
				stepMs: SAMPLE_MS,
			},
			...(this.opts.minFreeMb !== undefined
				? { minFreeMb: this.opts.minFreeMb }
				: {}),
		};
		return this.view() as MachineView;
	}

	/** The latest sample with the slower readings folded in. */
	view(): MachineView | undefined {
		if (!this.last) return undefined;
		const {
			procs: _p,
			worktrees: _w,
			slots: _s,
			accounts: _a,
			...rest
		} = this.last;
		return {
			...rest,
			disks: this.disks,
			...(this.procs ? { procs: this.procs } : {}),
			...(this.trees ? { worktrees: this.trees } : {}),
			...(this.slots ? { slots: this.slots } : {}),
			...(this.accounts ? { accounts: this.accounts } : {}),
		};
	}

	/** The filesystems, at most every 10 s, each statfs bounded; resolves true when they changed. */
	async refreshDisks(every = DISK_MS): Promise<boolean> {
		const now = this.p.now();
		if (this.disksBusy || now - this.disksAt < every) return false;
		this.disksBusy = true;
		this.disksAt = now;
		try {
			const { disks, timedOut } = await disksOf(this.p, this.opts.disks);
			// A stuck mount keeps the last figures, marked, rather than blanking them.
			this.disks = timedOut
				? this.disks.map((d) => ({ ...d, stale: true }))
				: disks;
			return true;
		} catch {
			return false;
		} finally {
			this.disksBusy = false;
		}
	}

	/** vm_stat and the swap on macOS, off the render thread; a no-op elsewhere. */
	async refreshMemory(): Promise<boolean> {
		if (this.p.platform !== "darwin" || this.darwinBusy) return false;
		this.darwinBusy = true;
		try {
			const [vmStat, swapusage] = await Promise.all([
				this.p.vmStat().catch(() => undefined),
				this.p.swapusage().catch(() => undefined),
			]);
			this.darwin = { vmStat, swapusage };
			return true;
		} finally {
			this.darwinBusy = false;
		}
	}

	/** Top processes by memory, at most every 10 s; resolves true when they changed. */
	async refreshProcs(every = PROCS_MS): Promise<boolean> {
		const now = this.p.now();
		if (this.procsBusy || now - this.procsAt < every) return false;
		this.procsBusy = true;
		try {
			const out = await this.p.ps();
			this.procsAt = this.p.now();
			if (typeof out !== "string" || !out) return false;
			const procs = parsePs(out);
			this.procs = this.p.platform === "linux" ? this.recentCpu(procs) : procs;
			return true;
		} catch {
			return false;
		} finally {
			this.procsBusy = false;
		}
	}

	/**
	 * Linux's ps %CPU is the process's whole life; the view wants now. Each process's
	 * CPU ticks from /proc/<pid>/stat, against the last reading of the same process (a
	 * reused pid starts later), so a figure shows from the second refresh.
	 */
	private recentCpu(procs: Proc[]): Proc[] {
		const at = this.p.now();
		const next = new Map<
			number,
			{ start: number; ticks: number; at: number }
		>();
		const out = procs.map((pr): Proc => {
			const { cpu: _lifetime, ...rest } = pr;
			const s = parsePidStat(this.p.read(`/proc/${pr.pid}/stat`) ?? "");
			if (!s) return rest;
			next.set(pr.pid, { ...s, at });
			const prev = this.procTicks.get(pr.pid);
			if (!prev || prev.start !== s.start || at <= prev.at) return rest;
			const secs = (at - prev.at) / 1000;
			return {
				...rest,
				cpu: Math.max(0, ((s.ticks - prev.ticks) / HZ / secs) * 100),
			};
		});
		this.procTicks = next;
		return out;
	}

	/**
	 * Disk use of each child worktree, one du per tree, so a hard link two trees share
	 * counts in both. At most every 60 s, and never more than a tenth of the time: a
	 * sweep that took 30 s waits 300 s. A tree du could not finish keeps its last size.
	 */
	async refreshWorktrees(
		trees: { key: string; path: string }[],
		every = this.duEvery,
	): Promise<boolean> {
		const now = this.p.now();
		if (this.duBusy || now - this.duAt < every) return false;
		this.duBusy = true;
		try {
			this.duAt = now;
			const before = new Map((this.trees ?? []).map((t) => [t.path, t]));
			const next: WorktreeUse[] = [];
			for (const t of trees) {
				const out = await this.p.du(t.path).catch(() => undefined);
				const mb =
					typeof out === "string" ? parseDu(out).get(t.path) : undefined;
				if (mb !== undefined) next.push({ ...t, mb });
				else {
					const old = before.get(t.path);
					if (old) next.push({ ...old, key: t.key, stale: true });
				}
			}
			this.duEvery = Math.max(DU_MS, 10 * (this.p.now() - now));
			this.trees = next.sort(
				(a, b) => b.mb - a.mb || a.key.localeCompare(b.key),
			);
			return true;
		} catch {
			return false;
		} finally {
			this.duBusy = false;
		}
	}
}

const safeCores = (p: MachineProbes) => {
	try {
		return p.cpus().length || 1;
	} catch {
		return 1;
	}
};

// ── the real probes ────────────────────────────────────────────────────────

/** What a child process printed, and whether the program was missing. */
export interface Ran {
	out?: string;
	missing: boolean;
}
/**
 * A program's output, never a throw. Bun hands back an empty Buffer for a missing
 * program, so only a non-empty string counts as output.
 */
export const runAsync = (
	cmd: string,
	args: string[],
	timeout: number,
): Promise<Ran> =>
	new Promise((resolve) => {
		try {
			execFile(
				cmd,
				args,
				{ encoding: "utf8", timeout, maxBuffer: 8 * MB },
				// du exits non-zero when a file vanished mid-walk; what it printed still counts.
				(err, stdout: unknown) => {
					const code = (err as { code?: unknown } | null)?.code;
					resolve({
						out:
							typeof stdout === "string" && stdout.length > 0
								? stdout
								: undefined,
						// 127: nice ran, but not the program it was to start.
						missing: code === "ENOENT" || code === 127,
					});
				},
			);
		} catch {
			resolve({ missing: true });
		}
	});

/** The output of the first of these commands that exists. */
async function firstOf(
	tries: [string, string[]][],
	timeout: number,
): Promise<string | undefined> {
	for (const [cmd, args] of tries) {
		const r = await runAsync(cmd, args, timeout);
		if (!r.missing) return r.out;
	}
	return undefined;
}

export const nodeMachineProbes: MachineProbes = {
	platform: process.platform,
	hostname,
	release,
	uptime,
	cpus,
	loadavg,
	totalmem,
	freemem,
	read(path) {
		try {
			return readFileSync(path, { encoding: "utf8", flag: "r" });
		} catch {
			return undefined;
		}
	},
	vmStat: async () => (await runAsync("vm_stat", [], 2_000)).out,
	swapusage: async () =>
		(await runAsync("sysctl", ["-n", "vm.swapusage"], 2_000)).out,
	async statfs(path) {
		try {
			const s = await statfs(path);
			return { bsize: s.bsize, blocks: s.blocks, bavail: s.bavail };
		} catch {
			return undefined;
		}
	},
	dev(path) {
		try {
			return statSync(path).dev;
		} catch {
			return undefined;
		}
	},
	ps: async () =>
		(await runAsync("ps", ["-A", "-o", "pid=,rss=,pcpu=,comm="], 5_000)).out,
	// Lowest CPU and I/O priority, so measuring never competes with the workers.
	du: (path) => {
		const du = ["du", "-sk", path];
		const tries: [string, string[]][] = [
			["nice", ["-n", "19", ...du]],
			["du", du.slice(1)],
		];
		if (process.platform === "linux")
			tries.unshift(["nice", ["-n", "19", "ionice", "-c3", ...du]]);
		return firstOf(tries, 30_000);
	},
	now: () => Date.now(),
};

/** A fixed machine for `--frame` and tests: `PORTIA_VIEW_MACHINE_FIXTURE` names its JSON. */
export function parseMachineFixture(text: string): MachineView | undefined {
	try {
		const m = JSON.parse(text) as MachineView;
		if (
			typeof m?.host !== "string" ||
			typeof m.cores !== "number" ||
			!Array.isArray(m.load) ||
			typeof m.mem?.totalMb !== "number"
		)
			return undefined;
		return {
			...m,
			disks: m.disks ?? [],
			history: m.history ?? { cpu: [], mem: [], stepMs: SAMPLE_MS },
		};
	} catch {
		return undefined;
	}
}

/** One line for piped output. */
export function machineSummary(
	m: MachineView,
	runningChildren: number,
): string {
	const parts = [
		`${m.host} · ${m.os} · up ${uptimeText(m.uptimeS)}`,
		`cpu ${pct(m.cpu)}`,
		`load ${m.load[0].toFixed(1)}/${m.cores}`,
		`mem ${pair(m.mem.usedMb, m.mem.totalMb)} (${pct(m.mem.usedMb / Math.max(1, m.mem.totalMb))})${m.cgroup?.mem ? " cgroup" : ""}`,
		...m.disks.map((d) => `${d.labels.join("+")} ${size(d.freeMb)} free`),
		`${runningChildren} running`,
		...(m.slots
			? [`slots ${m.slots.used}/${m.slots.used + m.slots.free}`]
			: []),
	];
	return `machine  ${parts.join(" · ")}`;
}

/** A share as a percentage, floored below full: 100% only ever means exactly full. */
export const pct = (f?: number | null) =>
	f === undefined || f === null || Number.isNaN(f)
		? "—"
		: f >= 1
			? "100%"
			: `${Math.max(0, Math.min(99, Math.floor(f * 100)))}%`;

/** 820 MB, 2.9 GB, 41.2 GB, 312 GB, 1.8 TB; short: 820M, 2.9G, 41G, 312G, 1.8T. */
export function size(mb: number, short = false): string {
	const gb = mb / 1024;
	if (gb < 1) return short ? `${Math.round(mb)}M` : `${Math.round(mb)} MB`;
	if (gb >= 1000) {
		const tb = (gb / 1024).toFixed(1);
		return short ? `${tb}T` : `${tb} TB`;
	}
	// One decimal below 10 in both forms, so a figure near a threshold never rounds past it.
	const n =
		gb < 10 || (gb < 100 && !short) ? gb.toFixed(1) : String(Math.round(gb));
	return short ? `${n}G` : `${n} GB`;
}

/** `41.2/64 GB`: the total drops its decimal when it is whole. */
export function pair(used: number, total: number): string {
	const t = total / 1024;
	const tt =
		Math.abs(t - Math.round(t)) < 0.05 ? String(Math.round(t)) : t.toFixed(1);
	if (t < 1) return `${Math.round(used)}/${Math.round(total)} MB`;
	return `${(used / 1024).toFixed(1)}/${tt} GB`;
}

/** 3d 4h, 5h 12m, 14m. */
export function uptimeText(s: number): string {
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	const d = Math.floor(h / 24);
	if (d) return `${d}d ${h % 24}h`;
	if (h) return `${h}h ${m % 60}m`;
	return `${m}m`;
}
