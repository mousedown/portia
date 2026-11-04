import { describe, expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { PortiaProblem } from "../../src/core/exit";
import { check } from "../../src/plan/check";
import { GH_CONCURRENCY, GitHubTracker, titleKey } from "../../src/plan/github";
import { loadPlan } from "../../src/plan/load";
import { trackerFromProfile } from "../../src/plan/tracker";
import parent from "../fixtures/github/issue-1.json";
import subIssues from "../fixtures/github/issue-1-sub-issues.json";
import issue2 from "../fixtures/github/issue-2.json";
import b2 from "../fixtures/github/issue-2-blocked-by.json";
import issue3 from "../fixtures/github/issue-3.json";
import b3 from "../fixtures/github/issue-3-blocked-by.json";
import issue4 from "../fixtures/github/issue-4.json";
import b4 from "../fixtures/github/issue-4-blocked-by.json";
import { type ExecCall, fakeExec } from "../helpers/fake-exec";
import { type ContractGraph, trackerContract } from "./tracker-contract";

const REPO = "mousedown/portia-fixture";
type Json = Record<string, unknown>;

const graph: ContractGraph = {
	parent: "GH-1",
	children: { "GH-2": [], "GH-3": ["GH-2"], "GH-4": ["GH-2"] },
	missingKey: "GH-99",
	writeKey: "GH-2",
	linkPair: ["GH-3", "GH-4"],
};

const issues: Record<string, Json> = {
	"1": parent,
	"2": issue2,
	"3": issue3,
	"4": issue4,
};
const blockers: Record<string, unknown> = {
	"1": [[]],
	"2": b2,
	"3": b3,
	"4": b4,
};

const pathOf = (c: ExecCall) => (c.args[1] ?? "").split("?")[0] ?? "";
/** Independent of src: a write carries a non-GET method or a body. */
const isWrite = (c: ExecCall) =>
	c.args.some(
		(a, i) => (a === "-X" || a === "--method") && c.args[i + 1] !== "GET",
	) || c.args.some((a) => /^(-f|-F|--input)/.test(a));

function ghFake(
	over: (c: ExecCall) => { stdout: string } | undefined = () => undefined,
) {
	return fakeExec((c) => {
		const o = over(c);
		if (o) return o;
		const p = pathOf(c);
		const m = p.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/.*)?$/);
		const n = m?.[1] ?? "";
		const tail = m?.[2] ?? "";
		const json = (v: unknown) => ({ stdout: JSON.stringify(v) });
		if (!issues[n]) return { code: 1, stderr: "gh: Not Found (HTTP 404)" };
		if (tail === "") return json(issues[n]);
		if (tail === "/dependencies/blocked_by") return json(blockers[n]);
		if (tail === "/sub_issues") return json(subIssues);
		return json({});
	});
}

function subject() {
	const f = ghFake();
	return {
		tracker: new GitHubTracker(REPO, "GH", f.exec),
		writes: () => f.calls.filter(isWrite).length,
	};
}

/** Issue number -> the key its title carries under `keys: "title"`. */
const TITLE_KEYS: Record<string, string> = {
	"1": "ACME-500",
	"2": "ACME-501",
	"3": "ACME-502",
	"4": "[ACME-503]",
};
const titled = (n: string, title: unknown) => {
	const k = TITLE_KEYS[n] ?? "";
	return k.startsWith("[") ? `${k} ${title}` : `${k}: ${title}`;
};

/** A stateful GitHub: reads reflect earlier PATCH/POST writes. */
function statefulSubject(keys: "number" | "title" = "number") {
	const state = structuredClone(issues) as Record<string, Json>;
	const subs = structuredClone(subIssues) as Json[][];
	if (keys === "title") {
		for (const [n, i] of Object.entries(state)) i.title = titled(n, i.title);
		for (const i of subs.flat()) i.title = titled(String(i.number), i.title);
	}
	const deps: Record<string, Json[]> = {
		"1": [],
		"2": [],
		"3": [state["2"] as Json],
		"4": [state["2"] as Json],
	};
	const f = fakeExec((c) => {
		const m = pathOf(c).match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/.*)?$/);
		const n = m?.[1] ?? "";
		const tail = m?.[2] ?? "";
		const issue = state[n];
		const method = c.args[c.args.indexOf("-X") + 1];
		const field = (name: string) =>
			c.args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ??
			"";
		const json = (v: unknown) => ({ stdout: JSON.stringify(v) });
		if (pathOf(c) === `repos/${REPO}/issues`)
			return json([
				[
					...Object.values(state),
					{ number: 9, title: "ACME-509: a PR", pull_request: {} },
				],
			]);
		if (!issue) return { code: 1, stderr: "gh: Not Found (HTTP 404)" };
		if (tail === "" && method === "PATCH") {
			issue.body = field("body");
			return json(issue);
		}
		if (tail === "") return json(issue);
		if (tail === "/dependencies/blocked_by" && method === "POST") {
			const b = Object.values(state).find(
				(i) => i.id === Number(field("issue_id")),
			);
			deps[n]?.push(b as Json);
			return json(b);
		}
		if (tail === "/dependencies/blocked_by") return json([deps[n]]);
		if (tail === "/sub_issues") return json(subs);
		return json({});
	});
	return {
		tracker: new GitHubTracker(REPO, "GH", f.exec, "portia", keys),
		writes: () => f.calls.filter(isWrite).length,
		calls: f.calls,
	};
}

