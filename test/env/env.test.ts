import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Profile,
	ProfileSchema,
	testProfile,
} from "../../src/core/config";
import type { Exec } from "../../src/core/exec";
import { PortiaProblem } from "../../src/core/exit";
import { readRows } from "../../src/core/runlog";
import {
	dbName,
	envDown,
	envTemplate,
	envUp,
	provision,
	REF_LOCK_TRIES,
	refLockRetry,
	servicesFor,
} from "../../src/env/env";
import {
	allocatePort,
	bindable,
	releasePort,
	releasePorts,
} from "../../src/env/ports";
import acmeRaw from "../fixtures/profile";
import { fakeExec } from "../helpers/fake-exec";
import { child } from "../helpers/plan";

const acmeProfile = (): Profile => {
	const p = ProfileSchema.parse(acmeRaw);
	return {
		...p,
		db: p.db && {
			...p.db,
			pg: {
				host: "localhost",
				port: 5432,
				user: "postgres",
				password: "postgres",
				prefix: "portia",
			},
		},
	};
};

const setup = (base: Profile = acmeProfile()) => {
	// Under a runs directory of its own, which holds the machine-wide port pool.
	const dir = join(mkdtempSync(join(tmpdir(), "portia-runs-")), "ACME-0");
	mkdirSync(dir);
	const repoRoot = mkdtempSync(join(tmpdir(), "portia-repo-"));
	mkdirSync(join(repoRoot, base.packageDir), { recursive: true });
	writeFileSync(
		join(repoRoot, base.packageDir, ".env"),
		"DATABASE_URL=postgres://main\n",
	);
	const profile = {
		...base,
		worktreesDir: mkdtempSync(join(tmpdir(), "portia-wt-")),
	};
	return { dir, repoRoot, profile };
};

const yes = async () => true;
const pool = (dir: string) =>
	JSON.parse(readFileSync(join(dir, "../ports.json"), "utf8"));

