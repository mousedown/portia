import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem } from "node:os";

const MB = 1_048_576;

// os.freemem() on macOS counts only strictly free pages, which sit near zero on
// any Mac that has been up a while; inactive and speculative pages are handed
// back on demand without swapping, so they count as available too.
export function parseVmStat(out: string): number {
	const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
	const pages = (label: string) =>
		Number(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(out)?.[1]);
	const total = pages("free") + pages("inactive") + pages("speculative");
	if (!Number.isFinite(pageSize) || !Number.isFinite(total))
		throw new Error("unrecognised vm_stat output");
	return (total * pageSize) / MB;
}

export interface Mem {
	totalMb: number;
	availableMb: number;
	swapTotalMb?: number;
	swapUsedMb?: number;
	/** The figures are a cgroup's limit and use, not the whole machine's. */
	cgroup?: boolean;
}

/** /proc/meminfo: MemAvailable is what the kernel can hand out without swapping. */
export function parseMeminfo(text: string): Mem | undefined {
	const kb = (k: string) => {
		const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, "m").exec(text);
		return m ? Number(m[1]) : undefined;
	};
	const total = kb("MemTotal");
	if (total === undefined) return undefined;
	// Kernels before 3.14 have no MemAvailable: free plus the page cache is close.
	const avail =
		kb("MemAvailable") ??
		(kb("MemFree") ?? 0) + (kb("Buffers") ?? 0) + (kb("Cached") ?? 0);
	const swapTotal = kb("SwapTotal");
	const swapFree = kb("SwapFree");
	return {
		totalMb: total / 1024,
		availableMb: Math.min(total, avail) / 1024,
		...(swapTotal !== undefined && swapFree !== undefined
			? {
					swapTotalMb: swapTotal / 1024,
					swapUsedMb: (swapTotal - swapFree) / 1024,
				}
			: {}),
	};
}

/** What a cgroup allows this process: a container's --memory and --cpus, a unit's MemoryMax and CPUQuota. */
export interface Cgroup {
	memLimitMb?: number;
	/** Use against that limit, less the page cache the kernel drops first. */
	memUsedMb?: number;
	/** CPUs the quota allows, possibly fractional. */
	cpus?: number;
	/** CPU time the cgroup has used, in microseconds. */
	cpuUsageUs?: number;
}

export type ReadSys = (path: string) => string | undefined;
const ROOT = "/sys/fs/cgroup";

/** The cgroup's directory and each one above it up to the mount; then the mount itself, which a container sees as its own. */
function dirsUp(mount: string, path: string): string[] {
	const parts = path.split("/").filter(Boolean);
	const out: string[] = [];
	for (let i = parts.length; i >= 0; i--)
		out.push([mount, ...parts.slice(0, i)].join("/"));
	return out;
}
const num = (s: string | undefined) => {
	const t = (s ?? "").trim();
	const n = Number(t);
	return t !== "" && Number.isFinite(n) ? n : undefined;
};
const statField = (text: string | undefined, key: string) =>
	num(new RegExp(`^${key} (\\d+)$`, "m").exec(text ?? "")?.[1]);

/**
 * The tightest memory and CPU limit on this process's cgroup or any above it, from
 * /proc/self/cgroup: v2's memory.max and cpu.max, or v1's memory and cpu controllers.
 * Undefined with no cgroup file, as outside Linux.
 */