trackerContract("GitHubTracker", graph, () => statefulSubject());

const titleGraph: ContractGraph = {
	parent: "ACME-500",
	children: {
		"ACME-501": [],
		"ACME-502": ["ACME-501"],
		"ACME-503": ["ACME-501"],
	},
	missingKey: "ACME-599",
	writeKey: "ACME-501",
	linkPair: ["ACME-502", "ACME-503"],
};
trackerContract("GitHubTracker with title keys", titleGraph, () =>
	statefulSubject("title"),
);

describe("GitHubTracker with title keys", () => {
	const listings = (calls: ExecCall[]) =>
		calls.filter((c) => pathOf(c) === `repos/${REPO}/issues`);

	it("resolves a key from the title, strips it from the summary, and reads blockers' keys from theirs", async () => {
		const s = statefulSubject("title");
		const i = await s.tracker.issue("ACME-502");
		expect(i.key).toBe("ACME-502");
		expect(i.summary).toBe("A");
		expect(i.blockedBy).toEqual(["ACME-501"]);
		expect(s.calls.map(pathOf)).toContain(`repos/${REPO}/issues/3`);
		expect((await s.tracker.issue("ACME-503")).summary).toBe("B");
	});
	it("lists issues once per tracker, every state, paginated, whatever is asked", async () => {
		const s = statefulSubject("title");
		await s.tracker.issue("ACME-500");
		await s.tracker.children("ACME-500");
		await s.tracker.comment("ACME-501", "hi");
		const l = listings(s.calls);
		expect(l).toHaveLength(1);
		expect(l[0]?.args).toEqual([
			"api",
			`repos/${REPO}/issues?state=all&per_page=100`,
			"--paginate",
			"--slurp",
		]);
	});
	it("finds children through the sub-issues API under their title keys", async () => {
		const s = statefulSubject("title");
		const kids = await s.tracker.children("ACME-500");
		expect(kids.map((k) => [k.key, k.summary])).toEqual([
			["ACME-501", "Spine"],
			["ACME-502", "A"],
			["ACME-503", "B"],
		]);
		expect(s.calls.map(pathOf)).toContain(`repos/${REPO}/issues/1/sub_issues`);
	});
	it("writes to the issue the key resolves to", async () => {
		const s = statefulSubject("title");
		await s.tracker.link("ACME-502", "ACME-503");
		const w = s.calls.filter(isWrite);
		expect(w[0]?.args.slice(0, 2)).toEqual([
			"api",
			`repos/${REPO}/issues/4/dependencies/blocked_by`,
		]);
	});
	it("names the repo and the title forms for an unknown key, and never reads a key as a number", async () => {
		const t = statefulSubject("title").tracker;
		await expect(t.issue("ACME-599")).rejects.toThrow(
			`no issue in ${REPO} has a title starting 'ACME-599:' or '[ACME-599]'`,
		);
		await expect(t.issue("GH-2")).rejects.toBeInstanceOf(PortiaProblem);
		await expect(t.issue("ACME-509")).rejects.toBeInstanceOf(PortiaProblem);
		await expect(t.issue("acme-1")).rejects.toThrow("is not a ticket key");
	});
	it("refuses a key that starts two titles", async () => {
		const f = fakeExec((c) =>
			pathOf(c) === `repos/${REPO}/issues`
				? {
						stdout: JSON.stringify([
							[
								{ number: 4, title: "ACME-1: one" },
								{ number: 7, title: "[ACME-1] two" },
							],
						]),
					}
				: { stdout: "{}" },
		);
		const t = new GitHubTracker(REPO, "GH", f.exec, "portia", "title");
		await expect(t.issue("ACME-1")).rejects.toThrow("#4, #7");
	});
	it("names an issue by its title key for a Closes line", async () => {
		const f = ghFake((c) =>
			pathOf(c) === `repos/${REPO}/issues`
				? { stdout: JSON.stringify([[{ number: 9, title: "ACME-500: P" }]]) }
				: undefined,
		);
		const t = new GitHubTracker(REPO, "GH", f.exec, "portia", "title");
		expect(await t.issueRef("ACME-500")).toBe(`${REPO}#9`);
		expect(await new GitHubTracker(REPO, "GH", f.exec).issueRef("GH-4")).toBe(
			`${REPO}#4`,
		);
	});
	it("refuses a child whose title carries no key", async () => {
		const f = ghFake((c) =>
			pathOf(c) === `repos/${REPO}/issues`
				? { stdout: JSON.stringify([[{ number: 1, title: "ACME-500: P" }]]) }
				: undefined,
		);
		const t = new GitHubTracker(REPO, "GH", f.exec, "portia", "title");
		await expect(t.children("ACME-500")).rejects.toThrow(
			"#2 in mousedown/portia-fixture has no key at the start of its title",
		);
	});
});

