import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** A failed worker's reason starts with this when its account hit its usage limit. */
export const USAGE_LIMIT = "usage-limit:";
export const isUsageLimit = (reason: string) => reason.startsWith(USAGE_LIMIT);
/** A failed worker's reason starts with this when its account is not logged in. */
export const NOT_LOGGED_IN = "not-logged-in:";
/** Whether the failure was the account's rather than the child's, so the retry spends none. */
export const isAccountFailure = (reason: string) =>
	isUsageLimit(reason) || reason.startsWith(NOT_LOGGED_IN);

/** How Claude Code words a subscription's usage limit in its final message. */
const LIMIT_TEXT =
	/usage limit|hit your (?:usage )?limit|limit reached|limit will reset|out of extra usage/i;
const EPOCH = /\|(\d{10})(?!\d)/;
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const RESETS =
	/resets?\s+(?:at\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

/** The wall clock in `zone` (the machine's own when unset) at `now`, as if it were UTC. */
function wallAsUtc(now: number, zone?: string): number {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		})
			.formatToParts(now)
			.map((p) => [p.type, Number(p.value)]),
	) as Record<string, number>;
	return Date.UTC(
		parts.year ?? 0,
		(parts.month ?? 1) - 1,
		parts.day ?? 1,
		parts.hour ?? 0,
		parts.minute ?? 0,
		parts.second ?? 0,
	);
}

/**
 * When a limit message says the limit resets, after `now`: a `|<epoch>` suffix, or
 * "resets 3pm", "resets 3:30pm (Europe/London)", "resets Oct 22, 9am". Undefined when it
 * names no time Portia can read.
 */
export function resetAt(text: string, now: number): number | undefined {
	const epoch = EPOCH.exec(text);
	if (epoch) return Number(epoch[1]) * 1000;
	const m = RESETS.exec(text);
	if (!m) return undefined;
	const [, mon, day, h, min, ampm, zone] = m;
	let hour = Number(h);
	if (hour > 23 || Number(min ?? 0) > 59) return undefined;
	if (ampm) hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
	let offset: number;
	try {
		// Zones are whole minutes off UTC; the wall clock has no milliseconds to subtract.
		offset = Math.round((wallAsUtc(now, zone) - now) / 60_000) * 60_000;
	} catch {
		return undefined;
	}
	const wall = new Date(now + offset);
	const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1;
	if (mon && month < 0) return undefined;
	const at = (year: number, mo: number, d: number) =>
		Date.UTC(year, mo, d, hour, Number(min ?? 0)) - offset;
	if (mon) {
		const y = wall.getUTCFullYear();
		const t = at(y, month, Number(day));
		return t > now ? t : at(y + 1, month, Number(day));
	}
	const t = at(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
	return t > now ? t : t + 86_400_000;
}

const TAIL = 64 * 1024;
function tailLines(log: string): string[] {
	let fd: number;
	try {
		fd = openSync(log, "r");
	} catch {
		return [];
	}
	try {
		const size = fstatSync(fd).size;
		const from = Math.max(0, size - TAIL);
		const buf = Buffer.alloc(size - from);
		readSync(fd, buf, 0, buf.length, from);
		const lines = buf.toString("utf8").split("\n");
		return from > 0 ? lines.slice(1) : lines;
	} catch {
		return [];
	} finally {
		closeSync(fd);
	}
}

type LogLine = {
	type?: string;
	is_error?: boolean;
	result?: unknown;
	api_error_status?: unknown;
	error?: unknown;
	message?: { content?: unknown };
	rate_limit_info?: { status?: unknown; resetsAt?: unknown };
};
const textOf = (content: unknown) =>
	Array.isArray(content)
		? content.map((b) => (typeof b?.text === "string" ? b.text : "")).join(" ")
		: typeof content === "string"
			? content
			: "";

const LOGIN_TEXT = /not logged in|please run \/login|invalid api key/i;

/**
 * Whether a worker's stream-json or json log ends on its account not being logged in, and
 * Claude Code's message. Only Claude Code's own signals count: an assistant message flagged
 * `authentication_failed`, or an error `result` whose text is a login message.
 */
export function notLoggedIn(log: string): string | undefined {
	let hit: string | undefined;
	for (const line of tailLines(log)) {
		if (!line.includes("authentication_failed") && !LOGIN_TEXT.test(line))
			continue;
		let e: LogLine;
		try {
			e = JSON.parse(line) as LogLine;
		} catch {
			continue;
		}
		const text =
			e.type === "assistant" && e.error === "authentication_failed"
				? textOf(e.message?.content)
				: e.type === "result" &&
						e.is_error === true &&
						typeof e.result === "string" &&
						LOGIN_TEXT.test(e.result)
					? e.result
					: undefined;
		if (text !== undefined) hit = text.trim().slice(0, 200) || "not logged in";
	}
	return hit;
}

/**
 * Whether a worker's stream-json or json log ends on its account's usage limit, and until
 * when. Only Claude Code's own signals count, never what a tool printed: a rejected
 * `rate_limit_event`, an assistant message flagged `rate_limit`, or an error `result` whose
 * text is a limit message. A limit that names no reset time lasts `cooldownMs`.
 */
export function usageLimit(
	log: string,
	now: number,
	cooldownMs: number,
): { until: number; message: string } | undefined {
	let hit: { until?: number; message: string } | undefined;
	for (const line of tailLines(log)) {
		if (!line.includes("limit") && !line.includes("429")) continue;
		let e: LogLine;
		try {
			e = JSON.parse(line) as LogLine;
		} catch {
			continue;
		}
		if (
			e.type === "rate_limit_event" &&
			e.rate_limit_info?.status === "rejected"
		) {
			const at = Number(e.rate_limit_info.resetsAt);
			hit = {
				until: Number.isFinite(at) && at > 0 ? at * 1000 : hit?.until,
				message: hit?.message ?? "the account's rate limit was rejected",
			};
			continue;
		}
		const text =
			e.type === "assistant" && e.error === "rate_limit"
				? textOf(e.message?.content)
				: e.type === "result" &&
						e.is_error === true &&
						typeof e.result === "string" &&
						(LIMIT_TEXT.test(e.result) || e.api_error_status === 429)
					? e.result
					: undefined;
		if (text === undefined) continue;
		const message = text.trim().slice(0, 200) || "usage limit reached";
		hit = { until: resetAt(text, now) ?? hit?.until, message };
	}
	if (!hit) return undefined;
	const until =
		hit.until !== undefined && hit.until > now ? hit.until : now + cooldownMs;
	return { until, message: hit.message };
}
