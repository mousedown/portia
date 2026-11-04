import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Portia knows no particular project: project specifics live in the user's profile.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SCANNED = [
	"src",
	"skills",
	"test",
	"examples",
	"docs",
	"eval",
	"scripts",
	".github",
	".claude-plugin",
	"README.md",
	"CONTRIBUTING.md",
	"package.json",
];
const SKIPPED = new Set(["node_modules", "results"]);

const files = (p: string): string[] =>
	statSync(p).isDirectory()
		? readdirSync(p)
				.filter((n) => !SKIPPED.has(n))
				.flatMap((n) => files(join(p, n)))
		: p.endsWith(".png")
			? []
			: [p];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// The names themselves would be what this test keeps out, so it holds their hashes: to add
// one, hash it in lowercase with no separators, and add its length to BANNED_LENGTHS.
const SAMPLE = "zzbannedsample";
const BANNED_HASHES = new Set([
	sha256(SAMPLE),
	"370b509cc4d6b92b91ab3f0ef5ed0659e71d4fe3909d937dfd158943993567b1",
	"5a85809970fcce0768534c9519bc8aef945ef46e6fc281cb8ff0f1e199916dd5",
	"716bdc55968549b34fcfdf5ea4f491a8ea9b9b36241ac469bdffb60750afb532",
	"897236c37fadc70ced8e71cd7b5a85d88ff055e836cb11194061af73c9ee5ff0",
	"b712e1cb406fbf80c3a6ef21e78d25c2d719a1b90e24c58b4254293077ac002f",
	"d10830188785adeee16b6ba60f7a4a3aa6bfe86d4093d0fcf3457aa5b9bfaddd",
	"d8c92791d2280abe5985ffaeaa07063cf0c8b9abf5338d688504e6074cf99093",
	"de882d5b65291a1b92677b2bcaa6840313236a51a8eefb8e1f6497a8adb0705a",
]);
const BANNED_LENGTHS = [...new Set([...[6, 7, 9, 10, 14], SAMPLE.length])];
const BANNED_TICKET = /\bSV-\d/;

const seen = new Map<string, boolean>();
const hasBannedPart = (word: string): boolean => {
	const known = seen.get(word);
	if (known !== undefined) return known;
	const found = BANNED_LENGTHS.some((n) => {
		for (let i = 0; i + n <= word.length; i++) {
			if (BANNED_HASHES.has(sha256(word.slice(i, i + n)))) return true;
		}
		return false;
	});
	seen.set(word, found);
	return found;
};

const namesAProject = (line: string): boolean => {
	if (BANNED_TICKET.test(line)) return true;
	const words = line.toLowerCase().split(/[^a-z0-9]+/);
	return words.some(
		(word, i) =>
			hasBannedPart(word) ||
			(i > 0 && BANNED_HASHES.has(sha256(`${words[i - 1]}${word}`))),
	);
};

it("recognises a banned name in any case, inside a word or split in two", () => {
	expect(namesAProject("the ZZBannedSample profile")).toBe(true);
	expect(namesAProject("ourzzbannedsamplekit")).toBe(true);
	expect(namesAProject("zzbanned.sample")).toBe(true);
	expect(namesAProject("an acme profile")).toBe(false);
});

it("names no particular project in anything the repository publishes", () => {
	const scanned = SCANNED.flatMap((p) => files(join(ROOT, p))).filter(
		(f) => f !== SELF,
	);
	expect(scanned.length).toBeGreaterThan(50);
	const hits = scanned.flatMap((f) =>
		readFileSync(f, "utf8")
			.split("\n")
			.flatMap((line, i) =>
				namesAProject(line) ? [`${relative(ROOT, f)}:${i + 1}`] : [],
			),
	);
	expect(hits).toEqual([]);
});
