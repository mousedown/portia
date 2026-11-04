import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writePlanSnapshot } from "../../src/core/plan-snapshot";
import { appendRow } from "../../src/core/runlog";
import { listRuns, loadRun } from "../../src/core/runs";
import { child, parent, spine } from "../helpers/plan";

function home() {
	const h = mkdtempSync(join(tmpdir(), "portia-runs-"));
	const env = { PORTIA_HOME: h };
	const run = (key: string) => {
		const dir = join(h, "runs", key);
		mkdirSync(dir, { recursive: true });
		return dir;
	};
	return { h, env, run };
}

const row = (
	child: string,
	stage: "dispatched" | "result",
	tokens?: number,
) => ({
	at: "2026-10-01T10:00:00.000Z",
	child,
	attempt: 1,
	stage,
	...(tokens === undefined ? {} : { status: "done", tokens }),
});

it("lists every run under the Portia home with its rows, plan and directory", () => {
	const { env, run } = home();
	const a = run("ACME-0");
	const plan = parent([spine(), child("ACME-2")]);
	writePlanSnapshot(a, plan);
	appendRow(a, row("ACME-2", "dispatched"));
	appendRow(a, row("ACME-2", "result", 500));
	const b = run("ACME-9");
	appendRow(b, row("ACME-10", "dispatched"));
	const runs = listRuns([], env);
	expect(runs.map((r) => r.key)).toEqual(["ACME-0", "ACME-9"]);
	const [first] = runs;
	expect(first).toMatchObject({
		key: "ACME-0",
		dir: a,
		source: "plan",
		plan,
		warnings: [],
	});
	expect(first?.rows.map((r) => r.stage)).toEqual(["dispatched", "result"]);
});

it("lists a run without a plan snapshot, with its children from the run log and a warning", () => {
	const { env, run } = home();
	const dir = run("ACME-9");
	appendRow(dir, row("ACME-10", "dispatched"));
	appendRow(dir, row("ACME-11", "dispatched"));
	const r = loadRun("acme-9", env);
	expect(r.source).toBe("runlog");
	expect(r.plan.children.map((c) => c.key)).toEqual(["ACME-10", "ACME-11"]);
	expect(r.warnings).toEqual([
		"ACME-9: no plan.json; its children come from the run log",
	]);
});

it("counts unreadable run log lines and warns of them", () => {
	const { env, run } = home();
	const dir = run("ACME-0");
	writePlanSnapshot(dir, parent([spine()]));
	writeFileSync(join(dir, "runlog.jsonl"), "{not json\n");
	const r = loadRun("ACME-0", env);
	expect(r.skipped).toBe(1);
	expect(r.warnings).toEqual(["ACME-0: 1 unreadable run log line(s)"]);
});

it("reads only the named parents, and refuses a parent with no run", () => {
	const { h, env, run } = home();
	run("ACME-0");
	run("ACME-9");
	writeFileSync(join(h, "runs", "ports.json"), "[]");
	expect(listRuns(["acme-9"], env).map((r) => r.key)).toEqual(["ACME-9"]);
	expect(listRuns([], env).map((r) => r.key)).toEqual(["ACME-0", "ACME-9"]);
	expect(() => listRuns(["ACME-5"], env)).toThrow(
		`no run ACME-5 in ${join(h, "runs")}`,
	);
});

it("lists nothing under a home with no runs", () => {
	const { env } = home();
	expect(listRuns([], env)).toEqual([]);
});
