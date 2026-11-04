import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	cpuBusy,
	DU_MS,
	diskLevel,
	disksOf,
	HISTORY,
	loadLevel,
	type MachineProbes,
	MachineSampler,
	machineSummary,
	memLevel,
	memoryOf,
	PROCS_MS,
	pair,
	parseDu,
	parseMachineFixture,
	parseMeminfo,
	parsePidStat,
	parseProcStat,
	parsePs,
	parseSwapusage,
	pct,
	pressureOf,
	Ring,
	runAsync,
	SAMPLE_MS,
	size,
	ticksOf,
	uptimeText,
} from "../../../src/view/model/machine";
import { MACHINE } from "../helpers";

const FX = join(import.meta.dirname, "../../fixtures/view/machine");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");
const GB = 1024;

/** A Linux box from the fixtures, with /proc/stat moving on one reading per sample. */
function linux(o: Partial<MachineProbes> = {}): MachineProbes & {
	clock: { t: number };
	calls: { ps: number; du: number };
} {
	const stats = [fx("stat-1.txt"), fx("stat-2.txt")];
	let reads = 0;
	const clock = { t: Date.parse("2026-10-20T14:00:00Z") };
	const calls = { ps: 0, du: 0 };
	return {
		platform: "linux",
		hostname: () => "acme-build-01",
		release: () => "6.8.0-45-generic",
		uptime: () => 3 * 86400 + 4 * 3600 + 120,
		cpus: () => {
			throw new Error("Linux reads /proc/stat");
		},
		loadavg: () => [2.1, 1.84, 1.62],
		totalmem: () => 64 * GB * 1_048_576,
		freemem: () => 3 * GB * 1_048_576,
		read: (path) =>
			path === "/proc/meminfo"
				? fx("meminfo.txt")
				: path === "/proc/stat"
					? stats[Math.min(reads++, 1)]
					: undefined,
		vmStat: async () => undefined,
		swapusage: async () => undefined,
		statfs: async (path) =>
			path.startsWith("/home/acme") && !path.includes("not-yet")
				? { bsize: 4096, blocks: 268_435_456, bavail: 81_788_928 }
				: path === "/mnt/scratch"
					? { bsize: 4096, blocks: 26_214_400, bavail: 1_310_720 }
					: undefined,
		dev: (path) => (path.startsWith("/mnt") ? 2 : 1),
		ps: async () => {
			calls.ps++;
			return fx("ps-linux.txt");
		},
		du: async (path) => {
			calls.du++;
			const line = fx("du.txt")
				.split("\n")
				.find((l) => l.endsWith(`\t${path}`));
			return line ? `${line}\n` : undefined;
		},
		now: () => clock.t,
		clock,
		calls,
		...o,
	};
}

describe("parsing the machine", () => {
	it("reads MemAvailable and swap from /proc/meminfo", () => {
		const m = parseMeminfo(fx("meminfo.txt"));
		expect(m?.totalMb).toBeCloseTo(64299.06, 1);
		// MemAvailable, not MemFree: the page cache comes back on demand.
		expect(m?.availableMb).toBeCloseTo(23347.5, 1);
		expect(m?.swapTotalMb).toBeCloseTo(8192, 0);
		expect(m?.swapUsedMb).toBeCloseTo(205, 0);
	});
	it("falls back to free plus the page cache on kernels without MemAvailable", () => {
		const m = parseMeminfo(
			"MemTotal: 1048576 kB\nMemFree: 102400 kB\nBuffers: 51200 kB\nCached: 204800 kB\n",
		);
		expect(m?.availableMb).toBe(350);
		expect(m?.swapTotalMb).toBeUndefined();
		expect(parseMeminfo("nonsense")).toBeUndefined();
	});
	it("reads per-core ticks from /proc/stat, iowait counted as idle", () => {
		const t = parseProcStat(fx("stat-1.txt"));
		expect(t).toHaveLength(8);
		expect(t?.[0]).toEqual({
			idle: 9898504 + 15011,
			total: 590112 + 166 + 147320 + 9898504 + 15011 + 0 + 21004 + 0,
			iowait: 15011,
			steal: 0,
		});
		expect(parseProcStat("intr 1 2 3")).toBeUndefined();
	});
	it("parses macOS swap usage", () => {
		expect(parseSwapusage(fx("swapusage.txt"))).toEqual({
			totalMb: 2048,
			usedMb: 1203.5,
		});
		expect(parseSwapusage("total = 1.50G  used = 512.00K")).toEqual({
			totalMb: 1536,
			usedMb: 0.5,
		});
	});
	it("ranks processes by resident memory and names them by their last path part", () => {
		const linuxTop = parsePs(fx("ps-linux.txt"), 3);
		expect(linuxTop.map((p) => [p.pid, p.name])).toEqual([
			[41233, "node"],
			[41018, "bun"],
			[40877, "claude"],
		]);
		expect(linuxTop[0]?.cpu).toBe(112.3);
		const mac = parsePs(fx("ps-darwin.txt"));
		expect(mac[0]).toMatchObject({ pid: 4401, name: "bun", rssMb: 2048 });
		expect(mac[1]?.name).toBe("Acme Browser");
	});
	it("parses du -sk", () => {
		const d = parseDu(fx("du.txt"));
		expect(d.get("/home/acme/.portia/worktrees/acme-app/ACME-505")).toBe(4100);
	});
});