describe("titleKey", () => {
	it("reads '<KEY>: ' and '[<KEY>] ' at the start only, never EXT", () => {
		expect(titleKey("ACME-500: Checkout")).toEqual({
			key: "ACME-500",
			rest: "Checkout",
		});
		expect(titleKey("  [ACME-5]  Cart")).toEqual({
			key: "ACME-5",
			rest: "Cart",
		});
		for (const t of [
			"Checkout ACME-500: x",
			"ACME-500 x",
			"acme-5: x",
			"EXT-3: x",
			"[ACME-5 x",
		])
			expect(titleKey(t)).toBeNull();
	});
});

describe("GitHubTracker writes", () => {
	it("sets the plan block through PATCH with the whole body as a field", async () => {
		const s = statefulSubject();
		await s.tracker.setPlanBlock("GH-2", "wave: 5");
		const w = s.calls.filter(isWrite);
		expect(w).toHaveLength(1);
		const F = "`".repeat(3);
		expect(w[0]?.args).toEqual([
			"api",
			`repos/${REPO}/issues/2`,
			"-X",
			"PATCH",
			"-f",
			`body=Spine of the fixture plan.\n\n${F}plan\nwave: 5\n${F}\n`,
		]);
	});
	it("links by the blocker's numeric id through dependencies/blocked_by", async () => {
		const s = statefulSubject();
		await s.tracker.link("GH-3", "GH-4");
		const w = s.calls.filter(isWrite);
		expect(w).toHaveLength(1);
		expect(w[0]?.args).toEqual([
			"api",
			`repos/${REPO}/issues/4/dependencies/blocked_by`,
			"-X",
			"POST",
			"-F",
			`issue_id=${(issue3 as Json).id}`,
		]);
	});
});

describe("GitHubTracker mapping", () => {
	it("maps a GitHub issue", async () => {
		const i = await subject().tracker.issue("GH-3");
		expect(i.summary).toBe("A");
		expect(i.status).toBe("open");
		expect(i.blockedBy).toEqual(["GH-2"]);
		expect(i.description).toContain("```portia");
		expect(i.labels).toEqual([]);
		expect(i.done).toBe(false);
	});
	it("reads label names and treats a closed issue as done", async () => {
		const t = new GitHubTracker(
			REPO,
			"GH",
			ghFake((c) =>
				pathOf(c) === `repos/${REPO}/issues/3`
					? {
							stdout: JSON.stringify({
								...issue3,
								state: "closed",
								labels: [{ name: "launch-readiness" }, "x"],
							}),
						}
					: undefined,
			).exec,
		);
		const i = await t.issue("GH-3");
		expect(i.labels).toEqual(["launch-readiness", "x"]);
		expect(i.done).toBe(true);
	});
	it("uses the key prefix from the profile", async () => {
		const t = new GitHubTracker(REPO, "FIX", ghFake().exec);
		expect((await t.issue("FIX-3")).key).toBe("FIX-3");
		expect((await t.issue("FIX-3")).blockedBy).toEqual(["FIX-2"]);
		await expect(t.issue("GH-3")).rejects.toBeInstanceOf(PortiaProblem);
	});
	it("rejects a key with the wrong prefix or no number", async () => {
		const t = subject().tracker;
		for (const k of ["ACME-3", "GH-", "GH", "GH-x", "3"])
			await expect(t.issue(k)).rejects.toBeInstanceOf(PortiaProblem);
	});
});

