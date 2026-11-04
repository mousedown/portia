import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import picomatch from "picomatch";
import { writeFileAtomic } from "../core/atomic";
import { childBranch, integrationBranch } from "../core/branches";
import type { Profile, ServiceSpec } from "../core/config";
import { type Exec, isDryRun, must, REF_LOCKED } from "../core/exec";
import { PortiaProblem } from "../core/exit";
import { appendRow } from "../core/runlog";
import type { ChildPlan } from "../core/types";
import { allocatePort, releasePort, releasePorts } from "./ports";
import { probes } from "./slots";

export interface EnvCtx {
	exec: Exec;
	profile: Profile;
	repoRoot: string;
	dir: string;
	freeMb?: () => number;
}
export interface WorkerEnv {
	worktree: string;
	branch: string;
	db: string;
	port: number;
	/** Host port of each service started for this worker, by service name. */
	servicePorts?: Record<string, number>;
	envFile: string;
	/**
	 * Set when the integration tip has moved past the worktree's base and the worktree was
	 * kept on its old one: why, for the brief to say. Absent when it is on the tip.
	 */
	behind?: string;
}

const slug = (key: string) => key.toLowerCase().replace(/-/g, "_");
export const dbName = (prefix: string, key: string) => `${prefix}_${slug(key)}`;
const tplName = (prefix: string, parent: string) =>
	`${prefix}_tpl_${slug(parent)}`;
const container = (svc: string, key: string) =>
	`portia-${svc}-${key.toLowerCase()}`;
type Db = NonNullable<Profile["db"]>;
const pgArgs = (d: Db) => [
	"-h",
	d.pg.host,
	"-p",
	String(d.pg.port),
	"-U",
	d.pg.user,
];
const pgEnv = (d: Db) => ({ PGPASSWORD: d.pg.password });
const url = (d: Db, db: string) =>
	`postgresql://${d.pg.user}${d.pg.password ? `:${d.pg.password}` : ""}@${d.pg.host}:${d.pg.port}/${db}`;
export const stateFile = (dir: string, key: string) =>
	join(dir, `env-${key}.json`);
const literal = (g: string) => g.replace(/\*\*/g, "x/x").replace(/\*/g, "x");

const touchesGlobs = (c: ChildPlan, globs: string[]): boolean => {
	const match = picomatch(globs, { dot: true });
	return c.touches.some(
		(t) =>
			match(literal(t)) ||
			globs.some((g) => picomatch(t, { dot: true })(literal(g))),
	);
};

/** The profile's services this child's touches call for. */
export const servicesFor = (c: ChildPlan, p: Profile): ServiceSpec[] =>
	p.services.filter((s) => touchesGlobs(c, s.whenTouches));

export const REF_LOCK_TRIES = 5;

/** `exec`, with a command that failed only on git's ref lock tried again after a short, jittered wait. */
export const refLockRetry =
	(
		exec: Exec,
		wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
	): Exec =>
	async (cmd, args, opts) => {
		for (let i = 1; ; i++) {
			const r = await exec(cmd, args, opts);
			if (r.code === 0 || i >= REF_LOCK_TRIES || !REF_LOCKED.test(r.stderr))
				return r;
			await wait(100 * i + Math.random() * 400);
		}
	};

export async function envTemplate(parent: string, ctx: EnvCtx): Promise<void> {
	const { exec, profile: p } = ctx;
	const d = p.db;
	if (!d) return;
	const tpl = tplName(d.pg.prefix, parent);
	await exec("dropdb", [...pgArgs(d), "--if-exists", tpl], { env: pgEnv(d) });
	await must(exec, "createdb", [...pgArgs(d), tpl], { env: pgEnv(d) });
	const cwd =
		d.migrate.cwd === "root"
			? ctx.repoRoot
			: d.migrate.cwd === "package"
				? join(ctx.repoRoot, p.packageDir)
				: join(ctx.repoRoot, d.migrate.cwd);
	await must(exec, "sh", ["-c", d.migrate.cmd], {
		cwd,
		env: { DATABASE_URL: url(d, tpl) },
	});
}

