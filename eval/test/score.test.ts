import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmContext } from "../src/arms";
import { none } from "../src/arms/none";
import { childBranches } from "../src/arms/portia";
import { reference } from "../src/arms/reference";
import { git, gitOk } from "../src/metrics/git";
import { scoreBranch, scoreChecks } from "../src/score";
import type { Epic, Repo } from "../src/suite";

// The renamed-field pair from the gate fixture (#15), as a repo: on main an order has a
// total; branch a renames it to amount everywhere it is used; branch b adds a receipt line
// that reads total. Each passes `bun test` alone; merged, the receipt reads a field that is
// gone. No model runs: the checks are the fixture's own tests.
const BASE = {
	"order.ts": `export type Order = { id: string; total: number };
export const order = (id: string, total: number): Order => ({ id, total });
`,
	"summary.ts": `import type { Order } from "./order";
export const summary = (o: Order): string => \`\${o.id}: $\${o.total}\`;
`,
	"summary.test.ts": `import { expect, it } from "bun:test";
import { order } from "./order";
import { summary } from "./summary";
it("summarises an order", () => expect(summary(order("A-1", 12))).toBe("A-1: $12"));
`,
};
const A = {
	"order.ts": `export type Order = { id: string; amount: number };
export const order = (id: string, amount: number): Order => ({ id, amount });
`,
	"summary.ts": `import type { Order } from "./order";
export const summary = (o: Order): string => \`\${o.id}: $\${o.amount}\`;
`,
};
const B = {
	"receipt.ts": `import type { Order } from "./order";
export const receiptLine = (o: Order): string => \`Total due: $\${o.total.toFixed(2)}\`;
`,
	"receipt.test.ts": `import { expect, it } from "bun:test";
import { order } from "./order";
import { receiptLine } from "./receipt";
it("prints the total due", () => expect(receiptLine(order("A-1", 12))).toBe("Total due: $12.00"));
`,
};
// A third child that fails on its own: its failure is not late, whatever else is merged.
const RED = {
	"red.test.ts": `import { expect, it } from "bun:test";
it("is red", () => expect(1).toBe(2));
`,
};

const CHECKS = [`"${process.execPath}" test`];
const REPO: Repo = {
	name: "fixture",
	source: "x",
	main: "main",
	test: "bun test {file}",
	checks: CHECKS,
	epics: [],
};

let dir: string;
let clone: string;
const lines: string[] = [];
const log = (l: string) => lines.push(l);

