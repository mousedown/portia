import { expect, it } from "vitest";
import {
	idempotentNet,
	NET_TIMEOUT_MS,
	spawnExec,
	withNetRetry,
} from "../../src/core/exec";
import { mapLimit } from "../../src/core/limit";
import { fakeExec } from "../helpers/fake-exec";

const noSleep = () => {
	const waits: number[] = [];
	return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

it("retries a transient fetch failure with doubling backoff, and bounds it with a timeout", async () => {
	let n = 0;
	const f = fakeExec(() =>
		++n < 3
			? { code: 128, stderr: "fatal: unable to access: Could not resolve host" }
			: {},
	);
	const s = noSleep();
	const r = await withNetRetry(f.exec, { sleep: s.sleep, log: () => {} })(
		"git",
		["fetch", "origin"],
	);
	expect(r.code).toBe(0);
	expect(f.calls).toHaveLength(3);
	expect(s.waits).toEqual([1000, 2000]);
	expect(f.calls.every((c) => c.timeoutMs === NET_TIMEOUT_MS.git)).toBe(true);
});

it("runs a fetch again that lost a race for a remote-tracking ref, but not another command", async () => {
	let n = 0;
	const f = fakeExec(() =>
		++n < 2
			? {
					code: 1,
					stderr:
						"error: cannot lock ref 'refs/remotes/origin/main': is at a1 but expected b2",
				}
			: {},
	);
	const s = noSleep();
	const r = await withNetRetry(f.exec, { sleep: s.sleep, log: () => {} })(
		"git",
		["fetch", "origin", "main"],
	);
	expect(r.code).toBe(0);
	expect(f.calls).toHaveLength(2);
	const push = fakeExec(() => ({
		code: 1,
		stderr: "error: cannot lock ref 'refs/heads/b'",
	}));
	await withNetRetry(push.exec, { sleep: s.sleep, log: () => {} })("git", [
		"push",
		"origin",
		"a:refs/heads/b",
	]);
	expect(push.calls).toHaveLength(1);
});

it("gives up after the last attempt and returns its failure", async () => {
	const f = fakeExec(() => ({
		code: 1,
		stderr: "gh: Server Error (HTTP 502)",
	}));
	const r = await withNetRetry(f.exec, {
		sleep: noSleep().sleep,
		log: () => {},
	})("gh", ["api", "repos/o/r/issues/1"]);
	expect(r.code).toBe(1);
	expect(f.calls).toHaveLength(3);
});

it("never repeats a failure that is not transient, nor a write", async () => {
	const notFound = fakeExec(() => ({
		code: 1,
		stderr: "gh: Not Found (HTTP 404)",
	}));
	await withNetRetry(notFound.exec, { sleep: noSleep().sleep })("gh", [
		"api",
		"repos/o/r/issues/9",
	]);
	expect(notFound.calls).toHaveLength(1);
	const merge = fakeExec(() => ({ code: 1, stderr: "HTTP 502" }));
	await withNetRetry(merge.exec, { sleep: noSleep().sleep })("gh", [
		"pr",
		"merge",
		"7",
		"--squash",
	]);
	expect(merge.calls).toHaveLength(1);
	expect(merge.calls[0]?.timeoutMs).toBeUndefined();
});

it("keeps a caller's own timeout", async () => {
	const f = fakeExec();
	await withNetRetry(f.exec)("git", ["ls-remote", "origin"], {
		timeoutMs: 5,
	});
	expect(f.calls[0]?.timeoutMs).toBe(5);
});

it("counts only reads, fetches and pushes of a named commit as safe to repeat", () => {
	expect(idempotentNet("gh", ["api", "repos/o/r/issues/1"])).toBe(true);
	expect(idempotentNet("gh", ["pr", "view", "3"])).toBe(true);
	expect(idempotentNet("git", ["ls-remote", "origin"])).toBe(true);
	expect(
		idempotentNet("git", ["push", "--force-with-lease", "origin", "a:b"]),
	).toBe(true);
	expect(idempotentNet("gh", ["api", "x", "-X", "POST", "-f", "body=hi"])).toBe(
		false,
	);
	expect(idempotentNet("gh", ["api", "x", "-f", "body=hi"])).toBe(false);
	expect(idempotentNet("gh", ["pr", "create"])).toBe(false);
	expect(idempotentNet("gh", ["pr", "merge", "1"])).toBe(false);
	expect(idempotentNet("git", ["push", "origin", "--delete", "b"])).toBe(false);
	expect(idempotentNet("git", ["push", "origin", ":b"])).toBe(false);
	expect(idempotentNet("git", ["rebase", "main"])).toBe(false);
	expect(idempotentNet("sh", ["-c", "git fetch"])).toBe(false);
});

it("keepTail keeps only the end of a large output", async () => {
	const r = await spawnExec("sh", ["-c", "seq 1 200000; echo done >&2"], {
		keepTail: 1000,
	});
	expect(r.code).toBe(0);
	expect(r.stdout.length).toBeLessThanOrEqual(1000);
	expect(r.stdout.trim().endsWith("200000")).toBe(true);
	expect(r.stderr.trim()).toBe("done");
});

it("mapLimit keeps order and never runs more than the limit at once", async () => {
	let live = 0;
	let peak = 0;
	const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (v, i) => {
		live++;
		peak = Math.max(peak, live);
		await new Promise((r) => setTimeout(r, v));
		live--;
		return `${i}:${v}`;
	});
	expect(out).toEqual(["0:5", "1:1", "2:4", "3:2", "4:3", "5:0", "6:6"]);
	expect(peak).toBe(3);
	expect(await mapLimit([], 3, async () => 1)).toEqual([]);
});

