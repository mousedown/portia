import { describe, expect, it } from "vitest";
import { PortiaProblem } from "../../src/core/exit";
import { adfToText, withPlanBlockAdf } from "../../src/plan/adf";
import { blockedBy, Jira, jiraFromEnv } from "../../src/plan/jira";
import { type Call, fakeFetch } from "../helpers/fake-fetch";

const cfg = { baseUrl: "https://x.atlassian.net", email: "a@b.c", token: "t" };

describe("adfToText", () => {
	it("keeps a link's href and every card's url", () => {
		const doc = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "Figma design",
							marks: [
								{ type: "strong" },
								{ type: "link", attrs: { href: "https://f/1" } },
							],
						},
						{ type: "inlineCard", attrs: { url: "https://i/2" } },
					],
				},
				{ type: "blockCard", attrs: { url: "https://b/3" } },
				{ type: "embedCard", attrs: { url: "https://e/4" } },
			],
		};
		const text = adfToText(doc);
		expect(text).toContain("Figma design (https://f/1)");
		for (const u of ["https://i/2", "https://b/3", "https://e/4"])
			expect(text).toContain(u);
	});
	it("does not repeat a link whose text is its href", () => {
		const doc = {
			type: "text",
			text: "https://f/1",
			marks: [{ type: "link", attrs: { href: "https://f/1" } }],
		};
		expect(adfToText(doc)).toBe("https://f/1");
	});
	it("turns a portia codeBlock back into a fenced block", () => {
		const doc = {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Intro" }] },
				{
					type: "codeBlock",
					attrs: { language: "portia" },
					content: [{ type: "text", text: "wave: 1\ntier: high" }],
				},
			],
		};
		expect(adfToText(doc)).toContain(
			`${"`".repeat(3)}portia\nwave: 1\ntier: high\n${"`".repeat(3)}`,
		);
	});
});

describe("Jira", () => {
	it("needs all three env vars", () => {
		expect(() => jiraFromEnv({ JIRA_BASE_URL: "x" })).toThrow(PortiaProblem);
	});
	it("reads only inward Blocks links as blockedBy", () => {
		const issue = {
			key: "ACME-2",
			fields: {
				summary: "s",
				description: null,
				issuelinks: [
					{ type: { name: "Blocks" }, inwardIssue: { key: "ACME-1" } },
					{ type: { name: "Blocks" }, outwardIssue: { key: "ACME-3" } },
					{ type: { name: "Relates" }, inwardIssue: { key: "ACME-4" } },
				],
			},
		};
		expect(blockedBy(issue)).toEqual(["ACME-1"]);
	});
	it("transitions by name and fails clearly on an unknown one", async () => {
		const calls: Call[] = [];
		const jira = new Jira(
			cfg,
			fakeFetch(
				{
					"/transitions": {
						transitions: [{ id: "31", name: "In Development" }],
					},
				},
				calls,
			),
		);
		await jira.transition("ACME-2", "In Development");
		expect(calls.at(-1)).toMatchObject({
			method: "POST",
			body: { transition: { id: "31" } },
		});
		await expect(jira.transition("ACME-2", "Shipped")).rejects.toThrow(
			/no transition named 'Shipped'/,
		);
	});
	it("posts a comment as ADF paragraphs", async () => {
		const calls: Call[] = [];
		await new Jira(cfg, fakeFetch({ "/comment": {} }, calls)).comment(
			"ACME-2",
			"one\n\ntwo",
		);
		expect(calls[0]?.body).toMatchObject({
			body: {
				type: "doc",
				content: [{ type: "paragraph" }, { type: "paragraph" }],
			},
		});
	});

	/** A fetch that answers with `statuses` in turn (a thrown Error for "net"), recording each call. */
	const flaky = (statuses: (number | "net")[]) => {
		const seen: { method: string; signal: boolean }[] = [];
		const fn = (async (_url: string, init?: RequestInit) => {
			seen.push({ method: init?.method ?? "GET", signal: !!init?.signal });
			const s = statuses[seen.length - 1] ?? 200;
			if (s === "net") throw new TypeError("fetch failed");
			return new Response(
				JSON.stringify({ key: "ACME-2", fields: { summary: "s" } }),
				{ status: s },
			);
		}) as typeof fetch;
		return { fn, seen };
	};
	const quick = { sleep: async () => {} };

	it("retries a GET through rate limiting, server errors and network failures, each under a timeout", async () => {
		const f = flaky([429, "net", 200]);
		const issue = await new Jira(cfg, f.fn, quick).issue("ACME-2");
		expect(issue.key).toBe("ACME-2");
		expect(f.seen).toHaveLength(3);
		expect(f.seen.every((c) => c.signal)).toBe(true);
	});
	it("gives up on a GET after the last attempt", async () => {
		const f = flaky([503, 503, 503, 200]);
		await expect(new Jira(cfg, f.fn, quick).issue("ACME-2")).rejects.toThrow(
			/returned 503/,
		);
		expect(f.seen).toHaveLength(3);
		const net = flaky(["net", "net", "net"]);
		await expect(new Jira(cfg, net.fn, quick).issue("ACME-2")).rejects.toThrow(
			/fetch failed/,
		);
	});
	it("never repeats a write, which may have landed", async () => {
		const f = flaky([503, 200]);
		await expect(
			new Jira(cfg, f.fn, quick).comment("ACME-2", "hi"),
		).rejects.toThrow(/returned 503/);
		expect(f.seen.map((c) => c.method)).toEqual(["POST"]);
	});
	it("does not retry a client error", async () => {
		const f = flaky([404, 200]);
		await expect(new Jira(cfg, f.fn, quick).issue("ACME-2")).rejects.toThrow(
			/returned 404/,
		);
		expect(f.seen).toHaveLength(1);
	});
});