describe("CPU from tick deltas", () => {
	it("is 1 − Δidle / Δtotal, per core and overall", () => {
		const a = parseProcStat(fx("stat-1.txt")) ?? [];
		const b = parseProcStat(fx("stat-2.txt")) ?? [];
		const busy = cpuBusy(a, b);
		expect(busy?.overall).toBeCloseTo(600 / 1830, 6);
		expect(busy?.perCore[0]).toBeCloseTo(60 / 260, 6);
		// cpu2 never idled between the readings.
		expect(busy?.perCore[2]).toBe(1);
		expect(busy?.perCore[4]).toBeCloseTo(20 / 210, 6);
	});
	it("has no figure without two readings of the same cores, and none from a still clock", () => {
		const t = [{ idle: 10, total: 20, iowait: 0, steal: 0 }];
		expect(cpuBusy([], t)).toBeUndefined();
		expect(cpuBusy(t, [...t, ...t])).toBeUndefined();
		expect(cpuBusy(t, t)).toEqual({
			overall: 0,
			perCore: [0],
			iowait: 0,
			steal: 0,
		});
	});
	it("reads os.cpus() times the same way", () => {
		const times = { user: 30, nice: 0, sys: 10, idle: 60, irq: 0 };
		expect(ticksOf([{ times }])).toEqual([
			{ idle: 60, total: 100, iowait: 0, steal: 0 },
		]);
	});
});

describe("memory per platform", () => {
	it("uses /proc/meminfo on Linux, not freemem", () => {
		const m = memoryOf(linux());
		expect(m.availableMb).toBeCloseTo(23347.5, 1);
	});
	it("uses Portia's reclaimable figure on macOS, with sysctl's swap", () => {
		const p = linux({
			platform: "darwin",
			read: () => undefined,
			totalmem: () => 48 * GB * 1_048_576,
		});
		const m = memoryOf(p, {
			vmStat: fx("vm_stat.txt"),
			swapusage: fx("swapusage.txt"),
		});
		expect(m.totalMb).toBe(48 * GB);
		expect(m.availableMb).toBeCloseTo((1244646 * 16384) / 1_048_576, 3);
		expect(m.swapUsedMb).toBe(1203.5);
	});
	it("falls back to freemem when vm_stat says nothing it knows", () => {
		const p = linux({ platform: "darwin" });
		expect(memoryOf(p, { vmStat: "garbage" }).availableMb).toBe(3 * GB);
	});
});

describe("the ring", () => {
	it("keeps the newest cap values, oldest first", () => {
		const r = new Ring<number>(3);
		for (const n of [1, 2]) r.push(n);
		expect(r.values()).toEqual([1, 2]);
		for (const n of [3, 4, 5]) r.push(n);
		expect(r.values()).toEqual([3, 4, 5]);
		expect(r.size).toBe(3);
		r.push(6);
		expect(r.values()).toEqual([4, 5, 6]);
	});
	it("holds ten minutes of 2-second samples", () => {
		expect(HISTORY * SAMPLE_MS).toBe(10 * 60_000);
	});
});

