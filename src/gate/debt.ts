import type { DebtRuleSpec } from "../core/config";

/**
 * The ticket-key regex source for work under `parentKey`: its own prefix only, so `UTF-8`
 * or `SHA-256` in a comment is not mistaken for a ticket.
 */
export const keyPatternFor = (parentKey: string) =>
	`${(parentKey.split("-")[0] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+`;

export interface DebtHit {
	rule: string;
	file: string;
	line: string;
}

const COMMENT = /^\s*(\/\/|\*|\/\*)/;
const HISTORY_WORDS =
	"(previously|used to|was changed|changed to|no longer|now uses|replaced|renamed|moved from)";
const TEST_FILE = /\.(spec|test|itest|e2e)\.tsx?$/;
const READS_SOURCE =
	/readFile(Sync)?\([^)]*['"`][^'"`]*\b(src|app)\/[^'"`]*\.(ts|tsx)['"`]/;

/**
 * Debt in the added lines of a `-U0` diff. The general rules (ticket history in comments,
 * tests reading source) are built in; `rules` are the profile's own, and `keyPattern` is
 * the tracker's ticket-key regex source.
 */
export function debtHits(
	diffU0: string,
	rules: DebtRuleSpec[],
	keyPattern: string,
): DebtHit[] {
	const compiled = rules.map((r) => ({
		name: r.name,
		pattern: new RegExp(r.pattern),
		exclude: r.exclude ? new RegExp(r.exclude) : undefined,
	}));
	// The key is case-sensitive (utf-8 is not a ticket); only the history words are not.
	const keys = new RegExp(`\\b(?:${keyPattern})\\b`, "g");
	const words = new RegExp(`\\b${HISTORY_WORDS}\\b`, "i");
	const history = (line: string) =>
		[...line.matchAll(keys)].some((m) =>
			words.test(line.slice(m.index + m[0].length)),
		);
	const hits: DebtHit[] = [];
	let file = "";
	for (const raw of diffU0.split("\n")) {
		if (raw.startsWith("+++ b/")) {
			file = raw.slice(6);
			continue;
		}
		if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
		const line = raw.slice(1);
		for (const r of compiled)
			if (r.pattern.test(line) && !r.exclude?.test(file))
				hits.push({ rule: r.name, file, line });
		if (COMMENT.test(line) && history(line))
			hits.push({ rule: "ticket-history-comment", file, line });
		if (TEST_FILE.test(file) && READS_SOURCE.test(line))
			hits.push({ rule: "test-reads-source", file, line });
	}
	return hits;
}
