import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { integrationBranch } from "../core/branches";
import type { GateStep, Profile } from "../core/config";
import { type Exec, must } from "../core/exec";
import { appendRow } from "../core/runlog";
import type { ParentPlan } from "../core/types";
import { envDown, provision } from "../env/env";
import { spineSpecs } from "../plan/owned";
import { repoPath } from "../plan/paths";
import { withLock } from "./lock";
import { debtStep, gateVars, quote, untouchedSkip, withRetries } from "./run";
import { scenarioProblems } from "./specs";

export interface EpicReport {
	ok: boolean;
	steps: { name: string; ok: boolean; tail: string }[];
}

/** What a gate on the integration branch needs: the run, and the integration worktree. */
export interface IntegrationCtx {
	exec: Exec;
	profile: Profile;
	dir: string;
	plan: ParentPlan;
	integration: string;
	repoRoot: string;
}

/** The epic's environment, up for one gate on the integration branch, and how to fill a step there. */
export interface OnIntegration {
	vars: Record<string, string>;
	fill: (cmd: string) => string;
	/** The files the epic changes against main, read only when some step has `whenTouches`. */
	changed: string[];
}

/** The integration worktree reset to its branch on origin; returns that commit. Call it under the heavy lock. */
export async function resetToTip(ctx: IntegrationCtx): Promise<string> {
	const { exec, profile: p, plan, integration: wt } = ctx;
	await must(exec, "git", ["fetch", "origin"], { cwd: wt });
	await must(
		exec,
		"git",
		["reset", "--hard", `origin/${integrationBranch(p, plan.key)}`],
		{
			cwd: wt,
		},
	);
	return (await must(exec, "git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
}

/**
 * Runs `fn` with the epic's environment up in the integration worktree, and takes it down
 * after. `{acceptance}` becomes `acceptance`, already quoted and package-relative.
 */
export async function withIntegrationEnv<T>(
	ctx: IntegrationCtx,
	steps: GateStep[],
	acceptance: string,
	fn: (on: OnIntegration) => Promise<T>,
): Promise<T> {
	const { exec, profile: p, plan, integration: wt } = ctx;
	const key = `${plan.key}-EPIC`;
	const envCtx = { exec, profile: p, repoRoot: ctx.repoRoot, dir: ctx.dir };
	try {
		const env = await provision(wt, key, plan.key, undefined, envCtx);
		const diffFile = join(ctx.dir, "epic.diff");
		writeFileSync(
			diffFile,
			await must(exec, "git", ["diff", "origin/main...HEAD"], { cwd: wt }),
		);
		const fill = (s: string) =>
			s
				.replaceAll("{acceptance}", acceptance)
				.replaceAll("{base}", "origin/main")
				.replaceAll("{baseUrl}", `http://localhost:${env.port}`)
				.replaceAll("{diff}", diffFile)
				.replaceAll("{parent}", plan.key);
		const changed = steps.some((s) => s.whenTouches?.length)
			? (
					await must(
						exec,
						"git",
						["diff", "--name-only", "origin/main...HEAD"],
						{
							cwd: wt,
						},
					)
				)
					.split("\n")
					.filter(Boolean)
			: [];
		return await fn({ vars: gateVars(p, env.envFile), fill, changed });
	} finally {
		await envDown(key, plan.key, envCtx);
	}
}

/**
 * Runs `steps` in order in the integration worktree, appending to `out`, and stops at the
 * first failure. `skip` gives the reason a step is skipped, or undefined to run it.
 */
export async function runIntegrationSteps(
	ctx: IntegrationCtx,
	on: OnIntegration,
	steps: GateStep[],
	out: EpicReport["steps"],
	skip: (s: GateStep) => string | undefined = () => undefined,
): Promise<void> {
	const pkg = join(ctx.integration, ctx.profile.packageDir);
	for (const s of steps) {
		const skipped = untouchedSkip(s, on.changed) ?? skip(s);
		if (skipped) {
			out.push({ name: s.name, ok: true, tail: skipped });
			continue;
		}
		const { r, tail: t } = await withRetries(s.retries, () =>
			ctx.exec("sh", ["-c", on.fill(s.cmd)], {
				cwd: s.cwd === "package" ? pkg : ctx.integration,
				env: on.vars,
			}),
		);
		out.push({ name: s.name, ok: r.code === 0, tail: t });
		if (r.code !== 0) break;
	}
}

export async function runEpicGate(
	ctx: IntegrationCtx & { epicPr: number },
): Promise<EpicReport> {
	const { exec, profile: p, plan, integration: wt } = ctx;
	return withLock(ctx.dir, async () => {
		await resetToTip(ctx);
		const acceptance = [
			...new Set(
				plan.children
					.filter((c) => c.wave === 0)
					.flatMap((c) => Object.values(c.acceptance))
					.map((f) => repoPath(f, p.packageDir, wt)),
			),
		]
			.map((f) => quote(relative(p.packageDir, f)))
			.join(" ");
		const steps: GateStep[] = [
			...p.gates.epic,
			{
				name: "agent-browser",
				cmd: p.agentBrowser,
				heavy: true,
				cwd: "package",
			},
			{
				name: "second-vendor",
				cmd: p.secondVendor,
				heavy: false,
				cwd: "root",
			},
		];
		return withIntegrationEnv(ctx, steps, acceptance, async (on) => {
			const out: EpicReport["steps"] = [];
			if (steps.some((s) => s.cmd.includes("{acceptance}"))) {
				const specs = spineSpecs(plan);
				const problems = scenarioProblems(
					wt,
					plan.scenarios.flatMap(({ id }) => {
						const f = specs[id];
						return f ? [{ id, path: repoPath(f, p.packageDir, wt) }] : [];
					}),
				);
				out.push({
					name: "specs",
					ok: !problems.length,
					tail: problems.join("\n"),
				});
			}
			if (out.every((x) => x.ok))
				await runIntegrationSteps(ctx, on, steps, out);
			if (out.every((s) => s.ok))
				out.push(
					await debtStep(
						exec,
						wt,
						"origin/main...HEAD",
						ctx.profile.debt,
						plan.key,
					),
				);
			const ok = out.every((s) => s.ok);
			if (ok)
				await must(exec, "gh", ["pr", "ready", String(ctx.epicPr)], {
					cwd: wt,
				});
			appendRow(ctx.dir, {
				child: plan.key,
				attempt: 0,
				stage: "epic",
				status: ok ? "pass" : "fail",
				data: { steps: out.map((s) => ({ name: s.name, ok: s.ok })) },
			});
			return { ok, steps: out };
		});
	});
}
