import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { writePlanSnapshot } from "../../src/core/plan-snapshot";
import { runDir } from "../../src/core/rundir";
import { appendRow, readRows } from "../../src/core/runlog";
import type { Finding, Ripple } from "../../src/core/types";
import { sandbox } from "../helpers/git-sandbox";
import { child, parent, spine } from "../helpers/plan";
import { FakeTracker } from "../support/fake-tracker";
import { portia, runLog } from "./support";

/** The fixture profile, with `packages/acme-web/src/generated/**` declared as generated output. */
const PROFILE = join(import.meta.dirname, "ripple-profile.ts");

const PKG = "packages/acme-web";
const TOTAL = `${PKG}/src/invoices/total.ts`;
/** A spec outside the invoices child's touches that imports its module. */
const TOTAL_SPEC = `${PKG}/test/invoices/total.test.ts`;
/** A spec that imports nothing the invoices child touches. */
const OTHER_SPEC = `${PKG}/test/other.test.ts`;
/** Production code outside the invoices child's touches that imports its module. */
const CSV = `${PKG}/src/ledger/csv.ts`;
/** A spec inside the ledger-specs child's touches. */
const LEDGER_SPEC = `${PKG}/test/ledger/csv.test.ts`;
const GENERATED = `${PKG}/src/generated/schema.ts`;
const ACCEPTANCE = `${PKG}/test/acceptance/invoices.test.ts`;

const PARENT_BLOCK =
	"scope: invoices\nscenario: F1 = Given an invoice, Then its total includes VAT";
const SPINE_BLOCK = `wave: 0\ntouches: ${PKG}/test/acceptance/**\nevidence: bunx vitest run ${ACCEPTANCE}\nacceptance: F1 = ${ACCEPTANCE}`;
/** Owns the invoice total, and holds the acceptance spec for it. */
const INVOICES_BLOCK = `wave: 1\nneeds: {spine} # the acceptance spec\ntouches: ${PKG}/src/invoices/**, ${ACCEPTANCE}\nrequirements: F1\nevidence: bunx vitest run ${PKG}/src/invoices`;
/** Same wave as the invoices child; owns the ledger specs. */
const LEDGER_BLOCK = `wave: 1\nneeds: {spine} # the acceptance spec\ntouches: ${PKG}/test/ledger/**\nrequirements: F1\nevidence: bunx vitest run ${PKG}/test/ledger`;

const BASE: Record<string, string> = {
	[`${PKG}/package.json`]: "{}\n",
	[TOTAL]: "export const total = (n: number) => n * 1.2;\n",
	[TOTAL_SPEC]: [
		'import { expect, it } from "vitest";',
		'import { total } from "../../src/invoices/total";',
		'it("adds VAT", () => expect(total(100)).toBe(120));',
		"",
	].join("\n"),
	[OTHER_SPEC]: [
		'import { expect, it } from "vitest";',
		'it("is unrelated", () => expect(1).toBe(1));',
		"",
	].join("\n"),
	[CSV]: [
		'import { total } from "../invoices/total";',
		'export const csv = (xs: number[]) => xs.map(total).join(",");',
		"",
	].join("\n"),
	[LEDGER_SPEC]: [
		'import { expect, it } from "vitest";',
		'import { csv } from "../../src/ledger/csv";',
		'it("exports", () => expect(csv([100])).toBe("120"));',
		"",
	].join("\n"),
	[GENERATED]: "export type Invoice = { total: number };\n",
};

const write = (root: string, files: Record<string, string>) => {
	for (const [f, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, f)), { recursive: true });
		writeFileSync(join(root, f), body);
	}
};

/** The tracker for epic `p`: its spine `p+1`, the invoices child `p+2` and the ledger-specs child `p+3`. */
function epic(p: number, planned = true) {
	const k = (n: number) => `ACME-${p + n}`;
	const fill = (b: string) => b.replace("{spine}", k(1));
	const issue = (key: string, summary: string, block?: string) => ({
		key,
		summary,
		description: block && planned ? `\`\`\`plan\n${block}\n\`\`\`` : summary,
		blockedBy: block && planned && key !== k(1) ? [k(1)] : [],
	});
	const tracker = new FakeTracker()
		.add(issue(k(0), "Invoices you can trust", PARENT_BLOCK))
		.add(issue(k(1), "The acceptance spec", SPINE_BLOCK), k(0))
		.add(issue(k(2), "Add VAT to the total", fill(INVOICES_BLOCK)), k(0))
		.add(issue(k(3), "Cover the ledger export", fill(LEDGER_BLOCK)), k(0));
	return {
		tracker,
		parent: k(0),
		spine: k(1),
		invoices: k(2),
		ledger: k(3),
		planFile: {
			parent: { block: PARENT_BLOCK },
			children: [
				{ key: k(1), block: SPINE_BLOCK, needs: [] },
				{ key: k(2), block: fill(INVOICES_BLOCK), needs: [k(1)] },
				{ key: k(3), block: fill(LEDGER_BLOCK), needs: [k(1)] },
			],
		},
	};
}

