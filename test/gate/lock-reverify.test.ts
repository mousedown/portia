import { afterEach, expect, it, vi } from "vitest";

// ps is stubbed, so the test can make a verified holder's pid name another process later.
const ps = vi.hoisted(() => ({ start: "Mon Oct 19 09:00:00 2026" }));
vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	return {
		...real,
		execFileSync: ((cmd: string, ...rest: unknown[]) =>
			cmd === "ps"
				? `${ps.start}\n`
				: (real.execFileSync as (...a: unknown[]) => unknown)(
						cmd,
						...rest,
					)) as typeof real.execFileSync,
	};
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortiaProblem } from "../../src/core/exit";
import { lockHolder, withLock } from "../../src/gate/lock";

afterEach(() => vi.useRealTimers());

it("checks a verified holder's start time again, so a pid reused after it died is not waited on", async () => {
	const d = mkdtempSync(join(tmpdir(), "portia-lock-"));
	writeFileSync(
		join(d, "heavy.lock"),
		JSON.stringify({ pid: process.ppid, proc: ps.start }),
	);
	await expect(
		withLock(d, async () => 1, { timeoutMs: 30, pollMs: 5 }),
	).rejects.toBeInstanceOf(PortiaProblem);
	// The holder dies without releasing, and its pid goes to a process started later.
	ps.start = "Wed Oct 21 09:00:00 2026";
	vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
	expect(lockHolder(d, "heavy.lock")).toBeUndefined();
	vi.useRealTimers();
	expect(
		await withLock(d, async () => "ran", { timeoutMs: 200, pollMs: 5 }),
	).toBe("ran");
});
