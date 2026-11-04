import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, spawnExec } from "../src/arms/claude";
import { git } from "../src/metrics/git";
import {
	applyReset,
	filed,
	plannedIssues,
	resetPlan,
	trackerRepo,
} from "../src/reset";
import { loadSuite } from "../src/suite";

// Nothing here reaches GitHub: a fake `gh` holds a tracker a Portia run left behind on
// ACME-400 (a plan block, transition labels, blockers, an open epic PR and epic branches)
// beside things reset must never touch (another epic, main, reference/*, a stranger's PR).
const SUITE = loadSuite(join(import.meta.dir, "../suites/v1/suite.json"));
const TICKETS = join(SUITE.dir, SUITE.tickets);
const ticket = (k: string) => readFileSync(join(TICKETS, `${k}.md`), "utf8");
const KEYS = ["ACME-400", "ACME-401", "ACME-402", "ACME-403", "ACME-404"];
const TICKET_TEXT = Object.fromEntries(KEYS.map((k) => [k, ticket(k)]));
const PLAN = "\n\n```plan\nwave: 1\n```";

function fakeGh(): { exec: Exec; writes: string[][] } {
	const writes: string[][] = [];
	const issue = (
		number: number,
		key: string,
		o: Record<string, unknown> = {},
	) => ({
		id: number * 1000,
		number,
		...filed(key, TICKET_TEXT[key] ?? ticket(key)),
		state: "open",
		labels: [],
		pr: false,
		...o,
	});
	const issues = [
		issue(1, "ACME-400", {
			body: filed("ACME-400", TICKET_TEXT["ACME-400"] as string).body + PLAN,
		}),
		issue(3, "ACME-401", { labels: ["epic:landed", "bug"] }),
		issue(4, "ACME-402", { state: "closed", labels: ["portia:running"] }),
		issue(5, "ACME-403"),
		issue(6, "ACME-404"),
		issue(2, "ACME-500", {
			body: filed("ACME-500", ticket("ACME-500")).body + PLAN,
		}),
		// Filed by a run (Portia's spine ticket); closed, a stranger's, and another project's are left.
		{
			id: 20000,
			number: 20,
			title: "ACME-405: Write the acceptance specs",
			state: "open",
			labels: [],
			body: "",
			pr: false,
		},
		{
			id: 23000,
			number: 23,
			title: "ACME-406: An older run's ticket",
			state: "closed",
			labels: [],
			body: "",
			pr: false,
		},
		// Retitled by an earlier reset, but still left blocking a suite ticket.
		{
			id: 26000,
			number: 26,
			title: "[run-filed] ACME-407: Write the specs",
			state: "closed",
			labels: [],
			body: "",
			pr: false,
		},
		{
			id: 24000,
			number: 24,
			title: "Fix the README",
			state: "open",
			labels: [],
			body: "",
			pr: false,
		},
		{
			id: 25000,
			number: 25,
			title: "OPS-1: Rotate the keys",
			state: "open",
			labels: [],
			body: "",
			pr: false,
		},
		{
			id: 15000,
			number: 15,
			title: "feat: ACME-400 the epic",
			state: "open",
			labels: [],
			body: "",
			pr: true,
		},
	];
	const blockers: Record<number, { id: number; number: number }[]> = {
		// Run-filed spine tickets a run made ACME-401 and ACME-403 wait on.
		3: [{ id: 7020, number: 20 }],
		4: [{ id: 6003, number: 3 }],
		5: [{ id: 7026, number: 26 }],
		6: [
			{ id: 6003, number: 3 },
			{ id: 9002, number: 2 },
		],
	};
	const exec: Exec = async (cmd, o) => {
		if (cmd[0] !== "gh") return spawnExec(cmd, o);
		const args = cmd.slice(1);
		const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
		const path = args.find((a) => a.startsWith("repos/")) ?? "";
		if (args[0] === "api" && args.includes("--paginate")) {
			if (path.startsWith("repos/mousedown/acme-shop/issues?"))
				return ok(issues.map((i) => JSON.stringify(i)).join("\n"));
			const b = /issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
			if (b)
				return ok(
					(blockers[Number(b[1])] ?? [])
						.map((x) => JSON.stringify(x))
						.join("\n"),
				);
			if (path === "repos/mousedown/acme-shop/git/matching-refs/heads/")
				return ok(
					[
						"refs/heads/main",
						"refs/heads/reference/ACME-400",
						"refs/heads/epic/ACME-400",
						"refs/heads/epic/ACME-401",
						"refs/heads/epic/ACME-4000",
						"refs/heads/epic/ACME-500",
						// A run's own prefix: its branches, its spine ticket's included, are the epic's.
						"refs/heads/eval-r4-mh2x/ACME-402",
						"refs/heads/eval-r4-mh2x/ACME-405",
						"refs/heads/eval-r4-mh2x/ACME-500",
						"refs/heads/feature/ACME-401",
					].join("\n"),
				);
		}
		if (args[0] === "pr" && args[1] === "list")
			return ok(
				JSON.stringify([
					{ number: 15, headRefName: "epic/ACME-400" },
					{ number: 20, headRefName: "fix/readme" },
					{ number: 21, headRefName: "epic/ACME-500" },
					{ number: 22, headRefName: "eval-r4-mh2x/ACME-405" },
				]),
			);
		writes.push(args);
		return ok("");
	};
	return { exec, writes };
}