export async function envUp(
	c: ChildPlan,
	parent: string,
	ctx: EnvCtx,
): Promise<WorkerEnv> {
	const { exec, profile: p } = ctx;
	const free = (ctx.freeMb ?? probes().freeMb)();
	if (free < p.minFreeMb)
		throw new PortiaProblem(
			`only ${Math.round(free)} MB free memory; the gate is ${p.minFreeMb} MB (X4)`,
		);
	const branch = childBranch(p, c.key);
	const worktree = join(p.worktreesDir, p.repo, c.key);
	const fetch = refLockRetry(exec);
	await must(fetch, "git", ["fetch", "origin", integrationBranch(p, parent)], {
		cwd: ctx.repoRoot,
	});
	const registered = existsSync(worktree)
		? await worktreeHolds(ctx, worktree, branch)
		: false;
	const tip = `origin/${integrationBranch(p, parent)}`;
	if (registered) {
		// A retry or resume: keep the worktree, its commits and (when recorded) its database and
		// ports, brought onto the tip when a sibling has landed since it was made.
		const behind = caughtUp(ctx, c.key, await catchUp(exec, worktree, tip));
		if (!existsSync(stateFile(ctx.dir, c.key)))
			return withBehind(
				ctx,
				c.key,
				await provision(worktree, c.key, parent, c, ctx),
				behind,
			);
		return withBehind(ctx, c.key, readEnv(ctx.dir, c.key), behind);
	}
	// Best effort: the branch may exist only on origin, or not at all.
	await fetch("git", ["fetch", "origin", branch], { cwd: ctx.repoRoot });
	const refs = await must(
		exec,
		"git",
		[
			"for-each-ref",
			"--format=%(refname)",
			`refs/heads/${branch}`,
			`refs/remotes/origin/${branch}`,
		],
		{ cwd: ctx.repoRoot },
	);
	const have = refs.split("\n").map((l) => l.trim());
	// Only a brand-new child resets onto the integration branch; existing commits are never discarded.
	if (have.includes(`refs/heads/${branch}`))
		await exec("git", ["worktree", "prune"], { cwd: ctx.repoRoot });
	const addArgs = have.includes(`refs/heads/${branch}`)
		? ["worktree", "add", worktree, branch]
		: have.includes(`refs/remotes/origin/${branch}`)
			? ["worktree", "add", "-b", branch, worktree, `origin/${branch}`]
			: ["worktree", "add", "-B", branch, worktree, tip];
	await must(exec, "git", addArgs, { cwd: ctx.repoRoot });
	try {
		// An existing branch may predate a sibling's landing; a new one is on the tip already.
		const behind = caughtUp(ctx, c.key, await catchUp(exec, worktree, tip));
		return withBehind(
			ctx,
			c.key,
			await provision(worktree, c.key, parent, c, ctx),
			behind,
		);
	} catch (e) {
		await envDown(c.key, parent, ctx);
		throw e;
	}
}

/** What catchUp did: why the worktree kept its old base, or the heads a rebase moved it between. */
export interface CaughtUp {
	behind?: string;
	moved?: { from: string; to: string };
}

const headOf = async (exec: Exec, worktree: string) => {
	const r = await exec("git", ["rev-parse", "HEAD"], { cwd: worktree });
	return r.code === 0 ? r.stdout.trim() : "";
};

/**
 * Brings a child's worktree onto the integration tip `tip` when the tip has moved past its
 * base, as land does: its commits are rebased onto the tip. Only a clean worktree is
 * rebased, and a rebase that conflicts is aborted, so the worktree is never left half
 * moved. `behind` says why it kept its old base; `moved` names the heads a rebase changed.
 */
export async function catchUp(
	exec: Exec,
	worktree: string,
	tip: string,
): Promise<CaughtUp> {
	const onTip = await exec(
		"git",
		["merge-base", "--is-ancestor", tip, "HEAD"],
		{
			cwd: worktree,
		},
	);
	if (onTip.code === 0) return {};
	const kept = `Your worktree is still on its old base: ${tip} has moved on (another child has landed) since it was made, and`;
	const status = await exec(
		"git",
		["status", "--porcelain", "--untracked-files=no"],
		{ cwd: worktree },
	);
	if (status.code !== 0 || status.stdout.trim())
		return {
			behind: `${kept} it has uncommitted changes, so it was not rebased. Commit them, then \`git rebase ${tip}\` before you rely on what landed.`,
		};
	const from = await headOf(exec, worktree);
	if ((await exec("git", ["rebase", tip], { cwd: worktree })).code === 0) {
		const to = await headOf(exec, worktree);
		return from && to && from !== to ? { moved: { from, to } } : {};
	}
	await exec("git", ["rebase", "--abort"], { cwd: worktree });
	return {
		behind: `${kept} rebasing your commits onto it conflicts, so it was not rebased. What landed is not in your worktree; land rebases you onto it, so resolve any conflict with it then.`,
	};
}