describe("ports", () => {
	it("hands out distinct ports and reuses released ones", async () => {
		const { dir } = setup();
		const a = await allocatePort(dir, [3100, 3101], "ACME-2", yes);
		const b = await allocatePort(dir, [3100, 3101], "ACME-3", yes);
		expect(new Set([a, b]).size).toBe(2);
		await expect(
			allocatePort(dir, [3100, 3101], "ACME-4", yes),
		).rejects.toThrow(PortiaProblem);
		releasePort(dir, a);
		expect(await allocatePort(dir, [3100, 3101], "ACME-4", yes)).toBe(a);
	});
	it("is one pool for every run on the machine", async () => {
		const { dir } = setup();
		const other = join(dir, "../ACME-9");
		mkdirSync(other);
		const a = await allocatePort(dir, [3100, 3101], "ACME-2", yes);
		const b = await allocatePort(other, [3100, 3101], "ACME-10", yes);
		expect([a, b]).toEqual([3100, 3101]);
		expect(pool(dir)).toEqual([
			{ port: 3100, run: "ACME-0", child: "ACME-2", pid: process.pid },
			{ port: 3101, run: "ACME-9", child: "ACME-10", pid: process.pid },
		]);
	});
	it("passes over a port something else listens on, and keeps no hold on it", async () => {
		const { dir } = setup();
		const free = async (p: number) => p !== 3100;
		expect(await allocatePort(dir, [3100, 3102], "ACME-2", free)).toBe(3101);
		expect(pool(dir).map((e: { port: number }) => e.port)).toEqual([3101]);
		await expect(
			allocatePort(dir, [3100, 3100], "ACME-3", free),
		).rejects.toThrow(/no free port/);
	});
	it("reclaims a port whose taker died before any env state recorded it", async () => {
		const { dir } = setup();
		writeFileSync(
			join(dir, "../ports.json"),
			JSON.stringify([
				{ port: 3100, run: "ACME-0", child: "ACME-2", pid: 999_999_999 },
				{ port: 3101, run: "ACME-0", child: "ACME-3", pid: 999_999_999 },
			]),
		);
		writeFileSync(join(dir, "env-ACME-3.json"), JSON.stringify({ port: 3101 }));
		expect(await allocatePort(dir, [3100, 3102], "ACME-4", yes)).toBe(3100);
		expect(pool(dir).map((e: { child: string }) => e.child)).toEqual([
			"ACME-3",
			"ACME-4",
		]);
	});
	it("never hands out a port an environment that is up records, pooled or not", async () => {
		const { dir } = setup();
		const other = join(dir, "../ACME-9");
		mkdirSync(other);
		// Taken before the pool was machine-wide: only the env state file knows it.
		writeFileSync(
			join(other, "env-ACME-10.json"),
			JSON.stringify({ port: 3100, servicePorts: { redis: 3101 } }),
		);
		expect(await allocatePort(dir, [3100, 3102], "ACME-2", yes)).toBe(3102);
	});
	it("passes over another run's env left for a day, whose envDown never ran", async () => {
		const { dir } = setup();
		const other = join(dir, "../ACME-9");
		mkdirSync(other);
		const left = join(other, "env-ACME-10.json");
		writeFileSync(
			left,
			JSON.stringify({ port: 3100, servicePorts: { r: 3101 } }),
		);
		writeFileSync(
			join(dir, "../ports.json"),
			JSON.stringify([{ port: 3101, run: "ACME-9", child: "ACME-10", pid: 0 }]),
		);
		const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
		utimesSync(left, old, old);
		expect(await allocatePort(dir, [3100, 3101], "ACME-2", yes)).toBe(3100);
		expect(await allocatePort(dir, [3100, 3101], "ACME-3", yes)).toBe(3101);
		// This run's own env state always holds its ports, however old.
		const mine = join(dir, "env-ACME-4.json");
		writeFileSync(mine, JSON.stringify({ port: 3102 }));
		utimesSync(mine, old, old);
		expect(await allocatePort(dir, [3102, 3103], "ACME-5", yes)).toBe(3103);
	});
	it("an unreadable pool holds nothing, and is replaced whole", async () => {
		const { dir } = setup();
		writeFileSync(join(dir, "../ports.json"), '[{"port": 31');
		expect(await allocatePort(dir, [3100, 3101], "ACME-2", yes)).toBe(3100);
		expect(pool(dir)).toEqual([
			{ port: 3100, run: "ACME-0", child: "ACME-2", pid: process.pid },
		]);
	});
	it("releases every port a child holds, by owner", async () => {
		const { dir } = setup();
		await allocatePort(dir, [3100, 3105], "ACME-2", yes);
		await allocatePort(dir, [3100, 3105], "ACME-2", yes);
		await allocatePort(dir, [3100, 3105], "ACME-3", yes);
		releasePorts(dir, "ACME-2");
		expect(pool(dir).map((e: { child: string }) => e.child)).toEqual([
			"ACME-3",
		]);
	});
	it("bindable is false for a port a server listens on", async () => {
		const s = createServer();
		await new Promise<void>((r) => s.listen(0, r));
		const port = (s.address() as { port: number }).port;
		try {
			expect(await bindable(port)).toBe(false);
		} finally {
			await new Promise((r) => s.close(r));
		}
		expect(await bindable(port)).toBe(true);
	});
});

describe("port lock", () => {
	it("refuses to allocate while the lock is held, and does not allocate", async () => {
		const { dir } = setup();
		const lock = join(dir, "../ports.lock");
		writeFileSync(lock, "");
		await expect(
			allocatePort(dir, [3100, 3101], "ACME-2", yes),
		).rejects.toThrow(/locked/);
		expect(existsSync(join(dir, "../ports.json"))).toBe(false);
		rmSync(lock);
		expect(await allocatePort(dir, [3100, 3101], "ACME-2", yes)).toBe(3100);
		expect(existsSync(lock)).toBe(false);
	});

	it("takes over a lock left by a holder that died", async () => {
		const { dir } = setup();
		const lock = join(dir, "../ports.lock");
		writeFileSync(lock, JSON.stringify({ pid: 999999 }));
		expect(await allocatePort(dir, [3100, 3101], "ACME-2", yes)).toBe(3100);
		expect(existsSync(lock)).toBe(false);
	});
});

