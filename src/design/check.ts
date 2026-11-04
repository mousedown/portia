import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type Profile, parsePersonaTarget } from "../core/config";
import { type Exec, isDryRun, must } from "../core/exec";
import type { ChildPlan } from "../core/types";
import type { WorkerEnv } from "../env/env";
import { envVars } from "../gate/run";
import { compareProps } from "./compare";
import { pixelVerdict } from "./pixel";
import { parseDesignRef } from "./ref";
import { generateSpec } from "./spec";
import { designDir, listFrames } from "./store";
import { aggregate } from "./verdict";

export interface DesignCtx {
	exec: Exec;
	profile: Profile;
	dir: string;
	env: WorkerEnv;
}

/** The gate closure for a design-led child, or undefined when the child has no design line. */
export const designGate = (c: ChildPlan | undefined, ctx: DesignCtx) =>
	c?.design ? () => designCheck(c, ctx) : undefined;

export async function designCheck(
	c: ChildPlan,
	ctx: DesignCtx,
): Promise<{ ok: boolean; tail: string }> {
	if (isDryRun()) return { ok: true, tail: "dry run: design check not run" };
	const ref = parseDesignRef(c.design ?? "");
	const frames = listFrames(ctx.dir, c.key).filter((f) =>
		ref.frames.includes(f.name),
	);
	if (frames.length < ref.frames.length)
		return { ok: false, tail: aggregate([], [], 0).summary };
	const target = ctx.profile.design.personas[ref.persona];
	if (!target)
		return {
			ok: false,
			tail: `design check did not run (never a PASS): persona '${ref.persona}' is not mapped in profile.design.personas`,
		};
	const persona = parsePersonaTarget(target);
	if (!persona)
		return {
			ok: false,
			tail: `design check did not run (never a PASS): persona '${ref.persona}' maps to '${target}', expected '<module relative to e2e>#<exportName>'`,
		};
	const out = designDir(ctx.dir, c.key);
	const pkg = join(ctx.env.worktree, ctx.profile.packageDir);
	const specDir = join(pkg, "e2e", "portia-design");
	mkdirSync(specDir, { recursive: true });
	const exclude = (
		await must(ctx.exec, "git", ["rev-parse", "--git-path", "info/exclude"], {
			cwd: ctx.env.worktree,
		})
	).trim();
	const excludePath = resolve(ctx.env.worktree, exclude);
	if (
		!existsSync(excludePath) ||
		!readFileSync(excludePath, "utf8").includes("e2e/portia-design/")
	)
		appendFileSync(excludePath, "\ne2e/portia-design/\n");
	const specFile = join(specDir, `design-${c.key}.e2e.ts`);
	writeFileSync(
		specFile,
		generateSpec({
			key: c.key,
			route: ref.route,
			personaModule: persona.module,
			personaExport: persona.name,
			outDir: out,
			frames,
		}),
	);
	try {
		const run = await ctx.exec(
			"bunx",
			[
				"playwright",
				"test",
				`e2e/portia-design/design-${c.key}.e2e.ts`,
				"--project=chromium",
				"--reporter=line",
			],
			{
				cwd: pkg,
				env: { TZ: "Europe/London", ...envVars(ctx.env.envFile) },
			},
		);
		if (run.code !== 0)
			return {
				ok: false,
				tail: `design check did not run (never a PASS):\n${(run.stdout + run.stderr).trim().split("\n").slice(-20).join("\n")}`,
			};
	} finally {
		rmSync(specFile, { force: true });
		try {
			rmdirSync(specDir);
		} catch {
			// not empty: leave it
		}
	}
	const checks = frames.flatMap((f) =>
		compareProps(
			JSON.parse(readFileSync(join(out, f.name, "values.json"), "utf8")),
			JSON.parse(readFileSync(join(out, `actual-${f.name}.json`), "utf8"))
				.values,
		),
	);
	const pixels = frames.map((f) =>
		pixelVerdict(
			readFileSync(join(out, f.name, "frame.png")),
			readFileSync(join(out, `actual-${f.name}.png`)),
			ctx.profile.design,
		),
	);
	const result = aggregate(checks, pixels, frames.length);
	writeFileSync(
		join(out, "verdict.json"),
		JSON.stringify({ verdict: result.verdict, checks, pixels }),
	);
	return { ok: result.ok, tail: result.summary };
}