it("mapLimit starts no further call once one has failed", async () => {
	const started: number[] = [];
	await expect(
		mapLimit([0, 1, 2, 3, 4, 5], 2, async (v) => {
			started.push(v);
			await new Promise((r) => setTimeout(r, 1));
			if (v === 0) throw new Error("boom");
			return v;
		}),
	).rejects.toThrow("boom");
	await new Promise((r) => setTimeout(r, 20));
	expect(started).toEqual([0, 1]);
});

it("gives a push room for its pre-push hooks, and never reruns one killed at the limit", async () => {
	const hung = fakeExec(() => ({
		code: 124,
		stderr: "\ntimed out after 1800000ms",
		timedOut: true,
	}));
	const s = noSleep();
	const r = await withNetRetry(hung.exec, { sleep: s.sleep, log: () => {} })(
		"git",
		["push", "--force-with-lease", "origin", "abc:refs/heads/portia/ACME-2"],
	);
	expect(r.code).toBe(124);
	expect(hung.calls).toHaveLength(1);
	expect(hung.calls[0]?.timeoutMs).toBe(NET_TIMEOUT_MS.push);
	expect(NET_TIMEOUT_MS.push).toBeGreaterThan(NET_TIMEOUT_MS.git);
	// A push the network dropped is still tried again.
	let n = 0;
	const dropped = fakeExec(() =>
		++n < 2 ? { code: 128, stderr: "fatal: the remote end hung up" } : {},
	);
	await withNetRetry(dropped.exec, { sleep: s.sleep, log: () => {} })("git", [
		"push",
		"origin",
		"abc:refs/heads/b",
	]);
	expect(dropped.calls).toHaveLength(2);
});

it("runs a read of an issue's dependencies again that answered 404, but no other 404 and never a write", async () => {
	let n = 0;
	const f = fakeExec(() =>
		++n < 2
			? { code: 1, stderr: "gh: Not Found (HTTP 404)" }
			: { stdout: "[]" },
	);
	const s = noSleep();
	const read = await withNetRetry(f.exec, { sleep: s.sleep, log: () => {} })(
		"gh",
		["api", "repos/o/r/issues/13/dependencies/blocked_by", "--paginate"],
	);
	expect(read.code).toBe(0);
	expect(f.calls).toHaveLength(2);
	const gone = fakeExec(() => ({
		code: 1,
		stderr: "gh: Not Found (HTTP 404)",
	}));
	const missing = await withNetRetry(gone.exec, {
		sleep: s.sleep,
		log: () => {},
	})("gh", ["api", "repos/o/r/issues/99"]);
	expect(missing.code).toBe(1);
	// A missing issue is reported at once: callers test for it.
	expect(gone.calls).toHaveLength(1);
	const lagging = fakeExec(() => ({
		code: 1,
		stderr: "gh: Not Found (HTTP 404)",
	}));
	const stands = await withNetRetry(lagging.exec, {
		sleep: s.sleep,
		log: () => {},
	})("gh", ["api", "repos/o/r/issues/13/dependencies/blocked_by"]);
	expect(stands.code).toBe(1);
	expect(lagging.calls).toHaveLength(3);
	const post = fakeExec(() => ({
		code: 1,
		stderr: "gh: Not Found (HTTP 404)",
	}));
	await withNetRetry(post.exec, { sleep: s.sleep, log: () => {} })("gh", [
		"api",
		"repos/o/r/issues/13/dependencies/blocked_by",
		"-X",
		"POST",
	]);
	expect(post.calls).toHaveLength(1);
	// A 404 from git is the request's own fault.
	const git = fakeExec(() => ({
		code: 128,
		stderr: "fatal: repository not found (HTTP 404)",
	}));
	await withNetRetry(git.exec, { sleep: s.sleep, log: () => {} })("git", [
		"fetch",
		"origin",
	]);
	expect(git.calls).toHaveLength(1);
});