describe("the sampler", () => {
	const disks = [
		{ label: "home", path: "/home/acme/.portia" },
		{ label: "worktrees", path: "/home/acme/.portia/worktrees/not-yet" },
	];
	it("shows no CPU on the first sample and a figure from the second", () => {
		const s = new MachineSampler(linux(), { disks });
		const first = s.sample();
		expect(first.cpu).toBeUndefined();
		expect(first.history.cpu).toEqual([null]);
		const second = s.sample();
		expect(second.cpu).toBeCloseTo(600 / 1830, 6);
		expect(second.perCore).toHaveLength(8);
		expect(second.history.cpu).toHaveLength(2);
		expect(second).toMatchObject({
			host: "acme-build-01",
			os: "Linux 6.8",
			cores: 8,
			load: [2.1, 1.84, 1.62],
		});
		expect(second.swap?.usedMb).toBeCloseTo(205, 0);
	});
	it("shows one filesystem once, whatever lives on it, and climbs to a path that exists", async () => {
		const { disks: d } = await disksOf(linux(), [
			...disks,
			{ label: "scratch", path: "/mnt/scratch" },
		]);
		expect(d).toHaveLength(2);
		expect(d[0]?.labels).toEqual(["home", "worktrees"]);
		expect(d[0]?.totalMb).toBe(1024 * GB);
		expect(d[0]?.freeMb).toBe(312 * GB);
		expect(d[1]).toMatchObject({ labels: ["scratch"], freeMb: 5 * GB });
	});
	it("climbs past a mount that reports no blocks, as macOS's /home does", async () => {
		const statfs = async (path: string) =>
			path === "/home"
				? { blocks: 0, bavail: 0, bsize: 4096 }
				: path === "/"
					? { blocks: 1024, bavail: 512, bsize: 1024 * 1024 }
					: undefined;
		const { disks: d } = await disksOf(
			linux({ statfs, dev: () => undefined }),
			[{ label: "worktrees", path: "/home/acme/worktrees" }],
		);
		expect(d).toEqual([
			{
				labels: ["worktrees"],
				path: "/home/acme/worktrees",
				totalMb: 1024,
				freeMb: 512,
			},
		]);
	});
	it("shows no disk where statfs is unsupported", async () => {
		expect(
			(await disksOf(linux({ statfs: async () => undefined }), disks)).disks,
		).toEqual([]);
	});
	it("caps its history", () => {
		const s = new MachineSampler(linux(), { disks, cap: 4 });
		for (let i = 0; i < 6; i++) s.sample();
		expect(s.view()?.history.cpu).toHaveLength(4);
	});
	it("runs ps at most every 10 s, and du at most every 60 s", async () => {
		const p = linux();
		const s = new MachineSampler(p, { disks });
		s.sample();
		const trees = [
			{
				key: "ACME-505",
				path: "/home/acme/.portia/worktrees/acme-app/ACME-505",
			},
			{
				key: "ACME-506",
				path: "/home/acme/.portia/worktrees/acme-app/ACME-506",
			},
			{ key: "ACME-999", path: "/gone" },
		];
		expect(await s.refreshProcs()).toBe(true);
		expect(await s.refreshWorktrees(trees)).toBe(true);
		p.clock.t += PROCS_MS - 1;
		expect(await s.refreshProcs()).toBe(false);
		p.clock.t += 1;
		expect(await s.refreshProcs()).toBe(true);
		p.clock.t += DU_MS - PROCS_MS;
		expect(await s.refreshWorktrees(trees)).toBe(true);
		// One du per tree, so a hard link two trees share counts in each.
		expect(p.calls).toEqual({ ps: 2, du: 6 });
		const v = s.view();
		expect(v?.procs?.[0]?.name).toBe("node");
		// A worktree du did not report has gone; it is not shown at 0.
		expect(v?.worktrees?.map((w) => [w.key, w.mb])).toEqual([
			["ACME-505", 4100],
			["ACME-506", 3900],
		]);
	});
});