describe("envUp", () => {
	it("refuses below the free-memory gate (X4)", async () => {
		const { dir, repoRoot, profile } = setup();
		const { exec, calls } = fakeExec();
		await expect(
			envUp(child("ACME-2"), "ACME-0", {
				exec,
				profile,
				repoRoot,
				dir,
				freeMb: () => 10,
			}),
		).rejects.toThrow(/free memory/);
		expect(calls).toHaveLength(0);
	});
	it("creates the worktree, database, env file and installs; no search service for non-search touches", async () => {
		const { dir, repoRoot, profile } = setup();
		const { exec, calls, line } = fakeExec((c) => {
			if (c.cmd === "git" && c.args[0] === "worktree")
				mkdirSync(join(c.args.at(-2) as string, "packages/acme-web"), {
					recursive: true,
				});
			return undefined;
		});
		const env = await envUp(child("ACME-2"), "ACME-0", {
			exec,
			profile,
			repoRoot,
			dir,
			freeMb: () => 99_999,
		});
		const lines = calls.map(line);
		expect(lines[0]).toBe("git fetch origin epic/ACME-0");
		expect(lines).toContain(
			`git worktree add -B epic/ACME-2 ${env.worktree} origin/epic/ACME-0`,
		);
		expect(lines).toContain(
			`createdb -h localhost -p 5432 -U postgres -T portia_tpl_acme_0 ${dbName("portia", "ACME-2")}`,
		);
		expect(lines).toContain("bun install --frozen-lockfile");
		expect(lines.some((l) => l.startsWith("docker"))).toBe(false);
		const file = readFileSync(env.envFile, "utf8");
		expect(file).toContain(`PORT=${env.port}`);
		expect(file).toContain(
			"DATABASE_URL=postgresql://postgres:postgres@localhost:5432/portia_acme_2",
		);
		expect(existsSync(join(env.worktree, "packages/acme-web/.env"))).toBe(true);
	});
	it("starts the search service only when touches hit search code", () => {
		const p = acmeProfile();
		expect(
			servicesFor(
				child("ACME-2", {
					touches: ["packages/acme-web/src/lib/search/x.ts"],
				}),
				p,
			).map((s) => s.name),
		).toEqual(["search"]);
		expect(servicesFor(child("ACME-2"), p)).toEqual([]);
	});
});

describe("envDown", () => {
	it("drops the database, removes the container and the worktree, even with no env state", async () => {
		const { dir, repoRoot, profile } = setup();
		const { exec, calls, line } = fakeExec();
		await envDown("ACME-2", "ACME-0", { exec, profile, repoRoot, dir });
		const lines = calls.map(line);
		expect(lines).toContain(
			"dropdb -h localhost -p 5432 -U postgres --if-exists portia_acme_2",
		);
		expect(lines).toContain("docker rm -f portia-search-acme-2");
		expect(lines.some((l) => l.startsWith("git worktree remove --force"))).toBe(
			true,
		);
	});
});

describe("envDown state", () => {
	it("deletes the env state file after releasing ports", async () => {
		const { dir, repoRoot, profile } = setup();
		const port = await allocatePort(dir, profile.ports, "ACME-2", yes);
		const f = join(dir, "env-ACME-2.json");
		writeFileSync(f, JSON.stringify({ port }));
		await envDown("ACME-2", "ACME-0", {
			exec: fakeExec().exec,
			profile,
			repoRoot,
			dir,
		});
		expect(existsSync(f)).toBe(false);
		expect(pool(dir)).toEqual([]);
	});
	it("releases the ports a provision took though no env state records them", async () => {
		const { dir, repoRoot, profile } = setup();
		writeFileSync(
			join(dir, "../ports.json"),
			JSON.stringify([
				{ port: 3100, run: "ACME-0", child: "ACME-2", pid: process.pid },
				{ port: 3101, run: "ACME-0", child: "ACME-3", pid: process.pid },
			]),
		);
		await envDown("ACME-2", "ACME-0", {
			exec: fakeExec().exec,
			profile,
			repoRoot,
			dir,
		});
		expect(pool(dir).map((e: { child: string }) => e.child)).toEqual([
			"ACME-3",
		]);
	});
});

