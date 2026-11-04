import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markLimited, markNotLoggedIn } from "../../src/core/accounts";
import { testProfile } from "../../src/core/config";
import { readRows } from "../../src/core/runlog";
import { decide, type JevClient } from "../../src/decide/decide";
import { httpJev } from "../../src/decide/jev";

const dir = () => mkdtempSync(join(tmpdir(), "portia-dec-"));
const off = testProfile();
const on = { ...off, jev: { enabled: true, url: "https://jev" } };
const jev = (answer: string): JevClient & { asked: number } => {
	const j = {
		asked: 0,
		ask: async () => {
			j.asked++;
			return { answer, why: "jev says" };
		},
	};
	return j;
};
const base = {
	child: "ACME-2",
	touches: ["packages/acme-web/src/lib/onboarding/actions.ts"],
};

describe("rules answer first", () => {
	it("retries a first failure, parks after the retries and on permission errors", async () => {
		expect(
			(
				await decide(
					"failure",
					{ ...base, failure: { reason: "tests failed", attempts: 1 } },
					{ profile: off, dir: dir() },
				)
			).answer,
		).toBe("retry");
		expect(
			(
				await decide(
					"failure",
					{ ...base, failure: { reason: "tests failed", attempts: 2 } },
					{ profile: off, dir: dir() },
				)
			).answer,
		).toBe("park");
		expect(
			(
				await decide(
					"failure",
					{ ...base, failure: { reason: "permission denied", attempts: 1 } },
					{ profile: off, dir: dir() },
				)
			).answer,
		).toBe("park");
	});
	it("parks a land the secret scan refused, rather than retrying it", async () => {
		const reason =
			"secret scan refused to push portia/ACME-2 at abc:\nsecret aws-access-key-id: src/x.ts:5";
		expect(
			(
				await decide(
					"failure",
					{ ...base, failure: { reason, attempts: 1 } },
					{ profile: off, dir: dir() },
				)
			).answer,
		).toBe("park");
	});
	it("accepts only incidental files outside touches", async () => {
		expect(
			(
				await decide(
					"touches-mismatch",
					{ ...base, outside: ["bun.lock"] },
					{ profile: off, dir: dir() },
				)
			).answer,
		).toBe("accept");
		expect(
			(
				await decide(
					"touches-mismatch",
					{ ...base, outside: ["packages/acme-web/src/app/x.tsx"] },
					{ profile: off, dir: dir() },
				)
			).answer,
		).toBe("park");
	});
});

describe("Jev", () => {
	it("is never asked while disabled", async () => {
		const j = jev("answered");
		const d = await decide(
			"park-answerable",
			{ ...base, park: { question: "q", ticket: "t" } },
			{ profile: off, dir: dir(), jev: j },
		);
		expect(d).toMatchObject({ answer: "ask-human", by: "rule" });
		expect(j.asked).toBe(0);
	});
	it("is asked when enabled and no rule answers", async () => {
		const d = await decide(
			"park-answerable",
			{ ...base, park: { question: "q", ticket: "t" } },
			{ profile: on, dir: dir(), jev: jev("answered") },
		);
		expect(d).toMatchObject({ answer: "answered", by: "jev" });
	});
	it("is never sent a child that touches sensitive code (N6)", async () => {
		const j = jev("answered");
		const d = await decide(
			"park-answerable",
			{
				child: "ACME-9",
				touches: ["packages/acme-web/src/server/payments/x.ts"],
				park: { question: "q", ticket: "t" },
			},
			{ profile: on, dir: dir(), jev: j },
		);
		expect(d.answer).toBe("ask-human");
		expect(j.asked).toBe(0);
	});
	it("fails closed on a wildcard touch that could reach sensitive code", async () => {
		const j = jev("answered");
		const d = await decide(
			"park-answerable",
			{
				child: "ACME-9",
				touches: ["packages/acme-web/src/**"],
				park: { question: "q", ticket: "t" },
			},
			{ profile: on, dir: dir(), jev: j },
		);
		expect(d).toMatchObject({ answer: "ask-human", by: "rule" });
		expect(j.asked).toBe(0);
	});
	it("screens the real outside paths too", async () => {
		const j = jev("accept");
		const d = await decide(
			"touches-mismatch",
			{ ...base, outside: ["packages/acme-web/src/server/payments/x.ts"] },
			{ profile: on, dir: dir(), jev: j },
		);
		expect(d.answer).toBe("park");
		expect(j.asked).toBe(0);
	});
	it("contains a throwing Jev and still logs the decision", async () => {
		const d = dir();
		const bad: JevClient = {
			ask: async () => {
				throw new Error("boom");
			},
		};
		const r = await decide(
			"park-answerable",
			{ ...base, park: { question: "q", ticket: "t" } },
			{ profile: on, dir: d, jev: bad },
		);
		expect(r).toMatchObject({ answer: "ask-human", by: "rule" });
		expect(r.why).toContain("boom");
		expect(readRows(d).rows[0]).toMatchObject({
			stage: "decision",
			status: "ask-human",
		});
	});
	it("falls back when Jev returns an answer outside the allowed set", async () => {
		expect(
			(
				await decide(
					"touches-mismatch",
					{ ...base, outside: ["x.ts"] },
					{ profile: on, dir: dir(), jev: jev("merge it anyway") },
				)
			).answer,
		).toBe("park");
	});
});

