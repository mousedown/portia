import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { landGateView } from "../../src/cli/commands/land";
import { type Profile, ProfileSchema } from "../../src/core/config";
import type { RunRow } from "../../src/core/types";
import { runGate } from "../../src/gate/run";
import fixture from "../fixtures/profile";
import { fakeExec } from "../helpers/fake-exec";
import { child, parent, spine } from "../helpers/plan";

const SPEC = "packages/acme-web/test/acceptance/invoices.test.ts";

/** The fixture profile as a person writes it, with one change. */
const parse = (o: Record<string, unknown>) =>
	ProfileSchema.parse({ ...fixture, ...o });
const guardOf = (p: Profile) =>
	(p as unknown as Record<string, unknown>).regressionGuard;

/** The exit gate at land for ACME-3, once ACME-2 (which owns F1) has landed. */
async function gateAtLand(profile: Profile) {
	const plan = parent(
		[
			spine({ acceptance: { F1: SPEC, F2: SPEC } }),
			child("ACME-2", { requirements: ["F1"] }),
			child("ACME-3", { requirements: ["F2"] }),
		],
		[
			{ id: "F1", text: "Given an invoice, Then its total includes VAT" },
			{ id: "F2", text: "Given a ledger, Then it exports as CSV" },
		],
	);
	const rows: RunRow[] = [
		{
			at: "2026-10-30T09:00:00.000Z",
			child: "ACME-2",
			attempt: 1,
			stage: "landed",
			status: "landed",
		},
	];
	const wt = mkdtempSync(join(tmpdir(), "portia-guard-"));
	mkdirSync(dirname(join(wt, SPEC)), { recursive: true });
	writeFileSync(
		join(wt, SPEC),
		'it("F1: Given an invoice, Then its total includes VAT", () => {});\nit("F2: Given a ledger, Then it exports as CSV", () => {});\n',
	);
	// As `portia land` builds it: the view of the run log, spread into the exit gate.
	const {
		child: _,
		owned,
		lane,
		...guard
	} = landGateView(profile, plan, [], rows, "ACME-3");
	const report = await runGate("exit", {
		exec: fakeExec().exec,
		profile,
		dir: mkdtempSync(join(tmpdir(), "portia-guard-run-")),
		env: {
			worktree: wt,
			branch: "epic/ACME-3",
			db: "",
			port: 3100,
			envFile: join(wt, ".env.portia"),
		},
		parent: plan.key,
		touched: [],
		...owned,
		...guard,
		lane,
	});
	return report.steps.map((s) => s.name);
}

it("G1: Given a profile with ratchet: false, Then it parses and turns the regression guard off, and with regressionGuard on the gate step is named regression-guard", async () => {
	const off = ProfileSchema.safeParse({ ...fixture, ratchet: false });
	expect(off.success).toBe(true);
	const legacy = parse({ ratchet: false });
	expect(guardOf(legacy)).toBe(false);
	const steps = await gateAtLand(legacy);
	expect(steps).toContain("acceptance");
	expect(steps).not.toContain("regression-guard");
	expect(steps).not.toContain("ratchet");

	const on = parse({ regressionGuard: true });
	expect(guardOf(on)).toBe(true);
	expect(guardOf(parse({}))).toBe(true);
	const guarded = await gateAtLand(on);
	expect(guarded).toContain("regression-guard");
	expect(guarded).not.toContain("ratchet");
	// It runs right after the child's own scenarios.
	expect(guarded.indexOf("regression-guard")).toBe(
		guarded.indexOf("acceptance") + 1,
	);
});