describe("thresholds", () => {
	it("warns on memory under the profile's floor, and is critical under half of it", () => {
		expect(memLevel(8 * GB, 64 * GB, 6 * GB)).toBe("ok");
		expect(memLevel(5 * GB, 64 * GB, 6 * GB)).toBe("warn");
		expect(memLevel(2.9 * GB, 64 * GB, 6 * GB)).toBe("critical");
	});
	it("uses 10% of memory as the floor without a profile", () => {
		expect(memLevel(6.5 * GB, 64 * GB)).toBe("ok");
		expect(memLevel(6.3 * GB, 64 * GB)).toBe("warn");
		expect(memLevel(3 * GB, 64 * GB)).toBe("critical");
	});
	it("warns on disk under 10% or 10 GB free, critical under 5% or 5 GB", () => {
		expect(diskLevel(312 * GB, 1024 * GB)).toBe("ok");
		expect(diskLevel(90 * GB, 1024 * GB)).toBe("warn");
		expect(diskLevel(9 * GB, 50 * GB)).toBe("warn");
		expect(diskLevel(40 * GB, 1024 * GB)).toBe("critical");
		expect(diskLevel(4 * GB, 20 * GB)).toBe("critical");
	});
	it("warns on a load over 1.5× the cores, critical over 2×", () => {
		expect(loadLevel(12, 8)).toBe("ok");
		expect(loadLevel(12.1, 8)).toBe("warn");
		expect(loadLevel(16.1, 8)).toBe("critical");
	});
	it("is under pressure when any figure is", () => {
		expect(pressureOf(MACHINE).any).toBe(false);
		const low = {
			...MACHINE,
			mem: { ...MACHINE.mem, availableMb: 5 * GB, usedMb: 59 * GB },
		};
		expect(pressureOf(low)).toMatchObject({ mem: "warn", any: true });
		const full = {
			...MACHINE,
			disks: [
				{
					labels: ["home"],
					path: "/home/acme/.portia",
					totalMb: 1024 * GB,
					freeMb: 8 * GB,
				},
			],
		};
		expect(pressureOf(full)).toMatchObject({ disk: "critical", any: true });
	});
});

describe("formats and the fixture", () => {
	it("writes sizes the way the view shows them", () => {
		expect(size(820)).toBe("820 MB");
		expect(size(41.2 * GB)).toBe("41.2 GB");
		expect(size(312 * GB)).toBe("312 GB");
		expect(size(1843 * GB)).toBe("1.8 TB");
		expect(size(312 * GB, true)).toBe("312G");
		expect(pair(41.2 * GB, 64 * GB)).toBe("41.2/64 GB");
		expect(pair(3.1 * GB, 7.7 * GB)).toBe("3.1/7.7 GB");
		expect(uptimeText(3 * 86400 + 4 * 3600 + 59)).toBe("3d 4h");
		expect(uptimeText(5 * 3600 + 12 * 60)).toBe("5h 12m");
	});
	it("rejects a fixture that is not a machine", () => {
		expect(parseMachineFixture("{}")).toBeUndefined();
		expect(parseMachineFixture("not json")).toBeUndefined();
		expect(parseMachineFixture(JSON.stringify(MACHINE))?.host).toBe(
			"acme-build-01",
		);
	});
	it("sums the machine up in one line", () => {
		expect(
			machineSummary({ ...MACHINE, slots: undefined, cpu: undefined }, 0),
		).toBe(
			"machine  acme-build-01 · Linux 6.8 · up 3d 4h · cpu — · load 2.1/8 · mem 41.2/64 GB (64%) · home+worktrees 312 GB free · 0 running",
		);
	});
});