/**
 * Logs a rebase catchUp made as an `env` row with status `rebased`, so a park at the new head
 * is known for the same work as one at the old (drive's park-loop count); returns `behind`.
 */
function caughtUp(ctx: EnvCtx, key: string, c: CaughtUp): string | undefined {
	if (c.moved && !isDryRun())
		appendRow(ctx.dir, {
			child: key,
			attempt: 0,
			stage: "env",
			status: "rebased",
			data: { ...c.moved },
		});
	return c.behind;
}

/** The env as recorded, with `behind` set to what this env up found, or cleared. */
function withBehind(
	ctx: EnvCtx,
	key: string,
	env: WorkerEnv,
	behind: string | undefined,
): WorkerEnv {
	const { behind: _, ...rest } = env;
	const next: WorkerEnv = behind ? { ...rest, behind } : rest;
	if (env.behind !== next.behind && !isDryRun())
		writeFileAtomic(stateFile(ctx.dir, key), JSON.stringify(next));
	return next;
}

/**
 * Keeps a file Portia writes into a worktree out of every commit made there, whatever the
 * repository's own .gitignore says: its path goes in the clone's local exclude file
 * (`git rev-parse --git-path info/exclude`), which git reads and never commits.
 */
export async function excludeLocally(
	exec: Exec,
	worktree: string,
	file: string,
): Promise<void> {
	const r = await exec("git", ["rev-parse", "--git-path", "info/exclude"], {
		cwd: worktree,
	});
	const out = r.code === 0 ? r.stdout.trim() : "";
	// Not a git worktree (or git gave no path): there is nothing to keep it out of.
	if (!out) return;
	const exclude = isAbsolute(out) ? out : join(worktree, out);
	const line = `/${file.split("\\").join("/")}`;
	const lines = existsSync(exclude)
		? readFileSync(exclude, "utf8").split("\n")
		: [];
	if (lines.includes(line)) return;
	mkdirSync(dirname(exclude), { recursive: true });
	const sep = lines.length && lines.at(-1) !== "" ? "\n" : "";
	appendFileSync(exclude, `${sep}${line}\n`);
}

async function worktreeHolds(
	ctx: EnvCtx,
	worktree: string,
	branch: string,
): Promise<boolean> {
	const r = await ctx.exec("git", ["worktree", "list", "--porcelain"], {
		cwd: ctx.repoRoot,
	});
	const real = realpathSync(worktree);
	for (const block of r.stdout.split("\n\n")) {
		const lines = block.split("\n");
		const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
		if (
			path &&
			(path === worktree || path === real) &&
			lines.includes(`branch refs/heads/${branch}`)
		)
			return true;
	}
	return false;
}

/**
 * Database, ports, env file and dependencies for an existing worktree. On failure it
 * releases its own ports and removes the containers and database it started.
 */
