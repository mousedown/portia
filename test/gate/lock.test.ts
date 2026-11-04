import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PortiaProblem } from "../../src/core/exit";
import { lockHolder, withLock, withLockSync } from "../../src/gate/lock";

const dir = () => mkdtempSync(join(tmpdir(), "portia-lock-"));

it("runs one holder at a time", async () => {
	const d = dir();
	const order: string[] = [];
	const slow = (n: string) =>
		withLock(
			d,
			async () => {
				order.push(`${n}+`);
				await new Promise((r) => setTimeout(r, 100));
				order.push(`${n}-`);
			},
			{ pollMs: 10 },
		);
	await Promise.all([slow("a"), slow("b")]);
	expect(order).toEqual(["a+", "a-", "b+", "b-"]);
});

it("times out with a problem rather than waiting forever", async () => {
	const d = dir();
	const held = withLock(d, () => new Promise((r) => setTimeout(r, 300)), {
		pollMs: 10,
	});
	await expect(
		withLock(d, async () => 1, { timeoutMs: 50, pollMs: 10 }),
	).rejects.toBeInstanceOf(PortiaProblem);
	await held;
});

it("reclaims a lock whose PID is no longer alive (Review focus 4)", async () => {
	const d = dir();
	writeFileSync(join(d, "heavy.lock"), "999999");
	expect(
		await withLock(d, async () => "ran", { timeoutMs: 200, pollMs: 10 }),
	).toBe("ran");
});

it("is re-entrant inside one holder's call chain", async () => {
	const d = dir();
	expect(
		await withLock(
			d,
			() => withLock(d, async () => "inner", { timeoutMs: 100, pollMs: 10 }),
			{ pollMs: 10 },
		),
	).toBe("inner");
});

it("named locks are independent, and re-entrance is per name", async () => {
	const d = dir();
	const res = await withLock(
		d,
		() =>
			withLock(d, async () => "other", {
				name: "land.lock",
				timeoutMs: 50,
				pollMs: 10,
			}),
		{ pollMs: 10 },
	);
	expect(res).toBe("other");
	const held = withLock(d, () => new Promise((r) => setTimeout(r, 200)), {
		name: "land.lock",
	});
	await new Promise((r) => setTimeout(r, 20));
	await expect(
		withLock(d, async () => 1, {
			name: "land.lock",
			timeoutMs: 50,
			pollMs: 10,
		}),
	).rejects.toBeInstanceOf(PortiaProblem);
	expect(
		await withLock(d, async () => "heavy", { timeoutMs: 50, pollMs: 10 }),
	).toBe("heavy");
	await held;
});

const lstart = (pid: number) =>
	execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
	}).trim();

it("reclaims a lock whose pid now names a process started at another time", async () => {
	const d = dir();
	writeFileSync(
		join(d, "heavy.lock"),
		JSON.stringify({ pid: process.ppid, proc: "Thu Jan  1 00:00:00 1970" }),
	);
	expect(
		await withLock(d, async () => "ran", { timeoutMs: 200, pollMs: 10 }),
	).toBe("ran");
	expect(existsSync(join(d, "heavy.lock"))).toBe(false);
});

it("waits on a live holder whose start time matches", async () => {
	const d = dir();
	writeFileSync(
		join(d, "heavy.lock"),
		JSON.stringify({ pid: process.ppid, proc: lstart(process.ppid) }),
	);
	await expect(
		withLock(d, async () => 1, { timeoutMs: 50, pollMs: 10 }),
	).rejects.toBeInstanceOf(PortiaProblem);
});

it("an unreadable lock is reclaimed only once it is old", async () => {
	const d = dir();
	const lock = join(d, "heavy.lock");
	writeFileSync(lock, "");
	await expect(
		withLock(d, async () => 1, { timeoutMs: 50, pollMs: 10 }),
	).rejects.toBeInstanceOf(PortiaProblem);
	const old = new Date(Date.now() - 60_000);
	utimesSync(lock, old, old);
	expect(
		await withLock(d, async () => "ran", { timeoutMs: 200, pollMs: 10 }),
	).toBe("ran");
});