describe("readings that fail", () => {
	const disks = [{ label: "home", path: "/home/acme/.portia" }];
	it("treats a missing ps as no reading, even when it hands back a Buffer", async () => {
		for (const ps of [
			async () => Buffer.alloc(0) as unknown as string,
			async () => {
				throw new Error("spawn ps ENOENT");
			},
			async () => "",
		]) {
			const s = new MachineSampler(linux({ ps }), { disks });
			s.sample();
			expect(await s.refreshProcs(0)).toBe(false);
			expect(s.view()?.procs).toBeUndefined();
		}
	});
	it("runs a missing program to no output and says it is missing", async () => {
		const r = await runAsync("portia-no-such-program", [], 1_000);
		expect(r).toEqual({ out: undefined, missing: true });
	});
	it("keeps the last disk figures, marked, when statfs stops answering", async () => {
		let hang = false;
		const p = linux({
			statfs: (path) =>
				hang
					? new Promise(() => {})
					: Promise.resolve(
							path.startsWith("/home/acme")
								? { bsize: 4096, blocks: 268_435_456, bavail: 81_788_928 }
								: undefined,
						),
		});
		const s = new MachineSampler(p, { disks });
		await s.refreshDisks(0);
		expect(s.sample().disks[0]?.freeMb).toBe(312 * GB);
		hang = true;
		vi.useFakeTimers();
		try {
			const pending = s.refreshDisks(0);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await pending).toBe(true);
		} finally {
			vi.useRealTimers();
		}
		expect(s.sample().disks[0]).toMatchObject({
			freeMb: 312 * GB,
			stale: true,
		});
	});
	it("keeps a worktree's last size when du cannot finish, and backs off after a slow sweep", async () => {
		const p = linux();
		const tree = {
			key: "ACME-505",
			path: "/home/acme/.portia/worktrees/acme-app/ACME-505",
		};
		const s = new MachineSampler(p, { disks });
		s.sample();
		expect(await s.refreshWorktrees([tree], 0)).toBe(true);
		const slow = linux({
			du: async () => {
				slow.clock.t += 30_000;
				return undefined;
			},
		});
		const t = new MachineSampler(slow, { disks });
		await t.refreshWorktrees([tree], 0);
		expect(t.view()).toBeUndefined();
		// 30 s of du waits ten times that before the next sweep.
		slow.clock.t += 60_000;
		expect(await t.refreshWorktrees([tree])).toBe(false);
		slow.clock.t += 210_000;
		expect(await t.refreshWorktrees([tree])).toBe(true);
		p.du = async () => undefined;
		p.clock.t += DU_MS;
		await s.refreshWorktrees([tree]);
		expect(s.view()?.worktrees).toEqual([{ ...tree, mb: 4100, stale: true }]);
	});
});

describe("recent CPU per process on Linux", () => {
	const stat = (ticks: number, start = 5000) =>
		`41233 (node worker) S 1 41233 41233 0 -1 4194560 0 0 0 0 ${ticks - 20} 20 0 0 20 0 12 0 ${start} 0 0`;
	it("reads utime, stime and the start time past a name with spaces", () => {
		expect(parsePidStat(stat(500))).toEqual({ ticks: 500, start: 5000 });
		expect(parsePidStat("garbage")).toBeUndefined();
	});
	it("shows the share since the last ps, not the process's lifetime", async () => {
		let ticks = 1000;
		let start = 5000;
		const p = linux({
			read: (path) =>
				path === "/proc/41233/stat"
					? stat(ticks, start)
					: path === "/proc/meminfo"
						? fx("meminfo.txt")
						: path === "/proc/stat"
							? fx("stat-1.txt")
							: undefined,
		});
		const s = new MachineSampler(p, { disks: [] });
		s.sample();
		await s.refreshProcs(0);
		// ps says 112% over its life; there is no recent figure yet.
		expect(s.view()?.procs?.[0]?.pid).toBe(41233);
		expect(s.view()?.procs?.[0]?.cpu).toBeUndefined();
		p.clock.t += 10_000;
		ticks += 250;
		await s.refreshProcs(0);
		expect(s.view()?.procs?.[0]?.cpu).toBeCloseTo(25, 6);
		// A reused pid starts later: no figure from the old process's ticks.
		p.clock.t += 10_000;
		start = 9000;
		await s.refreshProcs(0);
		expect(s.view()?.procs?.[0]?.cpu).toBeUndefined();
	});
});

describe("iowait and steal", () => {
	it("are their own shares of the CPU time between two readings", () => {
		const a = [{ idle: 100, total: 200, iowait: 10, steal: 0 }];
		const b = [{ idle: 150, total: 400, iowait: 40, steal: 20 }];
		expect(cpuBusy(a, b)).toMatchObject({
			overall: 0.75,
			iowait: 0.15,
			steal: 0.1,
		});
	});
	it("show on the sample", () => {
		const s = new MachineSampler(linux(), { disks: [] });
		s.sample();
		const v = s.sample();
		expect(v.iowait).toBeGreaterThanOrEqual(0);
		expect(v.steal).toBe(0);
	});
});

