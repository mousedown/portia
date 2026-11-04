import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isAccountFailure,
	notLoggedIn,
	resetAt,
	usageLimit,
} from "../../src/worker/usage-limit";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const HOUR = 3_600_000;
const log = (...lines: unknown[]) => {
	const file = join(mkdtempSync(join(tmpdir(), "portia-limit-")), "w.log");
	writeFileSync(
		file,
		`${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
	);
	return file;
};

describe("resetAt", () => {
	it("reads an epoch suffix", () => {
		expect(resetAt("Claude AI usage limit reached|1767265200", T0)).toBe(
			1767265200 * 1000,
		);
	});

	it("reads a time of day in a named zone, today or tomorrow", () => {
		// 10:00 UTC is 10:00 in London in January.
		expect(
			resetAt("5-hour limit reached ∙ resets 3pm (Europe/London)", T0),
		).toBe(Date.parse("2026-01-01T15:00:00Z"));
		expect(resetAt("resets 9:30am (Europe/London)", T0)).toBe(
			Date.parse("2026-01-02T09:30:00Z"),
		);
		expect(resetAt("resets 3pm (America/New_York)", T0)).toBe(
			Date.parse("2026-01-01T20:00:00Z"),
		);
	});

	it("lands on the minute whatever the seconds of now", () => {
		expect(resetAt("resets 3pm (UTC)", T0 + 42_123)).toBe(
			Date.parse("2026-01-01T15:00:00Z"),
		);
	});

	it("reads a date and time, rolling into next year once it has passed", () => {
		expect(resetAt("weekly limit reached ∙ resets Jan 5, 9am (UTC)", T0)).toBe(
			Date.parse("2026-01-05T09:00:00Z"),
		);
		expect(resetAt("resets Dec 31 at 11pm (UTC)", T0)).toBe(
			Date.parse("2026-12-31T23:00:00Z"),
		);
	});

	it("is undefined for a time it cannot read or a zone it does not know", () => {
		expect(resetAt("limit reached, try again later", T0)).toBeUndefined();
		expect(resetAt("resets 3pm (Mars/Olympus)", T0)).toBeUndefined();
		expect(resetAt("resets 27:00", T0)).toBeUndefined();
	});
});

describe("usageLimit", () => {
	it("an error result with a limit message names its reset", () => {
		const hit = usageLimit(
			log(
				{
					type: "assistant",
					message: { content: [{ type: "text", text: "working" }] },
				},
				{
					type: "result",
					is_error: true,
					result: "Claude AI usage limit reached|1767268800",
				},
			),
			T0,
			HOUR,
		);
		expect(hit).toEqual({
			until: 1767268800 * 1000,
			message: "Claude AI usage limit reached|1767268800",
		});
	});

	it("an assistant message flagged rate_limit counts, and a limit naming no time lasts the cooldown", () => {
		const hit = usageLimit(
			log({
				type: "assistant",
				error: "rate_limit",
				message: { content: [{ type: "text", text: "You've hit your limit" }] },
			}),
			T0,
			HOUR,
		);
		expect(hit).toEqual({ until: T0 + HOUR, message: "You've hit your limit" });
	});

	it("a rejected rate_limit_event gives its reset time", () => {
		const hit = usageLimit(
			log({
				type: "rate_limit_event",
				rate_limit_info: { status: "rejected", resetsAt: T0 / 1000 + 7200 },
			}),
			T0,
			HOUR,
		);
		expect(hit?.until).toBe(T0 + 2 * HOUR);
	});

	it("what a tool printed, a successful result or a warning is never a limit", () => {
		expect(
			usageLimit(
				log(
					{
						type: "user",
						message: {
							content: [
								{
									type: "tool_result",
									content: "usage limit reached|1767268800",
								},
							],
						},
					},
					{
						type: "rate_limit_event",
						rate_limit_info: { status: "allowed_warning" },
					},
					{
						type: "result",
						is_error: false,
						result: "the rate limit test passes",
					},
				),
				T0,
				HOUR,
			),
		).toBeUndefined();
		expect(usageLimit("/no/such/log", T0, HOUR)).toBeUndefined();
	});
});

// The tail of a real worker log that ran under a CLAUDE_CONFIG_DIR with no login stored for it.
const AUTH_FAILED = [
	{
		type: "assistant",
		error: "authentication_failed",
		is_api_error_message: true,
		message: {
			model: "<synthetic>",
			content: [{ type: "text", text: "Not logged in · Please run /login" }],
		},
	},
	{
		type: "result",
		subtype: "success",
		is_error: true,
		terminal_reason: "api_error",
		result: "Not logged in · Please run /login",
	},
];

describe("notLoggedIn", () => {
	it("a log ending on Claude Code's authentication_failed is not logged in, with its message", () => {
		expect(notLoggedIn(log(...AUTH_FAILED))).toBe(
			"Not logged in · Please run /login",
		);
		expect(usageLimit(log(...AUTH_FAILED), T0, HOUR)).toBeUndefined();
	});

	it("what a tool printed does not count, nor does a log with no login message", () => {
		expect(
			notLoggedIn(
				log(
					{
						type: "user",
						message: { content: "gh: Not logged in · Please run /login" },
					},
					{ type: "result", is_error: false, result: "Not logged in, done" },
				),
			),
		).toBeUndefined();
		expect(notLoggedIn(log({ type: "result", result: "ok" }))).toBeUndefined();
	});

	it("a missing login is the account's failure, like a usage limit", () => {
		expect(isAccountFailure("not-logged-in: account a is not logged in")).toBe(
			true,
		);
		expect(isAccountFailure("usage-limit: account a")).toBe(true);
		expect(isAccountFailure("stalled: no log output")).toBe(false);
	});
});
