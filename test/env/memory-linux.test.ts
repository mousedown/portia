import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { availableMb, cgroupOf, linuxMemory } from "../../src/env/memory";

const meminfo = readFileSync(
	join(import.meta.dirname, "../fixtures/view/machine/meminfo.txt"),
	"utf8",
);

describe("available memory on Linux", () => {
	it("is MemAvailable, not MemFree, so the page cache counts as free", () => {
		const read = (p: string) => (p === "/proc/meminfo" ? meminfo : undefined);
		// MemFree is 3.3 GB here; MemAvailable is 22.8 GB.
		expect(availableMb("linux", read)).toBeCloseTo(23347.5, 1);
	});
	it("is the cgroup's room when its limit is the tighter", () => {
		const files: Record<string, string> = {
			"/proc/meminfo": meminfo,
			"/proc/self/cgroup": "0::/\n",
			"/sys/fs/cgroup/memory.max": "536870912\n",
			"/sys/fs/cgroup/memory.current": "268435456\n",
		};
		const read = (p: string) => files[p];
		expect(availableMb("linux", read)).toBe(256);
		expect(linuxMemory(read)).toMatchObject({ totalMb: 512, cgroup: true });
	});
	it("has no cgroup without /proc/self/cgroup", () => {
		expect(cgroupOf(() => undefined)).toBeUndefined();
	});
});