export async function provision(
	worktree: string,
	key: string,
	parent: string,
	c: ChildPlan | undefined,
	ctx: EnvCtx,
): Promise<WorkerEnv> {
	const { exec, profile: p } = ctx;
	const d = p.db;
	const db = d ? dbName(d.pg.prefix, key) : "";
	const services = c ? servicesFor(c, p) : [];
	const allocated: number[] = [];
	const started: string[] = [];
	let cloned = false;
	try {
		const port = await allocatePort(ctx.dir, p.ports, key);
		allocated.push(port);
		const servicePorts: Record<string, number> = {};
		for (const svc of services) {
			const sp = await allocatePort(ctx.dir, p.ports, key);
			allocated.push(sp);
			servicePorts[svc.name] = sp;
		}
		const serviceLines = services.flatMap((svc) =>
			Object.entries(svc.env).map(
				([k, v]) =>
					`${k}=${v.replaceAll("{port}", String(servicePorts[svc.name]))}`,
			),
		);
		const pkg = join(worktree, p.packageDir);
		const mainEnv = join(ctx.repoRoot, p.packageDir, ".env");
		const dry = isDryRun();
		if (dry)
			console.error(
				`[dry-run] skip env files and state: ${worktree} is left untouched`,
			);
		if (!dry && existsSync(mainEnv) && mainEnv !== join(pkg, ".env"))
			copyFileSync(mainEnv, join(pkg, ".env"));
		const envFile = join(pkg, ".env.portia");
		const lines = [
			...p.portEnv.map((n) => `${n}=${port}`),
			...(d
				? [`DATABASE_URL=${url(d, db)}`, `DATABASE_URL_UNPOOLED=${url(d, db)}`]
				: []),
			...serviceLines,
		];
		// Written before the install, so a postinstall script that reads it finds it.
		if (!dry) {
			// It can hold a database password, so only this user reads it, also when it exists already.
			writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
			chmodSync(envFile, 0o600);
			await excludeLocally(exec, worktree, relative(worktree, envFile));
		}
		const cloneDb = async (d: Db) => {
			await exec("dropdb", [...pgArgs(d), "--if-exists", db], {
				env: pgEnv(d),
			});
			cloned = true;
			await must(
				exec,
				"createdb",
				[...pgArgs(d), "-T", tplName(d.pg.prefix, parent), db],
				{ env: pgEnv(d) },
			);
		};
		const startService = async (svc: ServiceSpec) => {
			const name = container(svc.name, key);
			started.push(name);
			// A container left by an earlier attempt that died part way would clash on its name.
			await exec("docker", ["rm", "-f", name]);
			await must(exec, "docker", [
				"run",
				"-d",
				"--name",
				name,
				"-p",
				`${servicePorts[svc.name]}:${svc.containerPort}`,
				svc.image,
				...svc.args,
			]);
		};
		// Independent once the ports are known: the database, each service and the install run side by side.
		const steps = await Promise.allSettled([
			...(d ? [cloneDb(d)] : []),
			...services.map(startService),
			// A repository with no package.json has nothing for bun to install.
			...(existsSync(join(worktree, "package.json"))
				? [
						must(exec, "bun", ["install", "--frozen-lockfile"], {
							cwd: worktree,
						}),
					]
				: []),
		]);
		const failed = steps.find((r) => r.status === "rejected");
		if (failed) throw failed.reason;
		const env: WorkerEnv = {
			worktree,
			branch: childBranch(p, key),
			db,
			port,
			servicePorts: Object.keys(servicePorts).length ? servicePorts : undefined,
			envFile,
		};
		if (!dry) writeFileAtomic(stateFile(ctx.dir, key), JSON.stringify(env));
		appendRow(ctx.dir, {
			child: key,
			attempt: 0,
			stage: "env",
			status: "up",
			data: { ...env },
		});
		return env;
	} catch (e) {
		// Best effort, so a retry starts clean: what this call started goes with it.
		await Promise.allSettled([
			...started.map((name) => exec("docker", ["rm", "-f", name])),
			...(d && cloned
				? [exec("dropdb", [...pgArgs(d), "--if-exists", db], { env: pgEnv(d) })]
				: []),
		]);
		for (const port of allocated) releasePort(ctx.dir, port);
		throw e;
	}
}

export function readEnv(dir: string, key: string): WorkerEnv {
	const f = stateFile(dir, key);
	if (!existsSync(f))
		throw new PortiaProblem(
			`${key} has no environment; run portia env up ${key}`,
		);
	return JSON.parse(readFileSync(f, "utf8")) as WorkerEnv;
}

export async function envDown(
	key: string,
	parent: string,
	ctx: EnvCtx,
): Promise<void> {
	const { exec, profile: p } = ctx;
	const d = p.db;
	// The database and every service go side by side; the worktree only once they are gone.
	await Promise.all([
		...(d
			? [
					exec(
						"dropdb",
						[...pgArgs(d), "--if-exists", dbName(d.pg.prefix, key)],
						{
							env: pgEnv(d),
						},
					),
				]
			: []),
		...p.services.map((svc) =>
			exec("docker", ["rm", "-f", container(svc.name, key)]),
		),
	]);
	// By owner, so ports a provision took before it died go too, recorded or not.
	releasePorts(ctx.dir, key);
	rmSync(stateFile(ctx.dir, key), { force: true });
	await exec(
		"git",
		["worktree", "remove", "--force", join(p.worktreesDir, p.repo, key)],
		{ cwd: ctx.repoRoot },
	);
	appendRow(ctx.dir, {
		child: key,
		attempt: 0,
		stage: "env",
		status: "down",
		data: { parent },
	});
}