describe("envUp extras", () => {
	const wt = (c: { cmd: string; args: string[] }) => {
		if (c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add")
			mkdirSync(join(c.args.at(-2) as string, "packages/acme-web"), {
				recursive: true,
			});
		return undefined;
	};
	it("starts the search service for search touches and writes its ports", async () => {
		const { dir, repoRoot, profile } = setup();
		const { exec, calls, line } = fakeExec(wt);
		const c = child("ACME-2", {
			touches: ["packages/acme-web/src/lib/search/x.ts"],
		});
		const env = await envUp(c, "ACME-0", {
			exec,
			profile,
			repoRoot,
			dir,
			freeMb: () => 99_999,
		});
		expect(env.servicePorts?.search).toBeDefined();
		expect(calls.map(line)).toContain(
			`docker run -d --name portia-search-acme-2 -p ${env.servicePorts?.search}:8108 acme/search:1 --data-dir /tmp --api-key portia`,
		);
		const file = readFileSync(env.envFile, "utf8");
		expect(file).toContain(`SEARCH_PORT=${env.servicePorts?.search}`);
		expect(file).toContain(`PUBLIC_SEARCH_PORT=${env.servicePorts?.search}`);
	});
	it("rolls back and frees the ports when a later step fails", async () => {
		const { dir, repoRoot, profile } = setup();
		const { exec, calls, line } = fakeExec((c) => {
			wt(c);
			return c.cmd === "bun" ? { code: 1, stderr: "boom" } : undefined;
		});
		const c = child("ACME-2", {
			touches: ["packages/acme-web/src/lib/search/x.ts"],
		});
		await expect(
			envUp(c, "ACME-0", {
				exec,
				profile,
				repoRoot,
				dir,
				freeMb: () => 99_999,
			}),
		).rejects.toThrow(/boom/);
		const lines = calls.map(line);
		expect(lines).toContain(
			"dropdb -h localhost -p 5432 -U postgres --if-exists portia_acme_2",
		);
		expect(lines).toContain("docker rm -f portia-search-acme-2");
		expect(lines.some((l) => l.startsWith("git worktree remove --force"))).toBe(
			true,
		);
		expect(pool(dir)).toEqual([]);
	});
	it("replaces a service container an earlier attempt left behind", async () => {
		const { dir, repoRoot, profile } = setup();
		const { exec, calls, line } = fakeExec(wt);
		const c = child("ACME-2", {
			touches: ["packages/acme-web/src/lib/search/x.ts"],
		});
		await envUp(c, "ACME-0", {
			exec,
			profile,
			repoRoot,
			dir,
			freeMb: () => 99_999,
		});
		const lines = calls.map(line);
		const rm = lines.indexOf("docker rm -f portia-search-acme-2");
		expect(rm).toBeGreaterThanOrEqual(0);
		expect(rm).toBeLessThan(lines.findIndex((l) => l.startsWith("docker run")));
	});
	it("a failed re-provision removes the container and database it started and frees its ports", async () => {
		const { dir, repoRoot, profile } = setup();
		const worktree = join(profile.worktreesDir, "wt");
		mkdirSync(join(worktree, "packages/acme-web"), { recursive: true });
		const { exec, calls, line } = fakeExec((c) =>
			c.cmd === "bun" ? { code: 1, stderr: "boom" } : undefined,
		);
		const c = child("ACME-2", {
			touches: ["packages/acme-web/src/lib/search/x.ts"],
		});
		await expect(
			provision(worktree, "ACME-2", "ACME-0", c, {
				exec,
				profile,
				repoRoot,
				dir,
			}),
		).rejects.toThrow(/boom/);
		const lines = calls.map(line);
		const after = lines.slice(lines.indexOf("bun install --frozen-lockfile"));
		expect(after).toContain("docker rm -f portia-search-acme-2");
		expect(after).toContain(
			"dropdb -h localhost -p 5432 -U postgres --if-exists portia_acme_2",
		);
		expect(pool(dir)).toEqual([]);
		expect(existsSync(join(dir, "env-ACME-2.json"))).toBe(false);
	});
	it("clones the database, starts services and installs side by side", async () => {
		const { dir, repoRoot, profile } = setup();
		const worktree = join(profile.worktreesDir, "wt");
		mkdirSync(join(worktree, "packages/acme-web"), { recursive: true });
		let inFlight = 0;
		let most = 0;
		const exec: Exec = async () => {
			most = Math.max(most, ++inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return { code: 0, stdout: "", stderr: "" };
		};
		const c = child("ACME-2", {
			touches: ["packages/acme-web/src/lib/search/x.ts"],
		});
		await provision(worktree, "ACME-2", "ACME-0", c, {
			exec,
			profile,
			repoRoot,
			dir,
		});
		expect(most).toBe(3);
	});
	it("tries a fetch again while another worktree's fetch holds the ref lock", async () => {
		const locked = {
			code: 1,
			stdout: "",
			stderr:
				"error: cannot lock ref 'refs/remotes/origin/epic/ACME-0': File exists",
		};
		let n = 0;
		const waits: number[] = [];
		const flaky: Exec = async () =>
			++n < 3 ? locked : { code: 0, stdout: "ok", stderr: "" };
		const r = await refLockRetry(flaky, async (ms) => {
			waits.push(ms);
		})("git", ["fetch", "origin", "epic/ACME-0"]);
		expect(r.stdout).toBe("ok");
		expect(waits).toHaveLength(2);
		const other: Exec = async () => ({ code: 128, stdout: "", stderr: "no" });
		n = 0;
		const counted: Exec = async (...a) => {
			n++;
			return other(...a);
		};
		expect((await refLockRetry(counted, async () => {})("git", [])).code).toBe(
			128,
		);
		expect(n).toBe(1);
		n = 0;
		const always: Exec = async () => {
			n++;
			return locked;
		};
		expect((await refLockRetry(always, async () => {})("git", [])).code).toBe(
			1,
		);
		expect(n).toBe(REF_LOCK_TRIES);
	});
});

describe("envTemplate", () => {
	it("recreates the template database and migrates it", async () => {
		const { dir, repoRoot, profile } = setup();
		const { exec, calls, line } = fakeExec();
		await envTemplate("ACME-0", { exec, profile, repoRoot, dir });
		expect(calls.map(line)).toEqual([
			"dropdb -h localhost -p 5432 -U postgres --if-exists portia_tpl_acme_0",
			"createdb -h localhost -p 5432 -U postgres portia_tpl_acme_0",
			'sh -c DATABASE_URL_UNPOOLED="$DATABASE_URL" bun run db:migrate',
		]);
		expect(calls[2]?.cwd).toBe(join(repoRoot, "packages/acme-web"));
		expect(calls[2]?.env?.DATABASE_URL).toBe(
			"postgresql://postgres:postgres@localhost:5432/portia_tpl_acme_0",
		);
	});
});

describe("provision under dry run", () => {
	it("leaves an existing worktree's env files and state untouched", async () => {
		const { dir, repoRoot, profile } = setup();
		const worktree = join(profile.worktreesDir, "wt");
		const pkg = join(worktree, "packages/acme-web");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, ".env"), "LIVE=1\n");
		writeFileSync(join(pkg, ".env.portia"), "LIVE=1\n");
		process.env.PORTIA_DRY_RUN = "1";
		try {
			const { exec } = fakeExec();
			await provision(worktree, "ACME-2", "ACME-0", undefined, {
				exec,
				profile,
				repoRoot,
				dir,
			});
		} finally {
			delete process.env.PORTIA_DRY_RUN;
		}
		expect(readFileSync(join(pkg, ".env"), "utf8")).toBe("LIVE=1\n");
		expect(readFileSync(join(pkg, ".env.portia"), "utf8")).toBe("LIVE=1\n");
		expect(existsSync(join(dir, "env-ACME-2.json"))).toBe(false);
	});

	it("builds a valid URL and an empty PGPASSWORD for a passwordless role", async () => {
		const { dir, repoRoot, profile } = setup();
		const { exec, calls } = fakeExec();
		const db = profile.db as NonNullable<Profile["db"]>;
		const trust = {
			...profile,
			db: { ...db, pg: { ...db.pg, user: "me", password: "" } },
		};
		await envTemplate("ACME-0", { exec, profile: trust, repoRoot, dir });
		expect(calls[0]?.env?.PGPASSWORD).toBe("");
		expect(calls[2]?.env?.DATABASE_URL).toBe(
			"postgresql://me@localhost:5432/portia_tpl_acme_0",
		);
	});
});