const ENV = [
	"PORTIA_PROFILE",
	"PORTIA_HOME",
	"PORTIA_DRY_RUN",
	"PORTIA_PROFILES_DIR",
	"PORTIA_NOTIFY",
] as const;
const saved = {
	cwd: process.cwd(),
	env: Object.fromEntries(ENV.map((k) => [k, process.env[k]])),
};
const restores: (() => void)[] = [];
let home = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "portia-ripple-"));
	process.env.PORTIA_PROFILE = PROFILE;
	process.env.PORTIA_HOME = home;
	process.env.PORTIA_NOTIFY = "0";
});

afterEach(() => {
	while (restores.length) restores.pop()?.();
	process.chdir(saved.cwd);
	for (const k of ENV) {
		const v = saved.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

/** The real CLI in this process, so it reads the in-memory tracker. */
async function cli(tracker: FakeTracker, ...argv: string[]) {
	restores.push(useTracker(tracker));
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, {
		out: (s) => out.push(s),
		err: (s) => err.push(s),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A checkout of the base files, with the integration branch of `parentKey` on origin. */
async function checkout(parentKey: string) {
	const s = await sandbox();
	write(s.repo, BASE);
	await s.g(s.repo, "add", ".");
	await s.g(s.repo, "commit", "-q", "-m", "the invoices app");
	await s.g(s.repo, "checkout", "-q", "-b", `epic/${parentKey}`);
	await s.g(s.repo, "push", "-q", "origin", `epic/${parentKey}`);
	process.chdir(s.repo);
	return s;
}

/** The plan check `plan write --dry-run --json` prints for the epic over the base files. */
async function dryRunPlan() {
	const e = epic(400, false);
	await checkout(e.parent);
	const from = join(home, "plan.json");
	writeFileSync(from, JSON.stringify(e.planFile));
	const r = await cli(
		e.tracker,
		"--dry-run",
		"plan",
		"write",
		e.parent,
		"--from",
		from,
		"--json",
	);
	expect(r.code, r.err).toBe(0);
	expect(e.tracker.writes).toEqual([]);
	return {
		e,
		report: JSON.parse(r.out) as {
			findings: Finding[];
			ripples?: Record<string, Ripple[]>;
		},
	};
}

it("R1: Given a child whose touches hold a module that a spec outside its touches imports, Then the dry-run plan check lists that spec as a test ripple of the child", async () => {
	const { e, report } = await dryRunPlan();
	const mine = report.ripples?.[e.invoices] ?? [];
	expect(mine).toContainEqual({ file: TOTAL_SPEC, kind: "test" });
	const files = mine.map((r) => r.file);
	expect(files, "a spec that imports nothing it touches").not.toContain(
		OTHER_SPEC,
	);
	expect(files, "a file inside its own touches").not.toContain(TOTAL);
});

it("R2: Given a production file outside a child's touches that imports one of its modules, Then the plan check reports a ripple warning naming the child and the file", async () => {
	const { e, report } = await dryRunPlan();
	const ripple = report.findings.filter((f) => f.rule === "ripple");
	expect(ripple).toContainEqual({
		rule: "ripple",
		level: "warn",
		child: e.invoices,
		message: expect.stringMatching(
			new RegExp(`(?=.*${e.invoices})(?=.*${CSV.replace(/\./g, "\\.")})`),
		),
	});
	expect(
		ripple.filter((f) => f.message.includes(TOTAL_SPEC)),
		"a test ripple is no warning",
	).toEqual([]);
});

/**
 * The invoices child's worker commits `files` on its branch off the integration branch and
 * reports done; `portia result` applies it as the orchestrator would.
 */
async function applyResult(files: Record<string, string>) {
	const e = epic(500);
	const s = await checkout(e.parent);
	await s.g(s.repo, "checkout", "-q", "-b", `epic/${e.invoices}`);
	write(s.repo, files);
	await s.g(s.repo, "add", ".");
	await s.g(s.repo, "commit", "-q", "-m", "add VAT");
	const head = (await s.g(s.repo, "rev-parse", "HEAD")).trim();
	const dir = runDir(e.parent);
	writeFileSync(
		join(dir, `env-${e.invoices}.json`),
		JSON.stringify({
			worktree: s.repo,
			branch: `epic/${e.invoices}`,
			db: "d",
			port: 3101,
			envFile: join(s.repo, ".env.portia"),
		}),
	);
	appendRow(dir, {
		child: e.invoices,
		attempt: 1,
		stage: "dispatched",
		model: { requested: "sonnet" },
	});
	const from = join(home, "result.json");
	writeFileSync(
		from,
		JSON.stringify({
			child: e.invoices,
			status: "done",
			head,
			gates: { task: "pass", exit: "pass" },
			evidence: { F1: "1 passed" },
		}),
	);
	const r = await cli(
		e.tracker,
		"result",
		e.invoices,
		"--parent",
		e.parent,
		"--from",
		from,
		"--tokens",
		"1000",
	);
	const row = readRows(dir).rows.find(
		(x) => x.child === e.invoices && x.stage === "result",
	);
	expect(row, r.err).toBeDefined();
	return { e, r, row, applied: JSON.parse(r.out) as { message: string } };
}

const VAT = "export const total = (n: number) => Math.round(n * 1.2);\n";
const byFile = (xs: Ripple[] = []) =>
	[...xs].sort((a, b) => a.file.localeCompare(b.file));

it("R3: Given a result that changed only test or generated files outside its touches, Then it is accepted rather than parked and those files are recorded as ripples on the result row", async () => {
	const { r, row } = await applyResult({
		[TOTAL]: VAT,
		[TOTAL_SPEC]: `${BASE[TOTAL_SPEC]}it("rounds", () => expect(total(0.5)).toBe(1));\n`,
		[GENERATED]: "export type Invoice = { total: number; vat: number };\n",
	});
	expect(row?.status, row?.data?.message as string).toBe("done");
	expect(r.code, r.err).toBe(0);
	expect(byFile(row?.ripples)).toEqual([
		{ file: GENERATED, kind: "generated" },
		{ file: TOTAL_SPEC, kind: "test" },
	]);
});

it("R4: Given a result that changed a production file outside its touches, Then it parks with touched files outside its Touches, naming only the production file, and records no ripples", async () => {
	const { row, applied } = await applyResult({
		[TOTAL]: VAT,
		[TOTAL_SPEC]: `${BASE[TOTAL_SPEC]}it("rounds", () => expect(total(0.5)).toBe(1));\n`,
		[CSV]: `${BASE[CSV]}export const header = "total";\n`,
	});
	expect(row?.status).toBe("parked");
	expect(applied.message).toMatch(/^touched files outside its Touches: /);
	expect(applied.message).toContain(CSV);
	expect(
		applied.message,
		"the question names only what needs the person: the test ripple rides along",
	).not.toContain(TOTAL_SPEC);
	expect(row?.ripples ?? [], "nothing is accepted from a park").toEqual([]);
});

it("R5: Given a result that changed a test file another child in the same wave touches, Then it parks, naming the file and the child that touches it", async () => {
	const { e, row, applied } = await applyResult({
		[TOTAL]: VAT,
		[LEDGER_SPEC]: `${BASE[LEDGER_SPEC]}it("rounds", () => expect(csv([0.5])).toBe("1"));\n`,
	});
	expect(row?.status).toBe("parked");
	expect(applied.message).toContain(LEDGER_SPEC);
	expect(applied.message, "it names the child that touches it").toContain(
		e.ledger,
	);
	expect(row?.ripples ?? []).toEqual([]);
});

it("R6: Given a landed child with recorded ripples, Then the ledger lists them for that child", async () => {
	const e = epic(600);
	await checkout(e.parent);
	const dir = runDir(e.parent);
	const ripples: Ripple[] = [
		{ file: TOTAL_SPEC, kind: "test" },
		{ file: GENERATED, kind: "generated" },
	];
	let pr = 0;
	for (const [key, mine] of [
		[e.spine, undefined],
		[e.invoices, ripples],
		[e.ledger, undefined],
	] as const) {
		appendRow(dir, { child: key, attempt: 1, stage: "dispatched" });
		appendRow(dir, {
			child: key,
			attempt: 1,
			stage: "result",
			status: "done",
			touchesMatched: mine === undefined,
			...(mine ? { ripples: [...mine] } : {}),
			data: { evidence: { F1: "1 passed" }, head: "a1b2c3d" },
		});
		appendRow(dir, {
			child: key,
			attempt: 1,
			stage: "landed",
			status: "landed",
			data: { pr: ++pr, sha: "a1b2c3d" },
		});
	}
	const r = await cli(e.tracker, "ledger", e.parent, "--print");
	expect(r.code, r.err).toBe(0);
	const lines = r.out.split("\n");
	for (const { file } of ripples)
		expect(
			lines.filter((l) => l.includes(file) && l.includes(e.invoices)),
			`a ledger line names ${e.invoices} and ${file}`,
		).not.toEqual([]);
	for (const other of [e.spine, e.ledger])
		expect(
			lines.filter(
				(l) => l.includes(other) && ripples.some((x) => l.includes(x.file)),
			),
			`${other} recorded no ripples`,
		).toEqual([]);
});

it("R7: Given run logs with parks of each kind, Then insights reports the parked cause split into test ripple, production ripple and question, with the tokens for each", () => {
	const key = "ACME-700";
	const log = runLog(home, key);
	writePlanSnapshot(log.dir, {
		...parent([
			spine({ key: "ACME-701" }),
			child("ACME-702"),
			child("ACME-703"),
			child("ACME-704"),
			child("ACME-705"),
		]),
		key,
	});
	const outside = (files: string[]) => ({
		message: `touched files outside its Touches: ${files.join(", ")}`,
		outside: files,
	});
	const parks: [string, Record<string, unknown>, number][] = [
		["ACME-702", outside([TOTAL_SPEC]), 1_000],
		["ACME-703", outside([TOTAL_SPEC, CSV]), 2_000],
		["ACME-704", { message: "Should the CSV include VAT?" }, 3_000],
	];
	log.add(0, "ACME-701", 1, "dispatched");
	log.add(5, "ACME-701", 1, "result", { status: "done", tokens: 500 });
	log.add(6, "ACME-701", 1, "landed", { status: "landed", data: { pr: 1 } });
	for (const [i, [c, data, tokens]] of parks.entries()) {
		const m = 10 + i * 20;
		log.add(m, c, 1, "dispatched");
		log.add(m + 4, c, 1, "result", { status: "parked", tokens: 400, data });
		log.add(m + 6, c, 2, "dispatched");
		log.add(m + 15, c, 2, "result", { status: "done", tokens });
		log.add(m + 16, c, 2, "landed", { status: "landed", data: { pr: i + 2 } });
	}
	log.add(70, "ACME-705", 1, "dispatched");
	log.add(74, "ACME-705", 1, "result", {
		status: "failed",
		tokens: 400,
		data: { message: "gate failed: test" },
	});
	log.add(74, "ACME-705", 0, "decision", {
		status: "park",
		data: { kind: "failure", by: "rule", why: "mentions secrets" },
	});
	log.add(76, "ACME-705", 2, "dispatched");
	log.add(85, "ACME-705", 2, "result", { status: "done", tokens: 4_000 });
	log.add(86, "ACME-705", 2, "landed", { status: "landed", data: { pr: 5 } });
	const r = portia(["insights", key, "--json"], {
		home,
		env: { PORTIA_PROFILE: PROFILE },
	});
	expect(r.code, r.err).toBe(0);
	const report = JSON.parse(r.out) as {
		causes: { kind: string; count: number; tokens: number }[];
		parks?: { on: string; count: number; tokens: number }[];
	};
	const parked = report.causes.filter((c) => c.kind === "parked");
	expect(parked.reduce((s, c) => s + c.tokens, 0)).toBe(10_000);
	expect(
		(report.parks ?? [])
			.filter((p) => p.count > 0)
			.sort((a, b) => a.on.localeCompare(b.on)),
		"a park on a failure keeps its own kind, apart from the three question kinds",
	).toEqual([
		{ on: "failure", count: 1, tokens: 4_000 },
		{ on: "production-ripple", count: 1, tokens: 2_000 },
		{ on: "question", count: 1, tokens: 3_000 },
		{ on: "test-ripple", count: 1, tokens: 1_000 },
	]);
});
