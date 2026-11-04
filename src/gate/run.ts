import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import picomatch from "picomatch";
import { childKeyOf, integrationBranch } from "../core/branches";
import type { DebtRuleSpec, GateStep, Profile } from "../core/config";
import type { Exec, ExecResult } from "../core/exec";
import { appendRow } from "../core/runlog";
import type { Lane } from "../core/types";
import type { WorkerEnv } from "../env/env";
import type { OwnedScenario } from "../plan/owned";
import { inPackage, pkgRelative, repoPath } from "../plan/paths";
import { debtHits, keyPatternFor } from "./debt";
import { withLock } from "./lock";
import { flaggedLine, type SpecRun, specRun } from "./satisfiable";
import { secretRule, secretStep } from "./secrets";
import { type SpecGuard, specStep, untitledScenarios } from "./specs";

export interface GateCtx {
	exec: Exec;
	profile: Profile;
	dir: string;
	env: WorkerEnv;
	parent: string;
	touched: string[];
	designCheck?: () => Promise<{ ok: boolean; tail: string }>;
	/** The acceptance scenarios this child implements; none for the spine. */
	owned?: OwnedScenario[];
	/** The spine specs the exit gate keeps this child from weakening; none for the spine. */
	guard?: SpecGuard;
	/**
	 * Set only by a land's re-gate (R6): the scenarios children landed earlier made pass. A
	 * copy of the first `{owned}` step named `regression-guard` runs them; none, and there is no copy.
	 */
	regressionGuard?: OwnedScenario[];
	/**
	 * The spine's specs for the scenarios later children deliver. Its exit gate runs each once
	 * with the first `{owned}` step, and fails one that fails on an error in the test code (a
	 * runtime, matcher, syntax or import error) instead of an assertion: no implementation can
	 * make that pass by building the feature. None for any other child.
	 */
	failing?: OwnedScenario[];
	/** Children whose landing the owned scenarios not in `owned` still wait on. */
	waitingOn?: string[];
	/** The child's lane; full when unset. */
	lane?: Lane;
	/**
	 * What `{base}` and the debt diff compare against; `origin/<integration branch>` when unset.
	 * A land pins it to the commit it rebased onto, which a sibling's fetch cannot move.
	 */
	base?: string;
}
export interface GateReport {
	kind: "task" | "exit";
	ok: boolean;
	steps: { name: string; ok: boolean; tail: string }[];
}

export const quote = (f: string) => `'${f.replaceAll("'", "'\\''")}'`;

export function envVars(file: string): Record<string, string> {
	if (!existsSync(file)) return {};
	return Object.fromEntries(
		readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.includes("="))
			.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
	);
}
/** A gate step's env: TZ, then the profile's gateEnv, then the worker's env file, which wins. */
export const gateVars = (
	p: Pick<Profile, "gateEnv">,
	envFile: string,
): Record<string, string> => ({
	TZ: "Europe/London",
	...p.gateEnv,
	...envVars(envFile),
});
/** Why a step with `whenTouches` is skipped for these changed files, or undefined to run it. */
export function untouchedSkip(
	step: Pick<GateStep, "whenTouches">,
	changed: string[],
): string | undefined {
	if (!step.whenTouches?.length) return undefined;
	const match = picomatch(step.whenTouches, { dot: true });
	return changed.some((f) => match(f))
		? undefined
		: `skipped: no changed file matches ${step.whenTouches.join(", ")}`;
}
/** Runs a step, again up to `retries` times while it fails; the last run's result stands. */
export async function withRetries(
	retries: number | undefined,
	run: () => Promise<ExecResult>,
): Promise<{ r: ExecResult; tail: string }> {
	let r = await run();
	let n = 0;
	for (; r.code !== 0 && n < (retries ?? 0); n++) r = await run();
	const out = tail(r.stdout + r.stderr);
	return { r, tail: n ? `(retried ${n}x)\n${out}` : out };
}
export const tail = (s: string) => s.trim().split("\n").slice(-30).join("\n");
/** Output kept per stream of a gate step: far more than the 30 lines its report shows. */
export const STEP_TAIL = 256 * 1024;

/** The debt check on a diff range; a failing git diff fails the step (fail closed). */
export async function debtStep(
	exec: Exec,
	cwd: string,
	range: string,
	rules: DebtRuleSpec[],
	parentKey: string,
): Promise<GateReport["steps"][number]> {
	const diff = await exec("git", ["diff", "-U0", range], { cwd });
	if (diff.code !== 0)
		return { name: "debt", ok: false, tail: tail(diff.stderr) };
	const hits = debtHits(diff.stdout, rules, keyPatternFor(parentKey));
	return {
		name: "debt",
		ok: hits.length === 0,
		tail: hits
			.map(
				(h) =>
					`${h.rule}: ${h.file}: ${secretRule(h.line) ? "(line withheld: it looks like a secret)" : h.line.trim()}`,
			)
			.join("\n"),
	};
}

