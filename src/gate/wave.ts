import { relative } from "node:path";
import { appendRow, readRows } from "../core/runlog";
import { landedScenarios, spineSpecs } from "../plan/owned";
import { repoPath } from "../plan/paths";
import {
	type EpicReport,
	type IntegrationCtx,
	resetToTip,
	runIntegrationSteps,
	withIntegrationEnv,
} from "./epic";
import { withLock } from "./lock";
import { quote } from "./run";

export interface WaveReport extends EpicReport {
	wave: number;
	/** The integration commit the steps ran on. */
	tip: string;
	/** Set when a pass was already recorded for this wave at this tip, and nothing ran. */
	reused?: true;
}

/**
 * The spine specs whose every scenario this run's landed children have made pass. A spec
 * that still holds a scenario of a later wave would fail on it, so it waits for that wave.
 */
function provenSpecs(ctx: IntegrationCtx): string {
	const { plan, profile: p, integration: wt } = ctx;
	const proven = new Set(
		landedScenarios(plan, readRows(ctx.dir).rows).map((o) => o.id),
	);
	const byPath = new Map<string, string[]>();
	for (const [id, path] of Object.entries(spineSpecs(plan)))
		byPath.set(path, [...(byPath.get(path) ?? []), id]);
	return [...byPath]
		.filter(([, ids]) => ids.every((id) => proven.has(id)))
		.map(([f]) => quote(relative(p.packageDir, repoPath(f, p.packageDir, wt))))
		.join(" ");
}

/**
 * The profile's `waveGate` steps, in the epic gate's order, once, on the integration tip after `wave` has landed. A
 * pass is recorded by wave and tip, and the same tip is never gated twice for one wave.
 * Steps get `PORTIA_WAVE`, so a step shared with the epic gate can tell the two apart.
 */
export function runWaveGate(
	ctx: IntegrationCtx,
	wave: number,
): Promise<WaveReport> {
	const p = ctx.profile;
	const names = p.waveGate?.steps ?? [];
	const steps = p.gates.epic.filter((s) => names.includes(s.name));
	return withLock(ctx.dir, async () => {
		const tip = await resetToTip(ctx);
		const passed = readRows(ctx.dir).rows.some(
			(r) =>
				r.stage === "wave-gate" &&
				r.status === "pass" &&
				r.data?.wave === wave &&
				r.data?.tip === tip,
		);
		if (passed) {
			console.error(
				`the wave ${wave} gate already passed on ${tip}; not running it again`,
			);
			return { ok: true, wave, tip, steps: [], reused: true };
		}
		const acceptance = provenSpecs(ctx);
		const out: EpicReport["steps"] = [];
		await withIntegrationEnv(ctx, steps, acceptance, (on) =>
			runIntegrationSteps(
				ctx,
				{ ...on, vars: { ...on.vars, PORTIA_WAVE: String(wave) } },
				steps,
				out,
				(s) =>
					s.cmd.includes("{acceptance}") && !acceptance
						? "skipped: no scenario has landed yet"
						: undefined,
			),
		);
		const ok = out.every((s) => s.ok);
		appendRow(ctx.dir, {
			child: ctx.plan.key,
			attempt: 0,
			stage: "wave-gate",
			status: ok ? "pass" : "fail",
			data: {
				wave,
				tip,
				steps: out.map((s) => ({ name: s.name, ok: s.ok })),
			},
		});
		return { ok, wave, tip, steps: out };
	});
}