it("a dead holder's lock is removed only by the waiter holding the steal guard", async () => {
	const d = dir();
	const lock = join(d, "heavy.lock");
	writeFileSync(lock, JSON.stringify({ pid: 999999 }));
	const live = JSON.stringify({
		pid: process.ppid,
		proc: lstart(process.ppid),
	});
	writeFileSync(`${lock}.steal`, live);
	await expect(
		withLock(d, async () => 1, { timeoutMs: 50, pollMs: 10 }),
	).rejects.toBeInstanceOf(PortiaProblem);
	expect(readFileSync(lock, "utf8")).toBe(JSON.stringify({ pid: 999999 }));
	// A guard left by a waiter that died is cleared, and the takeover goes ahead.
	writeFileSync(`${lock}.steal`, JSON.stringify({ pid: 999999 }));
	expect(
		await withLock(d, async () => "ran", { timeoutMs: 200, pollMs: 10 }),
	).toBe("ran");
	expect(readdirSync(d)).toEqual([]);
});

it("a holder removes only its own lock, never a later holder's", async () => {
	const d = dir();
	const lock = join(d, "heavy.lock");
	const other = JSON.stringify({ pid: process.ppid, nonce: "theirs" });
	await withLock(d, async () => {
		writeFileSync(lock, other);
	});
	expect(readFileSync(lock, "utf8")).toBe(other);
});

it("writes its lock whole, with its pid and start time", async () => {
	const d = dir();
	const seen = await withLock(d, async () =>
		JSON.parse(readFileSync(join(d, "heavy.lock"), "utf8")),
	);
	expect(seen).toMatchObject({ pid: process.pid, proc: lstart(process.pid) });
	expect(typeof seen.nonce).toBe("string");
	expect(readdirSync(d)).toEqual([]);
});

it("touches the wait file while it waits its turn", async () => {
	const d = dir();
	const wait = join(d, "worker.wait");
	process.env.PORTIA_WAIT_FILE = wait;
	try {
		const held = withLock(d, () => new Promise((r) => setTimeout(r, 100)), {
			pollMs: 10,
		});
		expect(existsSync(wait)).toBe(false);
		await withLock(d, async () => 1, { pollMs: 10 });
		await held;
		expect(existsSync(wait)).toBe(true);
	} finally {
		delete process.env.PORTIA_WAIT_FILE;
	}
});

it("withLockSync reclaims a dead holder and times out on a live one", () => {
	const d = dir();
	writeFileSync(join(d, "ports.lock"), JSON.stringify({ pid: 999999 }));
	expect(withLockSync(d, () => "ran", { name: "ports.lock" })).toBe("ran");
	writeFileSync(
		join(d, "ports.lock"),
		JSON.stringify({ pid: process.ppid, proc: lstart(process.ppid) }),
	);
	expect(() =>
		withLockSync(d, () => 1, {
			name: "ports.lock",
			timeoutMs: 30,
			problem: "busy",
		}),
	).toThrow("busy");
});

it("processes racing to take over a dead holder's lock still hold it one at a time", async () => {
	const d = dir();
	writeFileSync(join(d, "race.lock"), "999999");
	const log = join(d, "log");
	const lockTs = join(__dirname, "../../src/gate/lock.ts");
	const script = `
		import { appendFileSync } from "node:fs";
		import { withLockSync } from ${JSON.stringify(lockTs)};
		const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		withLockSync(${JSON.stringify(d)}, () => {
			appendFileSync(${JSON.stringify(log)}, "+");
			nap(30);
			appendFileSync(${JSON.stringify(log)}, "-");
		}, { name: "race.lock", timeoutMs: 10_000, pollMs: 5 });
	`;
	const n = 6;
	const codes = await Promise.all(
		Array.from(
			{ length: n },
			() =>
				new Promise((r) =>
					spawn("bun", ["-e", script], { stdio: "inherit" }).on("exit", r),
				),
		),
	);
	expect(codes).toEqual(Array(n).fill(0));
	expect(readFileSync(log, "utf8")).toBe("+-".repeat(n));
	expect(existsSync(join(d, "race.lock"))).toBe(false);
});

it("takes over a lock naming its own pid that it does not hold, as after a container restart", async () => {
	const d = dir();
	// No start time, as when ps is missing: only the pid names the earlier holder.
	writeFileSync(join(d, "land.lock"), JSON.stringify({ pid: process.pid }));
	expect(lockHolder(d, "land.lock")).toBeUndefined();
	expect(
		await withLock(d, async () => lockHolder(d, "land.lock"), {
			name: "land.lock",
			timeoutMs: 0,
		}),
	).toBe(process.pid);
	expect(readdirSync(d)).toEqual([]);
});
