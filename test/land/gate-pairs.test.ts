import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { landGateView } from "../../src/cli/commands/land";
import { realExec } from "../../src/core/exec";
import { readRows } from "../../src/core/runlog";
import { readEnv } from "../../src/env/env";
import { runGate } from "../../src/gate/run";
import { landPair, type PairGate, pairs } from "../helpers/gate-pairs";
import { child, parent, spine } from "../helpers/plan";
import "../acceptance/land-pairs.test";

const PAIRS = join(import.meta.dirname, "../fixtures/gate-pairs");
const names = readdirSync(PAIRS).filter((n) =>
	existsSync(join(PAIRS, n, "pair.json")),
);

const checkOf = (name: string) =>
	JSON.parse(readFileSync(join(PAIRS, name, "pair.json"), "utf8")) as {
		check: string;
		breaks: boolean;
	};

const passes = async (name: string, ...sides: string[]) => {
	const tree = mkdtempSync(join(tmpdir(), "gate-pair-"));
	for (const side of ["base", ...sides])
		cpSync(join(PAIRS, name, side), tree, { recursive: true });
	const r = await realExec("sh", ["-c", checkOf(name).check], { cwd: tree });
	return r.code === 0;
};

it.each(names)(
	"%s: each side passes alone, and the pair breaks only where declared",
	async (name) => {
		expect(await passes(name, "a")).toBe(true);
		expect(await passes(name, "b")).toBe(true);
		expect(await passes(name, "a", "b")).toBe(!checkOf(name).breaks);
	},
);

it("no breaking pair has both children writing the same path", () => {
	for (const name of names) {
		const files = (side: string) =>
			(
				readdirSync(join(PAIRS, name, side), { recursive: true }) as string[]
			).filter((f) => f.includes("."));
		const b = new Set(files("b"));
		expect(
			files("a").filter((f) => b.has(f)),
			name,
		).toEqual([]);
	}
});

/**
 * The exit gate a real profile runs at land: no check of the whole tree, only the child's own
 * scenarios by id, and the regression guard on the scenarios landed siblings made pass.
 */
const scenarioGate: PairGate =
	({ plan, profile, dir }) =>
	(key, onto) => {
		const { owned, lane, regressionGuard } = landGateView(
			profile,
			plan,
			[],
			readRows(dir).rows,
			key,
		);
		return runGate("exit", {
			exec: realExec,
			profile,
			dir,
			env: readEnv(dir, key),
			parent: plan.key,
			touched: [],
			...owned,
			regressionGuard,
			lane,
			base: onto,
		});
	};

const scenarioPlan = parent(
	[
		spine({
			acceptance: { F1: "specs/f1.spec.mjs", F2: "specs/f2.spec.mjs" },
		}),
		child("ACME-2", { requirements: ["F1"] }),
		child("ACME-3", { requirements: ["F2"] }),
	],
	[
		{ id: "F1", text: "hiding the assistant closes it" },
		{ id: "F2", text: "the assistant answers" },
	],
);

const landScenarios = (name: string, regressionGuard = true) => {
	const pair = pairs().find((p) => p.name === name);
	if (!pair) throw new Error(`no pair ${name}`);
	return landPair(pair, {
		plan: scenarioPlan,
		profile: {
			packageDir: ".",
			regressionGuard,
			gates: {
				task: [],
				exit: [
					{
						name: "acceptance",
						cmd: "bun check.mjs {owned}",
						heavy: false,
						cwd: "root",
					},
				],
				epic: [],
			},
		},
		gate: scenarioGate,
	});
};

it("a child that breaks a scenario a landed sibling made pass fails at R6 on the regression guard, and is not merged", async () => {
	const r = await landScenarios("changed-scenario-shape");
	expect(r.a.status).toBe("landed");
	expect(r.b).toMatchObject({
		status: "failed",
		reason: expect.stringMatching(
			/^exit gate failed on the rebased head \(R6\): regression-guard\n[\s\S]*F1: /,
		),
	});
	expect(r.landed).toEqual(["ACME-2"]);
	expect(r.merged).not.toContain(r.branchB);
	expect(r.integration).toMatchObject({ ok: true });
}, 120_000);

it("without the regression guard, the same child passes its own scenarios and lands, breaking its sibling's", async () => {
	const r = await landScenarios("changed-scenario-shape", false);
	expect(r.b.status).toBe("landed");
	expect(r.integration).toMatchObject({ ok: false });
}, 120_000);

it("a child that keeps a landed sibling's scenario passing lands through the regression guard", async () => {
	const r = await landScenarios("kept-scenario-shape");
	expect(r.a.status).toBe("landed");
	expect(r.b.status).toBe("landed");
	expect(r.landed).toEqual(["ACME-2", "ACME-3"]);
	expect(r.integration).toMatchObject({ ok: true });
}, 120_000);