describe("cross-repo blockers", () => {
	it("maps a blocker in another repository to EXT-<n>", async () => {
		const foreign = JSON.parse(JSON.stringify(b3)) as Json[][];
		const first = foreign[0]?.[0] as Json;
		first.number = 77;
		first.repository_url = "https://api.github.com/repos/other/repo";
		const f = ghFake((c) =>
			pathOf(c).endsWith("/issues/3/dependencies/blocked_by")
				? { stdout: JSON.stringify(foreign) }
				: undefined,
		);
		const t = new GitHubTracker(REPO, "GH", f.exec);
		expect((await t.issue("GH-3")).blockedBy).toEqual(["EXT-77"]);
	});
});

describe("pagination", () => {
	it("returns more than 100 children across pages, in order", async () => {
		const template = (subIssues[0] as Json[])[0] as Json;
		const mk = (n: number): Json => ({ ...template, number: n });
		const page1 = Array.from({ length: 100 }, (_, i) => mk(100 + i));
		const page2 = Array.from({ length: 5 }, (_, i) => mk(200 + i));
		const f = fakeExec((c) => {
			const p = pathOf(c);
			if (p.endsWith("/issues/1/sub_issues"))
				return { stdout: JSON.stringify([page1, page2]) };
			if (p.endsWith("/dependencies/blocked_by")) return { stdout: "[[]]" };
			const n = Number(p.split("/").pop());
			return { stdout: JSON.stringify(mk(n)) };
		});
		const kids = await new GitHubTracker(REPO, "GH", f.exec).children("GH-1");
		expect(kids).toHaveLength(105);
		expect(kids[0]?.key).toBe("GH-100");
		expect(kids[104]?.key).toBe("GH-204");
		const call = f.calls.find((c) => pathOf(c).endsWith("/sub_issues"));
		expect(call?.args).toContain("--paginate");
		expect(call?.args).toContain("--slurp");
		expect(call?.args.join(" ")).toContain("per_page=100");
	});
});

describe("fetching at once", () => {
	it("fetches children's blockers concurrently, at most GH_CONCURRENCY at a time, in order", async () => {
		const template = (subIssues[0] as Json[])[0] as Json;
		const kids = Array.from({ length: 20 }, (_, i) => ({
			...template,
			number: 10 + i,
		}));
		let live = 0;
		let peak = 0;
		const base = fakeExec((c) =>
			pathOf(c).endsWith("/sub_issues")
				? { stdout: JSON.stringify([kids]) }
				: { stdout: "[[]]" },
		);
		const exec: typeof base.exec = async (cmd, args, opts) => {
			live++;
			peak = Math.max(peak, live);
			await new Promise((r) => setTimeout(r, 2));
			live--;
			return base.exec(cmd, args, opts);
		};
		const out = await new GitHubTracker(REPO, "GH", exec).children("GH-1");
		expect(out.map((k) => k.key)).toEqual(kids.map((k) => `GH-${k.number}`));
		expect(peak).toBe(GH_CONCURRENCY);
	});
	it("loadPlan never fetches the parent's blockers, which it drops", async () => {
		const f = ghFake();
		await loadPlan(new GitHubTracker(REPO, "GH", f.exec), "GH-1", ["src"], ".");
		const blockers = f.calls
			.map(pathOf)
			.filter((p) => p.endsWith("/dependencies/blocked_by"));
		expect(blockers).not.toContain(
			`repos/${REPO}/issues/1/dependencies/blocked_by`,
		);
		expect(blockers).toHaveLength(3);
	});
	it("issue with blockers: false skips the blockers call", async () => {
		const f = ghFake();
		const i = await new GitHubTracker(REPO, "GH", f.exec).issue("GH-3", {
			blockers: false,
		});
		expect(i.blockedBy).toEqual([]);
		expect(f.calls).toHaveLength(1);
	});
});