export async function runGate(
	kind: "task" | "exit",
	ctx: GateCtx,
): Promise<GateReport> {
	const { exec, profile: p, env } = ctx;
	const vars = gateVars(p, env.envFile);
	const base = ctx.base ?? `origin/${integrationBranch(p, ctx.parent)}`;
	const pkg = join(env.worktree, p.packageDir);
	const files = ctx.touched
		.filter(
			(f) => inPackage(f, p.packageDir) && existsSync(join(env.worktree, f)),
		)
		.map((f) => quote(pkgRelative(f, p.packageDir)))
		.join(" ");
	const inRepo = (list: OwnedScenario[] = []) =>
		list.map((o) => ({
			...o,
			path: repoPath(o.path, p.packageDir, env.worktree),
		}));
	const queue: { s: GateStep; scenarios: OwnedScenario[] }[] = [];
	for (const s of p.gates[kind]) {
		const first =
			s.cmd.includes("{owned}") &&
			!queue.some((x) => x.s.cmd.includes("{owned}"));
		queue.push({ s, scenarios: inRepo(ctx.owned) });
		if (first && ctx.regressionGuard?.length)
			queue.push({
				s: { ...s, name: "regression-guard" },
				scenarios: inRepo(ctx.regressionGuard),
			});
	}
	const steps: GateReport["steps"] = [];
	const lane = ctx.lane ?? "full";
	for (const { s, scenarios: owned } of queue) {
		const ownedPaths = [...new Set(owned.map((o) => o.path))]
			.map((f) => quote(relative(p.packageDir, f)))
			.join(" ");
		if (s.lanes && !s.lanes.includes(lane)) {
			steps.push({
				name: s.name,
				ok: true,
				tail: `skipped: not run in the ${lane} lane`,
			});
			continue;
		}
		const untouched = untouchedSkip(s, ctx.touched);
		if (untouched) {
			steps.push({ name: s.name, ok: true, tail: untouched });
			continue;
		}
		if (s.cmd.includes("{files}") && !files) {
			steps.push({ name: s.name, ok: true, tail: "skipped: no files" });
			continue;
		}
		if (s.cmd.includes("{owned}") && !ownedPaths) {
			steps.push({
				name: s.name,
				ok: true,
				tail: ctx.waitingOn?.length
					? `skipped: no owned scenarios ready (waiting on ${ctx.waitingOn.join(", ")})`
					: "skipped: no owned scenarios",
			});
			continue;
		}
		const untitled = s.cmd.includes("{owned}")
			? untitledScenarios(env.worktree, owned)
			: [];
		if (untitled.length) {
			steps.push({ name: s.name, ok: false, tail: untitled.join("\n") });
			break;
		}
		const cmd = s.cmd
			.replaceAll("{files}", files)
			.replaceAll("{owned}", ownedPaths)
			.replaceAll("{ownedGrep}", owned.map((o) => o.id).join("|"))
			.replaceAll("{base}", base)
			.replaceAll("{child}", childKeyOf(p, env.branch) ?? env.branch)
			.replaceAll("{parent}", ctx.parent);
		const run = () =>
			withRetries(s.retries, () =>
				exec("sh", ["-c", cmd], {
					cwd: s.cwd === "package" ? pkg : env.worktree,
					env: vars,
					keepTail: STEP_TAIL,
				}),
			);
		const { r, tail: out } = s.heavy
			? await withLock(ctx.dir, run)
			: await run();
		steps.push({ name: s.name, ok: r.code === 0, tail: out });
		if (r.code !== 0) break;
	}
	const proved: { id: string; path: string; kind: SpecRun }[] = [];
	const ownedStep = queue.find((x) => x.s.cmd.includes("{owned}"))?.s;
	if (
		kind === "exit" &&
		steps.every((s) => s.ok) &&
		ctx.failing?.length &&
		ownedStep
	) {
		const flagged: string[] = [];
		for (const o of inRepo(ctx.failing)) {
			const cmd = ownedStep.cmd
				.replaceAll("{owned}", quote(relative(p.packageDir, o.path)))
				.replaceAll("{ownedGrep}", o.id)
				.replaceAll("{files}", files)
				.replaceAll("{base}", base)
				.replaceAll("{child}", childKeyOf(p, env.branch) ?? env.branch)
				.replaceAll("{parent}", ctx.parent);
			const go = () =>
				exec("sh", ["-c", cmd], {
					cwd: ownedStep.cwd === "package" ? pkg : env.worktree,
					env: vars,
					keepTail: STEP_TAIL,
				});
			const r = ownedStep.heavy ? await withLock(ctx.dir, go) : await go();
			const run = specRun(o.path, r.code, `${r.stdout}\n${r.stderr}`);
			proved.push({ id: o.id, path: o.path, kind: run.kind });
			if (run.kind === "load" || run.kind === "error")
				flagged.push(flaggedLine(o.id, o.path, run));
		}
		steps.push({
			name: "satisfiable",
			ok: !flagged.length,
			tail: flagged.length
				? flagged.join("\n")
				: proved.map((x) => `${x.id} ${x.path}: ${x.kind}`).join("\n"),
		});
	}
	if (kind === "exit" && steps.every((s) => s.ok) && ctx.guard) {
		const specs = Object.fromEntries(
			Object.entries(ctx.guard.specs).map(([id, f]) => [
				id,
				repoPath(f, p.packageDir, env.worktree),
			]),
		);
		steps.push(
			await specStep(exec, env.worktree, base, { ...ctx.guard, specs }),
		);
	}
	if (kind === "exit" && steps.every((s) => s.ok) && ctx.designCheck) {
		const d = await ctx.designCheck();
		steps.push({ name: "design", ok: d.ok, tail: d.tail });
	}
	if (kind === "exit" && steps.every((s) => s.ok)) {
		steps.push(
			await debtStep(exec, env.worktree, `${base}...HEAD`, p.debt, ctx.parent),
			await secretStep(exec, env.worktree, p, { base, head: "HEAD" }, vars),
		);
	}
	const report: GateReport = { kind, ok: steps.every((s) => s.ok), steps };
	appendRow(ctx.dir, {
		child: childKeyOf(p, env.branch) ?? env.branch,
		attempt: 0,
		stage: "gate",
		status: report.ok ? "pass" : "fail",
		data: {
			kind,
			steps: steps.map((s) => ({ name: s.name, ok: s.ok })),
			// How each spine spec failed on the spine's branch: an assertion, an error or a load failure.
			...(proved.length ? { specs: proved } : {}),
		},
	});
	return report;
}
