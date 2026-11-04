import { expect, it } from "vitest";
import { debtHits } from "../../src/gate/debt";
import acme from "../fixtures/profile";

const KEY = String.raw`[A-Z][A-Z0-9]+-\d+`;

const diff = [
	"+++ b/packages/acme-web/src/app/x.tsx",
	"+  const rows = await db.booking.findMany({});",
	"+  // ACME-1234 previously this used the old helper",
	"+  // See ACME-1234 for the contract.",
	"+++ b/packages/acme-web/src/server/repositories/y.ts",
	"+  return orm.booking.findMany({});",
	"+++ b/packages/acme-web/specs/z.spec.ts",
	"+  const src = readFileSync('src/app/x.tsx', 'utf8');",
].join("\n");

it("flags the three mechanical ACME-1834 patterns and nothing else", () => {
	expect(
		debtHits(diff, acme.debt, KEY).map((h) => `${h.rule} ${h.file}`),
	).toEqual([
		"orm-outside-repository packages/acme-web/src/app/x.tsx",
		"ticket-history-comment packages/acme-web/src/app/x.tsx",
		"test-reads-source packages/acme-web/specs/z.spec.ts",
	]);
});

it("a profile rule fires on its pattern, skipping excluded files, and general rules keep working with no profile rules", () => {
	const d = [
		"+++ b/src/a.ts",
		"+  forbidden();",
		"+++ b/vendor/b.ts",
		"+  forbidden();",
		"+++ b/src/c.ts",
		"+  // ABC-12 used to be different",
	].join("\n");
	const rules = [
		{ name: "no-forbidden", pattern: "forbidden\\(", exclude: "^vendor/" },
	];
	expect(debtHits(d, rules, KEY).map((h) => `${h.rule} ${h.file}`)).toEqual([
		"no-forbidden src/a.ts",
		"ticket-history-comment src/c.ts",
	]);
	expect(debtHits(d, [], KEY).map((h) => h.rule)).toEqual([
		"ticket-history-comment",
	]);
});

it("matches ticket keys case-sensitively but history words case-insensitively", () => {
	const d = (c: string) => `+++ b/src/a.ts\n+${c}`;
	expect(debtHits(d("// utf-8 replaced by x"), [], KEY)).toEqual([]);
	expect(debtHits(d("// sha-256 used to be md5"), [], KEY)).toEqual([]);
	expect(debtHits(d("// ABC-12 replaced by x"), [], KEY)).toHaveLength(1);
	expect(debtHits(d("// ABC-12 Replaced by x"), [], KEY)).toHaveLength(1);
});