describe("withPlanBlockAdf", () => {
	const para = { type: "paragraph", content: [{ type: "text", text: "Hi" }] };
	const code = (language: string, text: string) => ({
		type: "codeBlock",
		attrs: { language },
		content: [{ type: "text", text }],
	});
	it("builds a doc from nothing", () => {
		expect(withPlanBlockAdf(null, "wave: 1")).toEqual({
			type: "doc",
			version: 1,
			content: [code("plan", "wave: 1")],
		});
	});
	it("drops plan and portia blocks, keeps the rest, appends the new block", () => {
		const other = code("ts", "x");
		const doc = {
			type: "doc",
			version: 1,
			content: [para, code("portia", "old"), other, code("plan", "older")],
		};
		expect(withPlanBlockAdf(doc, "wave: 2")).toEqual({
			type: "doc",
			version: 1,
			content: [para, other, code("plan", "wave: 2")],
		});
	});
	it("preserves heading, table, mention, media and nested lists exactly", () => {
		const rich = [
			{
				type: "heading",
				attrs: { level: 2 },
				content: [{ type: "text", text: "Context" }],
			},
			{
				type: "table",
				attrs: { isNumberColumnEnabled: false, layout: "default" },
				content: [
					{
						type: "tableRow",
						content: [
							{
								type: "tableHeader",
								attrs: {},
								content: [
									{
										type: "paragraph",
										content: [
											{ type: "text", text: "H", marks: [{ type: "strong" }] },
										],
									},
								],
							},
						],
					},
				],
			},
			{
				type: "paragraph",
				content: [
					{ type: "mention", attrs: { id: "abc123", text: "@Chris" } },
					{ type: "text", text: " see " },
					{
						type: "text",
						text: "link",
						marks: [{ type: "link", attrs: { href: "https://example.com" } }],
					},
				],
			},
			{
				type: "mediaSingle",
				attrs: { layout: "center" },
				content: [
					{
						type: "media",
						attrs: { id: "m-1", type: "file", collection: "c" },
					},
				],
			},
			{
				type: "bulletList",
				content: [
					{
						type: "listItem",
						content: [
							{ type: "paragraph", content: [{ type: "text", text: "outer" }] },
							{
								type: "orderedList",
								attrs: { order: 1 },
								content: [
									{
										type: "listItem",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "inner" }],
											},
										],
									},
								],
							},
						],
					},
				],
			},
		];
		const doc = {
			type: "doc",
			version: 1,
			content: [
				rich[0],
				code("portia", "wave: 0"),
				rich[1],
				rich[2],
				rich[3],
				rich[4],
			],
		};
		const snapshot = structuredClone(doc);
		const out = withPlanBlockAdf(doc, "wave: 7") as {
			content: unknown[];
		};
		expect(doc).toEqual(snapshot);
		expect(out.content).toEqual([...rich, code("plan", "wave: 7")]);
	});
});