async function commit(repo: string, files: Record<string, string>, m: string) {
	for (const [f, text] of Object.entries(files))
		writeFileSync(join(repo, f), text);
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-q", "-m", m]);
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eval-score-"));
	const source = join(dir, "source");
	await git(dir, ["init", "-q", "-b", "main", source]);
	for (const [k, v] of [
		["user.name", "eval"],
		["user.email", "eval@localhost"],
		["commit.gpgsign", "false"],
	] as const)
		await git(source, ["config", k, v]);
	await commit(source, BASE, "base");
	for (const [b, files] of [
		["a", A],
		["b", B],
		["red", RED],
	] as const) {
		await git(source, ["checkout", "-q", "-b", b, "main"]);
		await commit(source, files, b);
	}
	// The hand-written solution: both changes, made to agree.
	await git(source, ["checkout", "-q", "-b", "reference/ACME-500", "a"]);
	await commit(
		source,
		{ ...B, "receipt.ts": B["receipt.ts"].replace("o.total", "o.amount") },
		"reference",
	);
	await git(source, ["checkout", "-q", "main"]);
	clone = join(dir, "clone");
	await git(dir, ["clone", "-q", source, clone]);
	for (const [k, v] of [
		["user.name", "eval"],
		["user.email", "eval@localhost"],
		["commit.gpgsign", "false"],
	] as const)
		await git(clone, ["config", k, v]);
	for (const b of ["a", "b", "red"])
		await git(clone, ["branch", "-q", b, `origin/${b}`]);
	// What a merge-in-order arm leaves: a then b, merged cleanly, with nobody re-checking.
	await git(clone, ["checkout", "-q", "-b", "merged", "main"]);
	await git(clone, ["merge", "-q", "--no-ff", "-m", "merge a", "a"]);
	await git(clone, ["merge", "-q", "--no-ff", "-m", "merge b", "b"]);
	await git(clone, ["checkout", "-q", "-b", "merged-red", "merged"]);
	await git(clone, ["merge", "-q", "--no-ff", "-m", "merge red", "red"]);
	await git(clone, ["checkout", "-q", "main"]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const head = () => git(clone, ["rev-parse", "HEAD"]);
const sha = (ref: string) => git(clone, ["rev-parse", ref]);

describe("scoreChecks", () => {
	it("passes each child alone", async () => {
		for (const b of ["a", "b"]) {
			await git(clone, ["checkout", "-q", b]);
			const r = await scoreChecks(clone, REPO, { branch: b, log });
			expect(r.failed).toEqual([]);
			expect(r.late).toEqual([]);
		}
	});

	it("calls a failure late when two children pass alone and break merged", async () => {
		await git(clone, ["checkout", "-q", "merged"]);
		// As claude-parallel leaves it: a child still checked out in its worktree.
		await git(clone, ["worktree", "add", "-q", join(dir, "wt-b"), "b"]);
		const r = await scoreChecks(clone, REPO, {
			branch: "merged",
			childBranches: ["a", "b"],
			log,
		});
		expect(r.failed).toEqual(CHECKS);
		expect(r.late).toEqual(CHECKS);
		expect(r.late.length).toBeGreaterThanOrEqual(1);
		expect(Object.keys(r.output)).toEqual(["merged", "a", "b"]);
		await git(clone, ["worktree", "remove", join(dir, "wt-b")]);
		// The final branch's commit is checked out again, for whatever is scored after.
		expect(await head()).toBe(await sha("merged"));
	});

	it("does not call a failure late when a child had it on its own", async () => {
		await git(clone, ["checkout", "-q", "merged-red"]);
		const r = await scoreChecks(clone, REPO, {
			branch: "merged-red",
			childBranches: ["a", "b", "red"],
			log,
		});
		expect(r.failed).toEqual(CHECKS);
		expect(r.late).toEqual([]);
	});

	it("does not call a failure late on a branch with no children", async () => {
		await git(clone, ["checkout", "-q", "merged"]);
		const r = await scoreChecks(clone, REPO, { branch: "merged", log });
		expect(r.failed).toEqual(CHECKS);
		expect(r.late).toEqual([]);
	});

	it("does not call a failure late when a child cannot be checked out", async () => {
		await git(clone, ["checkout", "-q", "merged"]);
		const r = await scoreChecks(clone, REPO, {
			branch: "merged",
			childBranches: ["a", "no-such-branch"],
			log,
		});
		expect(r.late).toEqual([]);
		expect(await head()).toBe(await sha("merged"));
	});

	it("scores none and reference at 0 late failures", async () => {
		const ctx = {
			clone,
			repo: REPO,
			epic: { key: "ACME-500" },
			log,
		} as unknown as ArmContext;
		for (const arm of [none, reference]) {
			await git(clone, ["checkout", "-q", "main"]);
			const out = await arm.run(ctx);
			await git(clone, ["checkout", "-q", out.branch]);
			const r = await scoreChecks(clone, REPO, {
				branch: out.branch,
				childBranches: out.childBranches,
				log,
			});
			expect(r.failed).toEqual([]);
			expect(r.late).toHaveLength(0);
		}
	});
});

describe("portia childBranches", () => {
	it("finds each child beside the integration branch, local or pushed", async () => {
		await git(clone, ["branch", "-q", "epic/ACME-500", "main"]);
		await git(clone, ["branch", "-q", "epic/ACME-501", "a"]);
		await git(clone, ["update-ref", "refs/remotes/origin/epic/ACME-502", "b"]);
		expect(
			await childBranches(clone, "epic/ACME-500", "ACME-500", [
				"ACME-501",
				"ACME-502",
				"ACME-503",
			]),
		).toEqual(["epic/ACME-501", "origin/epic/ACME-502"]);
		expect(
			await childBranches(clone, "main", "ACME-500", ["ACME-501"]),
		).toEqual([]);
	});
});

describe("scoreBranch", () => {
	// What Portia leaves: its integration branch still checked out in its own worktree,
	// outside the clone, and a local settings file untracked in the clone's working tree.
	const EPIC = {
		key: "ACME-600",
		scenarios: [{ id: "S1", text: "an order has a summary" }],
	} as unknown as Epic;
	let hidden: string;
	let held: string;
	beforeAll(async () => {
		hidden = join(dir, "hidden");
		mkdirSync(hidden);
		writeFileSync(
			join(hidden, "S1.spec.ts"),
			`import { expect, it } from "bun:test";
import { order } from "../order";
import { summary } from "../summary";
it("S1", () => expect(summary(order("A-1", 12))).toBe("A-1: $12"));
`,
		);
		await git(clone, ["branch", "-q", "epic/ACME-600", "main"]);
		held = join(dir, "portia-worktree");
		await git(clone, ["worktree", "add", "-q", held, "epic/ACME-600"]);
	});

	it("scores a branch another worktree holds, on a detached checkout of it", async () => {
		await git(clone, ["checkout", "-q", "main"]);
		// What the scorer used to do, which git refuses: "already checked out at ...".
		expect(await gitOk(clone, ["checkout", "--quiet", "epic/ACME-600"])).toBe(
			false,
		);
		const before = await head();
		const r = await scoreBranch(clone, REPO, EPIC, hidden, {
			branch: "epic/ACME-600",
			log,
		});
		expect(r.hidden.passed).toEqual(["S1"]);
		expect(r.checks.failed).toEqual([]);
		// The clone is left as it was, and the scoring checkout is gone.
		expect(await head()).toBe(before);
		const worktrees = await git(clone, ["worktree", "list", "--porcelain"]);
		expect(worktrees.match(/^worktree /gm)).toHaveLength(2);
		expect(worktrees).toContain(held);
	});

	it("does not score a file left untracked in the clone, only what the branch committed", async () => {
		await git(clone, ["checkout", "-q", "--detach", "epic/ACME-600"]);
		// A local file a check would trip over, as `portia permissions` leaves one.
		writeFileSync(join(clone, "local.test.ts"), RED["red.test.ts"]);
		const inClone = await scoreChecks(clone, REPO, {
			branch: "epic/ACME-600",
			log,
		});
		expect(inClone.failed).toEqual(CHECKS);
		const r = await scoreBranch(clone, REPO, EPIC, hidden, {
			branch: "epic/ACME-600",
			log,
		});
		expect(r.checks.failed).toEqual([]);
		expect(r.hidden.passed).toEqual(["S1"]);
		// Nothing the clone holds is cleaned away, and the hidden specs never land in it.
		expect(existsSync(join(clone, "local.test.ts"))).toBe(true);
		expect(readdirSync(clone)).not.toContain(".eval-hidden");
		rmSync(join(clone, "local.test.ts"));
		await git(clone, ["checkout", "-q", "main"]);
	});

	it("runs the repo's setup in the clean checkout before scoring it", async () => {
		const repo = {
			...REPO,
			setup: "touch .set-up",
			checks: ["test -f .set-up"],
		};
		const r = await scoreBranch(clone, repo, EPIC, hidden, {
			branch: "epic/ACME-600",
			log,
		});
		expect(r.checks.failed).toEqual([]);
		expect(existsSync(join(clone, ".set-up"))).toBe(false);
	});
});
