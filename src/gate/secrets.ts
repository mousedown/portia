import picomatch from "picomatch";
import type { Profile } from "../core/config";
import type { Exec } from "../core/exec";

export interface SecretHit {
	rule: string;
	file: string;
	line: number;
}

const TOKENS: [string, RegExp][] = [
	["private-key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
	["aws-access-key-id", /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g],
	[
		"github-token",
		/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
	],
	["stripe-live-key", /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g],
	[
		"slack-token",
		/\bxox[abposr]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g,
	],
];
const ASSIGNED =
	/\b([A-Za-z0-9_.-]*(?:key|secret|token|password))\b["']?\s*(?::=|=>|[:=])\s*(["'`])([^"'`\s]+)\2/gi;
const ENV_ASSIGNED =
	/^\s*(?:export\s+)?([A-Za-z0-9_.-]*(?:key|secret|token|password))\s*[:=]\s*([^\s"'`#]+)\s*(?:#.*)?$/i;
const IDENT_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const PUBLIC_NAME = /public|publishable/i;
const TOKEN_CHARS = /^[A-Za-z0-9+/=_.-]+$/;
const PLACEHOLDER =
	/x{3,}|changeme|example|placeholder|dummy|redacted|your[_-]|<[^>]*>|\$\{[^}]*\}|\{\{/i;

/** Bits per character of `s`. */
function entropy(s: string): number {
	const counts = new Map<string, number>();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values())
		bits -= (n / s.length) * Math.log2(n / s.length);
	return bits;
}

const secretValue = (name: string, value: string) =>
	!PUBLIC_NAME.test(name) &&
	value.length >= 20 &&
	TOKEN_CHARS.test(value) &&
	!PLACEHOLDER.test(value) &&
	entropy(value) >= 3.5;

/** The built-in rule `line` breaks, if any. */
export function secretRule(line: string): string | undefined {
	for (const [name, re] of TOKENS)
		for (const m of line.matchAll(re)) if (!PLACEHOLDER.test(m[0])) return name;
	for (const a of line.matchAll(ASSIGNED))
		if (secretValue(a[1] ?? "", a[3] ?? "")) return "assigned-secret";
	const e = ENV_ASSIGNED.exec(line);
	const bare = e?.[2] ?? "";
	if (
		e &&
		/\d/.test(bare) &&
		!IDENT_PATH.test(bare) &&
		secretValue(e[1] ?? "", bare)
	)
		return "assigned-secret";
	return undefined;
}

/** A `+++` header's path without its `b/`, unquoting one git quoted; "" for /dev/null. */
function headerPath(s: string): string {
	if (s.startsWith('"')) {
		const bytes: number[] = [];
		const esc: Record<string, string> = {
			n: "\n",
			t: "\t",
			'"': '"',
			"\\": "\\",
		};
		for (let i = 1; i < s.length - 1; i++) {
			const oct = /^\\([0-7]{3})/.exec(s.slice(i));
			if (oct) {
				bytes.push(Number.parseInt(oct[1] ?? "0", 8));
				i += 3;
			} else if (s[i] === "\\") {
				bytes.push(...Buffer.from(esc[s[i + 1] ?? ""] ?? s[i + 1] ?? ""));
				i++;
			} else bytes.push(...Buffer.from(s[i] ?? ""));
		}
		s = Buffer.from(bytes).toString("utf8");
	}
	return s.startsWith("b/") ? s.slice(2) : "";
}

/**
 * Likely credentials in the added lines of a `-U0` diff, by file and new line number; a
 * hit never carries the line, so a report of it cannot leak the value. Files matching an
 * `allow` glob are skipped.
 */
export function secretHits(diffU0: string, allow: string[]): SecretHit[] {
	const allowed = allow.length ? picomatch(allow, { dot: true }) : () => false;
	const hits: SecretHit[] = [];
	let file = "";
	let next = 0;
	let adds = 0;
	let dels = 0;
	for (const raw of diffU0.split("\n")) {
		if (adds > 0 || dels > 0) {
			if (raw.startsWith("-")) dels--;
			if (!raw.startsWith("+")) continue;
			adds--;
			const line = next++;
			if (!file || allowed(file)) continue;
			const rule = secretRule(raw.slice(1));
			if (rule) hits.push({ rule, file, line });
			continue;
		}
		if (raw.startsWith("+++ ")) {
			file = headerPath(raw.slice(4));
			continue;
		}
		const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
		if (hunk) {
			dels = Number(hunk[1] ?? 1);
			next = Number(hunk[2]);
			adds = Number(hunk[3] ?? 1);
		}
	}
	return hits;
}

/**
 * The secret scan of `base...head`: the built-in rules, then the profile's `secretScan.cmd`.
 * A failure says "secret" so a failed child parks rather than retries, and shows only
 * file:line and rule; the command's own output is withheld, since it may print the value.
 */
export async function secretStep(
	exec: Exec,
	cwd: string,
	p: Pick<Profile, "gates">,
	range: { base: string; head: string },
	env?: Record<string, string>,
): Promise<{ name: string; ok: boolean; tail: string }> {
	const name = "secrets";
	const spec = p.gates.secretScan;
	const diff = await exec(
		"git",
		[
			"diff",
			"-U0",
			"--no-color",
			"--no-ext-diff",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			`${range.base}...${range.head}`,
		],
		{ cwd },
	);
	if (diff.code !== 0) return { name, ok: false, tail: diff.stderr.trim() };
	const hits = secretHits(diff.stdout, spec?.allow ?? []);
	if (hits.length)
		return {
			name,
			ok: false,
			tail: hits.map((h) => `secret ${h.rule}: ${h.file}:${h.line}`).join("\n"),
		};
	if (!spec?.cmd) return { name, ok: true, tail: "" };
	const cmd = spec.cmd
		.replaceAll("{base}", range.base)
		.replaceAll("{head}", range.head);
	const r = await exec("sh", ["-c", cmd], { cwd, env });
	return r.code === 0
		? { name, ok: true, tail: "" }
		: {
				name,
				ok: false,
				tail: `the secret scan command exited ${r.code}; run it in the worktree to see its findings, withheld here so no secret is copied`,
			};
}