describe("acme env lines", () => {
	it("writes exactly the phase-1 lines, with search lines only for search touches", async () => {
		const run = async (touches: string[]) => {
			const { dir, repoRoot, profile } = setup();
			const { exec } = fakeExec((c) => {
				if (c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add")
					mkdirSync(join(c.args.at(-2) as string, "packages/acme-web"), {
						recursive: true,
					});
				return undefined;
			});
			const env = await envUp(child("ACME-2", { touches }), "ACME-0", {
				exec,
				profile,
				repoRoot,
				dir,
				freeMb: () => 99_999,
			});
			return { env, lines: readFileSync(env.envFile, "utf8").split("\n") };
		};
		const plain = await run([]);
		const url = "postgresql://postgres:postgres@localhost:5432/portia_acme_2";
		expect(plain.lines).toEqual([
			`PORT=${plain.env.port}`,
			`DATABASE_URL=${url}`,
			`DATABASE_URL_UNPOOLED=${url}`,
			"",
		]);
		const search = await run(["packages/acme-web/src/server/search/x.ts"]);
		const ts = search.env.servicePorts?.search;
		expect(search.lines).toEqual([
			`PORT=${search.env.port}`,
			`DATABASE_URL=${url}`,
			`DATABASE_URL_UNPOOLED=${url}`,
			`SEARCH_PORT=${ts}`,
			`PUBLIC_SEARCH_PORT=${ts}`,
			"SEARCH_API_KEY=portia",
			"",
		]);
		expect(
			existsSync(join(search.env.worktree, "packages/acme-web/.env")),
		).toBe(true);
	});
});

describe("profile-driven env", () => {
	const neutral = (over: Partial<Profile> = {}): Profile => ({
		...testProfile(),
		...over,
	});
	const mk = (c: { cmd: string; args: string[] }, pkg: string) => {
		if (c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add")
			mkdirSync(join(c.args.at(-2) as string, pkg), { recursive: true });
		return undefined;
	};
	it("a profile with no db skips createdb, dropdb and migrate", async () => {
		const base = neutral({ db: undefined });
		const { dir, repoRoot, profile } = setup(base);
		const { exec, calls, line } = fakeExec((c) => mk(c, base.packageDir));
		await envTemplate("ACME-0", { exec, profile, repoRoot, dir });
		expect(calls).toHaveLength(0);
		const env = await envUp(child("ACME-2"), "ACME-0", {
			exec,
			profile,
			repoRoot,
			dir,
			freeMb: () => 99_999,
		});
		const lines = calls.map(line);
		expect(lines.some((l) => /createdb|dropdb/.test(l))).toBe(false);
		const file = readFileSync(env.envFile, "utf8");
		expect(file).not.toContain("DATABASE_URL");
		expect(file).toContain(`PORT=${env.port}`);
	});
	it("runs migrate.cmd through sh in the configured cwd", async () => {
		const base = neutral();
		const { dir, repoRoot, profile } = setup(base);
		const { exec, calls } = fakeExec();
		await envTemplate("ACME-0", { exec, profile, repoRoot, dir });
		const m = calls.at(-1);
		expect(m?.cmd).toBe("sh");
		expect(m?.args[0]).toBe("-c");
		expect(m?.args[1]).toBe(base.db?.migrate.cmd);
		expect(m?.cwd).toBe(join(repoRoot, base.packageDir));
		const root = {
			...profile,
			db: {
				...(profile.db as NonNullable<Profile["db"]>),
				migrate: { cmd: "m", cwd: "root" },
			},
		} as Profile;
		const again = fakeExec();
		await envTemplate("ACME-0", {
			...{ dir, repoRoot },
			exec: again.exec,
			profile: root,
		});
		expect(again.calls.at(-1)?.cwd).toBe(repoRoot);
	});
	it("portEnv writes each name with the worker's port", async () => {
		const base = neutral({ portEnv: ["A_PORT", "B_PORT"] });
		const { dir, repoRoot, profile } = setup(base);
		const { exec } = fakeExec((c) => mk(c, base.packageDir));
		const env = await envUp(child("ACME-2"), "ACME-0", {
			exec,
			profile,
			repoRoot,
			dir,
			freeMb: () => 99_999,
		});
		const file = readFileSync(env.envFile, "utf8");
		expect(file).toContain(`A_PORT=${env.port}\nB_PORT=${env.port}\n`);
	});
	it("a service starts only when a child touches its globs and gets the port in its env", async () => {
		const base = neutral();
		const svc = base.services[0];
		const { dir, repoRoot, profile } = setup(base);
		const { exec, calls, line } = fakeExec((c) => mk(c, base.packageDir));
		const quiet = await envUp(child("ACME-2"), "ACME-0", {
			exec,
			profile,
			repoRoot,
			dir,
			freeMb: () => 99_999,
		});
		expect(calls.map(line).some((l) => l.startsWith("docker run"))).toBe(false);
		expect(quiet.servicePorts).toBeUndefined();
		const hit = child("ACME-3", {
			touches: [`${base.packageDir}/src/search/x.ts`],
		});
		const env = await envUp(hit, "ACME-0", {
			exec,
			profile,
			repoRoot,
			dir,
			freeMb: () => 99_999,
		});
		const port = env.servicePorts?.[svc?.name as string];
		expect(port).toBeDefined();
		expect(calls.map(line)).toContain(
			`docker run -d --name portia-${svc?.name}-acme-3 -p ${port}:${svc?.containerPort} ${svc?.image} ${svc?.args.join(" ")}`,
		);
		expect(readFileSync(env.envFile, "utf8")).toContain(`SEARCH_PORT=${port}`);
	});
});

describe("envUp reuse", () => {
	const git = (cwd: string, ...a: string[]) =>
		execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
	const realGit: Exec = async (cmd, args, opts = {}) => {
		if (cmd !== "git") return { code: 0, stdout: "", stderr: "" };
		try {
			return {
				code: 0,
				stdout: execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8" }),
				stderr: "",
			};
		} catch (e) {
			return { code: 1, stdout: "", stderr: String(e) };
		}
	};
	const repo = () => {
		const origin = mkdtempSync(join(tmpdir(), "portia-origin-"));
		git(origin, "init", "-q", "-b", "main");
		git(origin, "config", "user.email", "t@t");
		git(origin, "config", "user.name", "t");
		mkdirSync(join(origin, "packages/app"), { recursive: true });
		writeFileSync(join(origin, "packages/app/.keep"), "");
		git(origin, "add", ".");
		git(origin, "commit", "-q", "-m", "base");
		git(origin, "branch", "portia/ACME-0");
		const { dir, repoRoot, profile } = setup(testProfile());
		rmSync(repoRoot, { recursive: true });
		git(tmpdir(), "clone", "-q", origin, repoRoot);
		git(repoRoot, "config", "user.email", "t@t");
		git(repoRoot, "config", "user.name", "t");
		return { dir, repoRoot, profile };
	};
	const up = (r: ReturnType<typeof repo>, exec: Exec) =>
		envUp(child("ACME-2"), "ACME-0", {
			exec,
			profile: r.profile,
			repoRoot: r.repoRoot,
			dir: r.dir,
			freeMb: () => 99_999,
		});

	it("a second env up reuses the worktree and does not add again", async () => {
		const r = repo();
		const first = await up(r, realGit);
		writeFileSync(join(first.worktree, "work.txt"), "x");
		git(first.worktree, "add", ".");
		git(first.worktree, "commit", "-q", "-m", "work");
		const seen: string[] = [];
		const wrapped: Exec = (cmd, args, o) => {
			seen.push([cmd, ...args].join(" "));
			return realGit(cmd, args, o);
		};
		const second = await up(r, wrapped);
		expect(second).toEqual(first);
		expect(seen.some((l) => l.startsWith("git worktree add"))).toBe(false);
		expect(readFileSync(join(first.worktree, "work.txt"), "utf8")).toBe("x");
	});

	/** A sibling lands: a commit on the integration branch in origin, after the worktree was made. */
	const land = (r: ReturnType<typeof repo>, file: string, text: string) => {
		const origin = git(r.repoRoot, "remote", "get-url", "origin");
		git(origin, "checkout", "-q", "portia/ACME-0");
		writeFileSync(join(origin, file), text);
		git(origin, "add", ".");
		git(origin, "commit", "-q", "-m", `land ${file}`);
		git(origin, "checkout", "-q", "main");
	};
	const commit = (wt: string, file: string, text: string) => {
		writeFileSync(join(wt, file), text);
		git(wt, "add", ".");
		git(wt, "commit", "-q", "-m", `work ${file}`);
	};

	it("rebases a reused worktree onto a sibling that landed since it was made", async () => {
		const r = repo();
		const first = await up(r, realGit);
		commit(first.worktree, "work.txt", "x");
		land(r, "sibling.txt", "landed");
		const again = await up(r, realGit);
		expect(again.behind).toBeUndefined();
		expect(readFileSync(join(again.worktree, "sibling.txt"), "utf8")).toBe(
			"landed",
		);
		expect(readFileSync(join(again.worktree, "work.txt"), "utf8")).toBe("x");
		expect(git(again.worktree, "log", "-1", "--format=%s")).toBe(
			"work work.txt",
		);
	});

	it("logs the heads a rebase moved the worktree between, and nothing when it stayed put", async () => {
		const r = repo();
		const first = await up(r, realGit);
		commit(first.worktree, "work.txt", "x");
		const before = git(first.worktree, "rev-parse", "HEAD");
		land(r, "sibling.txt", "landed");
		const again = await up(r, realGit);
		const after = git(again.worktree, "rev-parse", "HEAD");
		const rebased = () =>
			readRows(r.dir).rows.filter(
				(x) => x.stage === "env" && x.status === "rebased",
			);
		expect(rebased()).toEqual([
			expect.objectContaining({
				child: "ACME-2",
				data: { from: before, to: after },
			}),
		]);
		await up(r, realGit);
		expect(rebased()).toHaveLength(1);
	});

	it("keeps the old base and says why when the rebase conflicts", async () => {
		const r = repo();
		const first = await up(r, realGit);
		commit(first.worktree, "packages/app/.keep", "mine");
		const head = git(first.worktree, "rev-parse", "HEAD");
		land(r, "packages/app/.keep", "theirs");
		const again = await up(r, realGit);
		expect(again.behind).toMatch(/still on its old base.*conflicts/);
		expect(git(again.worktree, "rev-parse", "HEAD")).toBe(head);
		expect(git(again.worktree, "status", "--porcelain")).toBe("");
		// Recorded, so the brief rendered from the env state says so.
		expect(
			JSON.parse(readFileSync(join(r.dir, "env-ACME-2.json"), "utf8")).behind,
		).toBe(again.behind);
	});

	it("never rebases a worktree with uncommitted changes", async () => {
		const r = repo();
		const first = await up(r, realGit);
		writeFileSync(join(first.worktree, "packages/app/.keep"), "draft");
		const head = git(first.worktree, "rev-parse", "HEAD");
		land(r, "sibling.txt", "landed");
		const again = await up(r, realGit);
		expect(again.behind).toMatch(/uncommitted changes/);
		expect(git(again.worktree, "rev-parse", "HEAD")).toBe(head);
		expect(
			readFileSync(join(again.worktree, "packages/app/.keep"), "utf8"),
		).toBe("draft");
		// Once committed and caught up, the note goes.
		git(again.worktree, "commit", "-qam", "draft");
		const third = await up(r, realGit);
		expect(third.behind).toBeUndefined();
		expect(existsSync(join(third.worktree, "sibling.txt"))).toBe(true);
	});

	it("exits 11 and never resets when it cannot inspect the branch refs", async () => {
		const r = repo();
		const seen: string[] = [];
		const broken: Exec = async (cmd, args, o) => {
			seen.push([cmd, ...args].join(" "));
			if (args[0] === "for-each-ref")
				return { code: 128, stdout: "", stderr: "boom" };
			return realGit(cmd, args, o);
		};
		await expect(up(r, broken)).rejects.toThrow(PortiaProblem);
		expect(seen.some((l) => l.startsWith("git worktree add"))).toBe(false);
	});

	it("re-adds a removed worktree on its existing branch without resetting it", async () => {
		const r = repo();
		const first = await up(r, realGit);
		writeFileSync(join(first.worktree, "work.txt"), "x");
		git(first.worktree, "add", ".");
		git(first.worktree, "commit", "-q", "-m", "work");
		const sha = git(first.worktree, "rev-parse", "HEAD");
		rmSync(first.worktree, { recursive: true, force: true });
		rmSync(join(r.dir, "env-ACME-2.json"));
		const seen: string[] = [];
		const spy: Exec = (cmd, args, o) => {
			seen.push([cmd, ...args].join(" "));
			return realGit(cmd, args, o);
		};
		const again = await up(r, spy);
		expect(seen.some((l) => l.startsWith("git worktree add -B"))).toBe(false);
		expect(seen.some((l) => l.startsWith("git worktree add"))).toBe(true);
		expect(git(again.worktree, "rev-parse", "HEAD")).toBe(sha);
	});
});
