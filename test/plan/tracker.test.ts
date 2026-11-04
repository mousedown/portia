import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { PortiaProblem } from "../../src/core/exit";
import { Jira } from "../../src/plan/jira";
import { JiraTracker, trackerFromProfile } from "../../src/plan/tracker";
import parent from "../fixtures/jira/ACME-500.json";
import children from "../fixtures/jira/ACME-500-children.json";
import type { Call } from "../helpers/fake-fetch";
import { type ContractGraph, trackerContract } from "./tracker-contract";

const graph: ContractGraph = {
	parent: "ACME-500",
	children: {
		"ACME-501": [],
		"ACME-502": ["ACME-501"],
		"ACME-503": ["ACME-501"],
		"ACME-504": ["ACME-501"],
		"ACME-505": ["ACME-502", "ACME-503"],
	},
	missingKey: "ACME-999999",
	writeKey: "ACME-501",
	linkPair: ["ACME-503", "ACME-504"],
};

const cfg = { baseUrl: "https://x.atlassian.net", email: "a@b.c", token: "t" };

interface StoredIssue {
	key: string;
	fields: { description: unknown; issuelinks: unknown[] };
}
interface WriteBody {
	type: { name: string };
	inwardIssue: { key: string };
	outwardIssue: { key: string };
	fields: { description: unknown };
}
interface AdfNode {
	type: string;
	attrs?: unknown;
	content?: unknown;
}

/** A stateful Jira: reads reflect earlier PUT/POST writes. */
function jiraSubject() {
	const calls: Call[] = [];
	const store = new Map<string, StoredIssue>();
	for (const i of [parent, ...children] as StoredIssue[])
		store.set(i.key, structuredClone(i));
	const json = (v: unknown, status = 200) =>
		status === 204
			? new Response(null, { status })
			: new Response(JSON.stringify(v), { status });
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		const u = new URL(String(url));
		const method = init?.method ?? "GET";
		const body = (
			init?.body ? JSON.parse(String(init.body)) : undefined
		) as WriteBody;
		calls.push({ url: String(url), method, body });
		const p = u.pathname.replace("/rest/api/3", "");
		if (p === "/search/jql")
			return json({ issues: children.map((c) => store.get(c.key)) });
		if (p === "/issueLink" && method === "POST") {
			const link = (
				key: string,
				side: "inwardIssue" | "outwardIssue",
				other: string,
			) =>
				store.get(key)?.fields.issuelinks.push({
					type: { name: body.type.name },
					[side]: { key: other },
				});
			link(body.outwardIssue.key, "inwardIssue", body.inwardIssue.key);
			link(body.inwardIssue.key, "outwardIssue", body.outwardIssue.key);
			return json(undefined, 204);
		}
		const m = p.match(/^\/issue\/([A-Z]+-\d+)(\/.*)?$/);
		const issue = m && store.get(m[1] ?? "");
		if (!m || !issue) return new Response("not found", { status: 404 });
		if (m[2] === "/transitions")
			return method === "GET"
				? json({ transitions: [{ id: "31", name: "In Development" }] })
				: json(undefined, 204);
		if (m[2] === "/comment") return json({});
		if (method === "PUT") {
			issue.fields.description = body.fields.description;
			return json(undefined, 204);
		}
		return json(issue);
	}) as typeof fetch;
	return {
		tracker: new JiraTracker(new Jira(cfg, fetchFn)),
		writes: () => calls.filter((c) => c.method !== "GET").length,
		calls,
	};
}

trackerContract("JiraTracker", graph, jiraSubject);

describe("JiraTracker mapping", () => {
	it("maps ADF, status and Blocks links", async () => {
		const { tracker } = jiraSubject();
		const i = await tracker.issue("ACME-502");
		expect(i.status).toBe("To Do");
		expect(i.blockedBy).toEqual(["ACME-501"]);
		expect(i.description).toContain("Slice of");
		expect(i.labels).toEqual([]);
		expect(i.done).toBe(false);
	});
	it("reads labels and a done status category", async () => {
		const raw = structuredClone(children[1]) as unknown as {
			fields: Record<string, unknown>;
		};
		raw.fields.labels = ["launch-readiness"];
		(
			raw.fields.status as { statusCategory: { key: string } }
		).statusCategory.key = "done";
		let url = "";
		const t = new JiraTracker(
			new Jira(cfg, (async (u: string | URL) => {
				url = String(u);
				return new Response(JSON.stringify(raw), { status: 200 });
			}) as typeof fetch),
		);
		const i = await t.issue("ACME-502");
		expect(url).toContain("labels");
		expect(i.labels).toEqual(["launch-readiness"]);
		expect(i.done).toBe(true);
	});
});

describe("JiraTracker writes", () => {
	it("links with the blocker as inwardIssue on the Blocks type", async () => {
		const s = jiraSubject();
		await s.tracker.link("ACME-503", "ACME-504");
		const post = s.calls.find((c) => c.url.endsWith("/issueLink"));
		expect(post?.body).toEqual({
			type: { name: "Blocks" },
			inwardIssue: { key: "ACME-503" },
			outwardIssue: { key: "ACME-504" },
		});
	});
	it("replaces the plan codeBlock in the ADF and keeps the other nodes", async () => {
		const s = jiraSubject();
		await s.tracker.setPlanBlock("ACME-502", "wave: 2");
		const put = s.calls.find((c) => c.method === "PUT");
		const body = put?.body as WriteBody;
		const content = (body.fields.description as { content: AdfNode[] }).content;
		expect(content.map((n) => n.type)).toEqual(["paragraph", "codeBlock"]);
		expect(content[1]?.attrs).toEqual({ language: "plan" });
		expect(content[1]?.content).toEqual([{ type: "text", text: "wave: 2" }]);
	});
});

describe("trackerFromProfile", () => {
	const env = {
		JIRA_BASE_URL: "https://x.atlassian.net",
		JIRA_EMAIL: "a@b.c",
		JIRA_API_TOKEN: "t",
	};
	it("builds a Jira tracker by default", () => {
		const t = trackerFromProfile(testProfile(), env);
		expect(t).toBeInstanceOf(JiraTracker);
		expect(t.keyPattern.test("ACME-1")).toBe(true);
	});
	it("needs the Jira env", () => {
		expect(() => trackerFromProfile(testProfile(), {})).toThrow(PortiaProblem);
	});
});

describe("module boundary", () => {
	it("only tracker.ts imports plan/jira", () => {
		const hits: string[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, e.name);
				if (e.isDirectory()) walk(p);
				else if (
					/\.ts$/.test(e.name) &&
					/plan\/jira|\.\/jira"/.test(readFileSync(p, "utf8"))
				)
					hits.push(relative(join(import.meta.dirname, "../../src"), p));
			}
		};
		walk(join(import.meta.dirname, "../../src"));
		expect(hits).toEqual(["plan/tracker.ts"]);
	});
});