export function cgroupOf(read: ReadSys): Cgroup | undefined {
	const self = read("/proc/self/cgroup");
	if (!self) return undefined;
	const lines = self
		.split("\n")
		.map((l) => /^(\d+):([^:]*):(.*)$/.exec(l.trim()))
		.filter((m): m is RegExpExecArray => m !== null);
	const out: Cgroup = {};
	const v2 = lines.find((m) => m[1] === "0" && m[2] === "");
	if (v2) {
		const dirs = dirsUp(ROOT, v2[3] ?? "/");
		let limit: { mb: number; dir: string } | undefined;
		for (const d of dirs) {
			const max = num(read(`${d}/memory.max`));
			if (max !== undefined && (!limit || max / MB < limit.mb))
				limit = { mb: max / MB, dir: d };
			const [q, p] = (read(`${d}/cpu.max`) ?? "").trim().split(/\s+/);
			const quota = num(q);
			const period = num(p);
			if (quota !== undefined && period) {
				const c = quota / period;
				if (out.cpus === undefined || c < out.cpus) out.cpus = c;
			}
		}
		if (limit) {
			out.memLimitMb = limit.mb;
			const current = num(read(`${limit.dir}/memory.current`));
			const inactive =
				statField(read(`${limit.dir}/memory.stat`), "inactive_file") ?? 0;
			if (current !== undefined)
				out.memUsedMb = Math.max(0, current - inactive) / MB;
		}
		for (const d of dirs) {
			const u = statField(read(`${d}/cpu.stat`), "usage_usec");
			if (u !== undefined) {
				out.cpuUsageUs = u;
				break;
			}
		}
		return out;
	}
	const v1 = (ctl: string) =>
		lines.find((m) => (m[2] ?? "").split(",").includes(ctl))?.[3];
	const memPath = v1("memory");
	if (memPath !== undefined)
		for (const d of dirsUp(`${ROOT}/memory`, memPath)) {
			const max = num(read(`${d}/memory.limit_in_bytes`));
			if (max === undefined) continue;
			if (out.memLimitMb === undefined || max / MB < out.memLimitMb) {
				out.memLimitMb = max / MB;
				const usage = num(read(`${d}/memory.usage_in_bytes`));
				const inactive =
					statField(read(`${d}/memory.stat`), "total_inactive_file") ?? 0;
				if (usage !== undefined)
					out.memUsedMb = Math.max(0, usage - inactive) / MB;
			}
		}
	const cpuPath = v1("cpu");
	if (cpuPath !== undefined)
		for (const mount of [`${ROOT}/cpu,cpuacct`, `${ROOT}/cpu`])
			for (const d of dirsUp(mount, cpuPath)) {
				const quota = num(read(`${d}/cpu.cfs_quota_us`));
				const period = num(read(`${d}/cpu.cfs_period_us`));
				if (quota !== undefined && quota > 0 && period) {
					const c = quota / period;
					if (out.cpus === undefined || c < out.cpus) out.cpus = c;
				}
				if (out.cpuUsageUs === undefined) {
					const ns = num(read(`${d}/cpuacct.usage`));
					if (ns !== undefined) out.cpuUsageUs = ns / 1000;
				}
			}
	return out;
}

/**
 * Linux memory: MemAvailable from /proc/meminfo, narrowed to the cgroup when its
 * limit is below the machine's total. The scheduler and the view share this figure.
 */
export function linuxMemory(read: ReadSys): Mem | undefined {
	const m = parseMeminfo(read("/proc/meminfo") ?? "");
	if (!m) return undefined;
	const cg = cgroupOf(read);
	const limit = cg?.memLimitMb;
	if (limit === undefined || limit >= m.totalMb) return m;
	return {
		...m,
		totalMb: limit,
		availableMb: Math.max(
			0,
			Math.min(m.availableMb, limit - (cg?.memUsedMb ?? 0)),
		),
		cgroup: true,
	};
}

export const readSys: ReadSys = (path) => {
	try {
		return readFileSync(path, { encoding: "utf8", flag: "r" });
	} catch {
		return undefined;
	}
};

/** Memory a new worker can take without swapping: MemAvailable and the cgroup on Linux, vm_stat on macOS. */
export function availableMb(
	platform: string = process.platform,
	read: ReadSys = readSys,
): number {
	if (platform === "linux") {
		const m = linuxMemory(read);
		if (m) return m.availableMb;
	}
	if (platform === "darwin") {
		try {
			return parseVmStat(
				execFileSync("vm_stat", { encoding: "utf8", timeout: 2_000 }),
			);
		} catch {
			// fall through to the portable figure
		}
	}
	return freemem() / MB;
}