describe("httpJev", () => {
	it("posts kind and input with a bearer key, without real HTTP", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fake = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ answer: "answered", why: "w" }));
		}) as unknown as typeof fetch;
		const r = await httpJev("https://jev", "k", fake).ask(
			"park-answerable",
			base,
		);
		expect(r).toEqual({ answer: "answered", why: "w" });
		expect(seen?.url).toBe("https://jev");
		expect(new Headers(seen?.init.headers).get("Authorization")).toBe(
			"Bearer k",
		);
		expect(JSON.parse(String(seen?.init.body)).kind).toBe("park-answerable");
	});
	it("throws on a non-OK response", async () => {
		const fake = (async () =>
			new Response("no", { status: 500 })) as unknown as typeof fetch;
		await expect(
			httpJev("https://jev", "k", fake).ask("failure", base),
		).rejects.toThrow("500");
	});
});

it("logs every decision with who answered", async () => {
	const d = dir();
	await decide(
		"failure",
		{ ...base, failure: { reason: "x", attempts: 1 } },
		{ profile: off, dir: d },
	);
	expect(readRows(d).rows[0]).toMatchObject({
		child: "ACME-2",
		stage: "decision",
		status: "retry",
		data: { by: "rule", kind: "failure" },
	});
});

describe("per-child touch approvals", () => {
	const outside = ["bun.lock", "packages/acme-web/src/jobs/registry.ts"];
	it("accepts files the person approved for this child, alongside incidental ones", async () => {
		const d = await decide(
			"touches-mismatch",
			{ ...base, outside, approved: ["packages/acme-web/src/jobs/**"] },
			{ profile: off, dir: dir() },
		);
		expect(d).toMatchObject({ answer: "accept", by: "rule" });
		expect(d.why).toContain("approved");
	});
	it("still parks a file neither incidental nor approved", async () => {
		const d = await decide(
			"touches-mismatch",
			{
				...base,
				outside: [...outside, "packages/acme-web/src/lib/other.ts"],
				approved: ["packages/acme-web/src/jobs/**"],
			},
			{ profile: off, dir: dir() },
		);
		expect(d.answer).toBe("park");
	});
});

describe("usage limits", () => {
	const detached = {
		...off,
		workers: {
			...off.workers,
			mode: "detached" as const,
			accounts: [
				{ name: "work", configDir: "/c/work" },
				{ name: "home", configDir: "/c/home" },
			],
		},
	};
	const reason =
		"usage-limit: account work is at its usage limit until 2099-01-01T00:00:00.000Z (limit reached)";
	const withHome = async (fn: (home: string) => Promise<void>) => {
		const saved = process.env.PORTIA_HOME;
		const home = mkdtempSync(join(tmpdir(), "portia-home-"));
		process.env.PORTIA_HOME = home;
		try {
			await fn(home);
		} finally {
			if (saved === undefined) delete process.env.PORTIA_HOME;
			else process.env.PORTIA_HOME = saved;
		}
	};

	it("retries on another account even after every retry is spent", () =>
		withHome(async (home) => {
			markLimited("work", Date.parse("2099-01-01"), "limit", { home });
			const d = await decide(
				"failure",
				{ ...base, failure: { reason, attempts: 9 } },
				{ profile: detached, dir: dir() },
			);
			expect(d).toMatchObject({ answer: "retry", by: "rule" });
		}));

	it("a missing login retries on another account and spends no retry", () =>
		withHome(async (home) => {
			markNotLoggedIn("work", "the default login", { home });
			const d = await decide(
				"failure",
				{
					...base,
					failure: {
						reason:
							"not-logged-in: account work (the default login) is not logged in (Not logged in · Please run /login)",
						attempts: 9,
					},
				},
				{ profile: detached, dir: dir() },
			);
			expect(d).toMatchObject({ answer: "retry", by: "rule" });
			expect(d.why).toContain("not logged in");
		}));

	it("parks, naming when one frees, once every account is at its limit", () =>
		withHome(async (home) => {
			markLimited("work", Date.parse("2099-01-01"), "limit", { home });
			markLimited("home", Date.parse("2098-01-01"), "limit", { home });
			const d = await decide(
				"failure",
				{ ...base, failure: { reason, attempts: 0 } },
				{ profile: detached, dir: dir() },
			);
			expect(d.answer).toBe("park");
			expect(d.why).toContain("the soonest frees at 2098-01-01T00:00:00.000Z");
		}));
});