let dir: string;
let worktree: string;
beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eval-reset-"));
	const repo = join(dir, "clone");
	await git(dir, ["init", "-q", "-b", "main", repo]);
	for (const [k, v] of [
		["user.name", "eval"],
		["user.email", "eval@localhost"],
		["commit.gpgsign", "false"],
	] as const)
		await git(repo, ["config", k, v]);
	writeFileSync(join(repo, "a.md"), "a\n");
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-q", "-m", "a"]);
	await git(repo, ["branch", "epic/ACME-400"]);
	mkdirSync(join(dir, "worktrees", "acme-shop"), { recursive: true });
	worktree = join(dir, "worktrees", "acme-shop", "ACME-400");
	await git(repo, ["worktree", "add", "-q", worktree, "epic/ACME-400"]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const plan = (exec: Exec) =>
	resetPlan({
		suite: SUITE,
		epicKey: "ACME-400",
		profile: { branchPrefix: "epic", worktreesDir: join(dir, "worktrees") },
		tickets: TICKET_TEXT,
		exec,
	});

describe("filed", () => {
	it("builds every suite ticket's title and body exactly as publish.sh files them", async () => {
		for (const f of readdirSync(TICKETS)) {
			const key = f.replace(/\.md$/, "");
			const file = join(TICKETS, f);
			const sh = (script: string) =>
				spawnExec(["bash", "-c", script, "_", file], { cwd: dir, env: {} });
			const title = (await sh(`printf %s "$(head -1 "$1" | sed 's/^# //')"`))
				.stdout;
			const body = (await sh(`printf %s "$(tail -n +3 "$1")"`)).stdout;
			expect(filed(key, ticket(key))).toEqual({
				title: `${key}: ${title}`,
				body,
			});
		}
	});
});

describe("resetPlan", () => {
	it("undoes a run on the epic and its children only, and reads nothing it writes", async () => {
		const gh = fakeGh();
		const steps = await plan(gh.exec);
		expect(gh.writes).toEqual([]);
		const r = "repos/mousedown/acme-shop/issues";
		expect(steps.map((s) => s.cmd)).toEqual([
			[
				"gh",
				"api",
				`${r}/1`,
				"-X",
				"PATCH",
				"-f",
				`title=${filed("ACME-400", ticket("ACME-400")).title}`,
				"-f",
				`body=${filed("ACME-400", ticket("ACME-400")).body}`,
			],
			["gh", "api", "-X", "DELETE", `${r}/3/labels/epic%3Alanded`],
			["gh", "api", "-X", "DELETE", `${r}/3/dependencies/blocked_by/7020`],
			["gh", "api", `${r}/4`, "-X", "PATCH", "-f", "state=open"],
			["gh", "api", "-X", "DELETE", `${r}/4/labels/portia%3Arunning`],
			["gh", "api", "-X", "DELETE", `${r}/4/dependencies/blocked_by/6003`],
			["gh", "api", "-X", "DELETE", `${r}/5/dependencies/blocked_by/7026`],
			// ACME-500's issue blocking ACME-404 is not this epic's to unlink.
			["gh", "api", "-X", "DELETE", `${r}/6/dependencies/blocked_by/6003`],
			[
				"gh",
				"api",
				`${r}/20`,
				"-X",
				"PATCH",
				"-f",
				"title=[run-filed] ACME-405: Write the acceptance specs",
			],
			[
				"gh",
				"api",
				"-X",
				"DELETE",
				`${r}/1/sub_issue`,
				"-F",
				"sub_issue_id=20000",
			],
			[
				"gh",
				"issue",
				"close",
				"20",
				"--repo",
				"mousedown/acme-shop",
				"--reason",
				"not planned",
			],
			// A closed run ticket is only retitled.
			[
				"gh",
				"api",
				`${r}/23`,
				"-X",
				"PATCH",
				"-f",
				"title=[run-filed] ACME-406: An older run's ticket",
			],
			["gh", "pr", "close", "15", "--repo", "mousedown/acme-shop"],
			["gh", "pr", "close", "22", "--repo", "mousedown/acme-shop"],
			[
				"gh",
				"api",
				"-X",
				"DELETE",
				"repos/mousedown/acme-shop/git/refs/heads/epic/ACME-400",
			],
			[
				"gh",
				"api",
				"-X",
				"DELETE",
				"repos/mousedown/acme-shop/git/refs/heads/epic/ACME-401",
			],
			[
				"gh",
				"api",
				"-X",
				"DELETE",
				"repos/mousedown/acme-shop/git/refs/heads/eval-r4-mh2x/ACME-402",
			],
			[
				"gh",
				"api",
				"-X",
				"DELETE",
				"repos/mousedown/acme-shop/git/refs/heads/eval-r4-mh2x/ACME-405",
			],
			[
				"git",
				"-C",
				realpathSync(join(dir, "clone")),
				"worktree",
				"remove",
				"--force",
				worktree,
			],
		]);
		expect(steps[0]?.what).toContain("dropping its plan block");
		const all = steps.flatMap((s) => s.cmd).join(" ");
		for (const never of [
			"heads/main",
			"reference/",
			"ACME-4000",
			"ACME-500",
			"/2/",
			" 21 ",
			" 24 ",
			" 25 ",
			"feature/",
		])
			expect(all).not.toContain(never);
	});

	it("applies exactly the plan, and removes the worktree through the repo that owns it", async () => {
		const gh = fakeGh();
		const steps = await plan(gh.exec);
		await applyReset(steps, gh.exec);
		expect(gh.writes).toEqual(
			steps.filter((s) => s.cmd[0] === "gh").map((s) => s.cmd.slice(1)),
		);
		expect(readdirSync(join(dir, "worktrees", "acme-shop"))).toEqual([]);
		expect(await git(join(dir, "clone"), ["worktree", "list"])).not.toContain(
			worktree,
		);
	});

	it("refuses a branch prefix that would reach main or reference/*", async () => {
		for (const branchPrefix of ["", "main", "reference"])
			expect(
				resetPlan({
					suite: SUITE,
					epicKey: "ACME-400",
					profile: { branchPrefix },
					tickets: TICKET_TEXT,
					exec: fakeGh().exec,
				}),
			).rejects.toThrow("would reach main or reference/*");
	});
});

describe("plannedIssues", () => {
	it("names the epic's issues that still carry a plan block", async () => {
		const [repo] = SUITE.repos;
		const epic = repo?.epics.find((e) => e.key === "ACME-400");
		if (!repo || !epic) throw new Error("no ACME-400 in the suite");
		expect(trackerRepo(repo)).toBe("mousedown/acme-shop");
		expect(await plannedIssues(repo, epic, fakeGh().exec)).toEqual([
			"ACME-400",
		]);
	});
});