describe("loadPlan over GitHub", () => {
	it("loads the fixture plan with blocked-by edges", async () => {
		const { plan, findings } = await loadPlan(
			subject().tracker,
			"GH-1",
			["src"],
			".",
		);
		expect(findings).toEqual([]);
		expect(plan.scope).toBe("fixture");
		expect(plan.children.map((c) => [c.key, c.wave, c.blockedBy])).toEqual([
			["GH-2", 0, []],
			["GH-3", 1, ["GH-2"]],
			["GH-4", 1, ["GH-2"]],
		]);
	});
	it("produces a plan that passes portia check", async () => {
		const { plan } = await loadPlan(subject().tracker, "GH-1", ["src"], ".");
		const files = ["src/spine.ts", "src/a.ts", "src/b.ts"];
		expect(check(plan, files).filter((f) => f.level === "error")).toEqual([]);
	});
	it("leaves a body with no plan block out of the run, as a warning", async () => {
		const pages = (subIssues as Json[][]).map((pg) =>
			pg.map((i) => (i.number === 3 ? { ...i, body: "spike" } : i)),
		);
		const f = ghFake((c) =>
			pathOf(c).endsWith("/issues/1/sub_issues")
				? { stdout: JSON.stringify(pages) }
				: undefined,
		);
		const { plan, findings, unplanned } = await loadPlan(
			new GitHubTracker(REPO, "GH", f.exec),
			"GH-1",
			["src"],
			".",
		);
		expect(unplanned).toEqual(["GH-3"]);
		expect(findings.map((x) => [x.rule, x.level, x.message])).toEqual([
			["unplanned", "warn", "not in this run: GH-3"],
		]);
		expect(plan.children.map((c) => c.key)).toEqual(["GH-2", "GH-4"]);
	});
});

describe("writes", () => {
	it("comments through POST with the text as a field", async () => {
		const f = ghFake();
		await new GitHubTracker(REPO, "GH", f.exec).comment("GH-2", "hello");
		const w = f.calls.filter(isWrite);
		expect(w).toHaveLength(1);
		expect(w[0]?.args).toEqual([
			"api",
			`repos/${REPO}/issues/2/comments`,
			"-X",
			"POST",
			"-f",
			"body=hello",
		]);
	});
	it("transition swaps portia:* labels and keeps the rest", async () => {
		const labels = [
			{ name: "bug" },
			{ name: "portia:Ready" },
			{ name: "portia:Blocked" },
		];
		const input: string[] = [];
		const f = fakeExec((c) => {
			if (c.args.includes("-X")) return { stdout: "[]" };
			return { stdout: JSON.stringify({ ...issue2, labels }) };
		});
		const wrapped = (async (cmd, args, opts) => {
			if (opts?.input) input.push(opts.input);
			return f.exec(cmd, args, opts);
		}) as typeof f.exec;
		await new GitHubTracker(REPO, "GH", wrapped).transition(
			"GH-2",
			"In Development",
		);
		const w = f.calls.filter(isWrite);
		expect(w).toHaveLength(1);
		expect(w[0]?.args.slice(0, 4)).toEqual([
			"api",
			`repos/${REPO}/issues/2/labels`,
			"-X",
			"PUT",
		]);
		expect(JSON.parse(input[0] ?? "{}")).toEqual({
			labels: ["bug", "portia:In Development"],
		});
	});
});

describe("GitHubTracker labels with a branch prefix", () => {
	it("writes <prefix>:<state> and clears both it and legacy portia:* labels", async () => {
		const labels = [
			{ name: "bug" },
			{ name: "epic:Ready" },
			{ name: "portia:Old" },
		];
		const input: string[] = [];
		const f = fakeExec((c) => {
			if (c.args.includes("-X")) return { stdout: "[]" };
			return { stdout: JSON.stringify({ ...issue2, labels }) };
		});
		const wrapped = (async (cmd, args, opts) => {
			if (opts?.input) input.push(opts.input);
			return f.exec(cmd, args, opts);
		}) as typeof f.exec;
		await new GitHubTracker(REPO, "GH", wrapped, "epic").transition(
			"GH-2",
			"Done",
		);
		expect(JSON.parse(input[0] ?? "{}")).toEqual({
			labels: ["bug", "epic:Done"],
		});
	});
});

describe("trackerFromProfile github", () => {
	it("builds a GitHub tracker with the default prefix", async () => {
		const p = {
			...testProfile(),
			tracker: { kind: "github" as const, repo: REPO },
		};
		const t = trackerFromProfile(p, {});
		expect(t).toBeInstanceOf(GitHubTracker);
		expect(t.keyPattern.test("GH-1")).toBe(true);
	});
	it("keeps number keys by default and makes no listing", async () => {
		const f = ghFake();
		const i = await new GitHubTracker(REPO, "GH", f.exec).issue("GH-3");
		expect([i.key, i.summary]).toEqual(["GH-3", "A"]);
		expect(f.calls.map(pathOf)).not.toContain(`repos/${REPO}/issues`);
	});
});