describe("a cgroup's limits", () => {
	const v2 = (files: Record<string, string>) =>
		linux({
			read: (path) =>
				files[path] ??
				(path === "/proc/meminfo"
					? fx("meminfo.txt")
					: path === "/proc/stat"
						? fx("stat-1.txt")
						: undefined),
		});
	const container = {
		"/proc/self/cgroup": "0::/\n",
		"/sys/fs/cgroup/memory.max": "536870912\n",
		"/sys/fs/cgroup/memory.current": "402653184\n",
		"/sys/fs/cgroup/memory.stat": "anon 300000000\ninactive_file 134217728\n",
		"/sys/fs/cgroup/cpu.max": "100000 100000\n",
		"/sys/fs/cgroup/cpu.stat": "usage_usec 1000000\n",
	};
	it("narrows memory and cores to a container's --memory and --cpus", () => {
		const m = new MachineSampler(v2(container), { disks: [] }).sample();
		expect(m.mem.totalMb).toBe(512);
		// Use less the page cache it would drop: 384 − 128 = 256 MB in use.
		expect(m.mem.availableMb).toBe(256);
		expect(m.cores).toBe(1);
		expect(m.cgroup).toEqual({ mem: true, cpu: true });
		expect(m.perCore).toBeUndefined();
	});
	it("takes the tightest limit up the tree, as a systemd unit in a slice has", () => {
		const unit = {
			"/proc/self/cgroup": "0::/portia.slice/run.service\n",
			"/sys/fs/cgroup/portia.slice/run.service/memory.max": "max\n",
			"/sys/fs/cgroup/portia.slice/memory.max": "8589934592\n",
			"/sys/fs/cgroup/portia.slice/memory.current": "4294967296\n",
			"/sys/fs/cgroup/portia.slice/run.service/cpu.max": "max 100000\n",
			"/sys/fs/cgroup/portia.slice/cpu.max": "250000 100000\n",
		};
		const m = new MachineSampler(v2(unit), { disks: [] }).sample();
		expect(m.mem.totalMb).toBe(8192);
		expect(m.mem.availableMb).toBe(4096);
		expect(m.cores).toBe(3);
	});
	it("reads cgroup v1's memory and CFS quota", () => {
		const v1 = {
			"/proc/self/cgroup": "12:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n",
			"/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": "1073741824\n",
			"/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes": "536870912\n",
			"/sys/fs/cgroup/memory/docker/abc/memory.stat": "total_inactive_file 0\n",
			"/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_quota_us": "200000\n",
			"/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_period_us": "100000\n",
		};
		const m = new MachineSampler(v2(v1), { disks: [] }).sample();
		expect(m.mem).toMatchObject({ totalMb: 1024, availableMb: 512 });
		expect(m.cores).toBe(2);
	});
	it("leaves the machine's figures alone when the limit is above them", () => {
		const m = new MachineSampler(
			v2({
				"/proc/self/cgroup": "0::/user.slice\n",
				"/sys/fs/cgroup/user.slice/memory.max": "max\n",
			}),
			{ disks: [] },
		).sample();
		expect(m.mem.totalMb).toBeCloseTo(64299.06, 1);
		expect(m.cores).toBe(8);
		expect(m.cgroup).toBeUndefined();
	});
	it("measures CPU as the cgroup's own use against its quota", () => {
		let us = 1_000_000;
		const files = { ...container };
		const p = linux({
			read: (path) =>
				path === "/sys/fs/cgroup/cpu.stat"
					? `usage_usec ${us}\n`
					: ((files as Record<string, string>)[path] ??
						(path === "/proc/meminfo"
							? fx("meminfo.txt")
							: path === "/proc/stat"
								? fx("stat-1.txt")
								: undefined)),
		});
		const s = new MachineSampler(p, { disks: [] });
		expect(s.sample().cpu).toBeUndefined();
		p.clock.t += 2_000;
		us += 1_000_000;
		expect(s.sample().cpu).toBeCloseTo(0.5, 6);
	});
});

describe("figures near their thresholds", () => {
	it("never round a share up to full", () => {
		expect(pct(0.997)).toBe("99%");
		expect(pct(1)).toBe("100%");
		expect(pct(0.376)).toBe("37%");
		expect(pct(undefined)).toBe("—");
	});
	it("keep a decimal below 10 GB in the short form", () => {
		expect(size(2.9 * GB, true)).toBe("2.9G");
		expect(size(2.9 * GB)).toBe("2.9 GB");
		expect(size(41.2 * GB, true)).toBe("41G");
	});
});
