import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	accountStatus,
	accountsOf,
	allLimited,
	clearLimits,
	markLimited,
	markNotLoggedIn,
	pickAccount,
} from "../../src/core/accounts";
import { ProfileSchema, testProfile } from "../../src/core/config";
import { PortiaProblem } from "../../src/core/exit";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const HOUR = 3_600_000;
const home = () => mkdtempSync(join(tmpdir(), "portia-acct-"));
const two = [
	{ name: "work", configDir: "/c/work" },
	{ name: "home", configDir: "/c/home" },
];

describe("accounts", () => {
	it("without accounts in the profile, workers use the CLI's own login", () => {
		expect(accountsOf(testProfile().workers)).toEqual([{ name: "default" }]);
	});

	it("expands ~ in a config dir", () => {
		const w = {
			...testProfile().workers,
			mode: "detached" as const,
			accounts: [{ name: "a", configDir: "~/.claude-a" }],
		};
		expect(accountsOf(w)).toEqual([
			{ name: "a", configDir: join(homedir(), ".claude-a") },
		]);
	});

	it("an account without a config dir runs on the default login", () => {
		const w = {
			...testProfile().workers,
			mode: "detached" as const,
			accounts: [{ name: "work", configDir: "/c/work" }, { name: "personal" }],
		};
		expect(accountsOf(w)).toEqual([
			{ name: "work", configDir: "/c/work" },
			{ name: "personal", defaultLogin: true },
		]);
	});

	it("an account that is not logged in is benched until cleared, whatever the clock says", () => {
		const h = home();
		const o = { home: h, now: T0 };
		markNotLoggedIn("home", "configDir /c/home: Not logged in", o);
		markLimited("home", T0 + HOUR, "limit", o);
		const later = { home: h, now: T0 + 1000 * HOUR };
		expect(accountStatus(two, later)[1]).toMatchObject({
			notLoggedIn: true,
			reason: "configDir /c/home: Not logged in",
		});
		expect(pickAccount(two, later).name).toBe("work");
		expect(pickAccount(two, later).name).toBe("work");
		markLimited("work", T0 + 2000 * HOUR, "limit", later);
		expect(() => pickAccount(two, later)).toThrow(/home not logged in/);
		expect(clearLimits(["home"], later)).toEqual(["home"]);
		expect(pickAccount(two, later).name).toBe("home");
	});

	it("with no account logged in, says to log one in", () => {
		const h = home();
		markNotLoggedIn("work", "x", { home: h });
		markNotLoggedIn("home", "x", { home: h });
		expect(allLimited(two, { home: h })).toBe(
			"no account is logged in (work, home). Log one in, then run portia accounts clear <name>",
		);
	});

	it("rotates, skipping an account at its usage limit until it resets", () => {
		const h = home();
		const o = { home: h, now: T0 };
		expect(pickAccount(two, o).name).toBe("work");
		expect(pickAccount(two, o).name).toBe("home");
		expect(pickAccount(two, o).name).toBe("work");
		markLimited("home", T0 + HOUR, "limit reached", o);
		expect(pickAccount(two, o).name).toBe("work");
		expect(pickAccount(two, o).name).toBe("work");
		expect(pickAccount(two, { home: h, now: T0 + HOUR + 1 }).name).toBe("home");
	});

	it("refuses when every account is limited, naming the soonest reset; clear lifts one", () => {
		const h = home();
		const o = { home: h, now: T0 };
		markLimited("work", T0 + 2 * HOUR, "limit", o);
		markLimited("home", T0 + HOUR, "limit", o);
		expect(() => pickAccount(two, o)).toThrow(PortiaProblem);
		expect(allLimited(two, o)).toContain(
			`the soonest frees at ${new Date(T0 + HOUR).toISOString()}`,
		);
		expect(clearLimits(["home"], o)).toEqual(["home"]);
		expect(allLimited(two, o)).toBeUndefined();
		expect(pickAccount(two, o).name).toBe("home");
		expect(clearLimits([], o)).toEqual(["work"]);
		expect(accountStatus(two, o).every((a) => !a.limitedUntil)).toBe(true);
	});

	it("a later limit already recorded stands over an earlier one", () => {
		const h = home();
		const o = { home: h, now: T0 };
		markLimited("work", T0 + 2 * HOUR, "weekly", o);
		markLimited("work", T0 + HOUR, "5-hour", o);
		expect(accountStatus(two, o)[0]).toMatchObject({
			limitedUntil: new Date(T0 + 2 * HOUR).toISOString(),
			reason: "weekly",
		});
	});

	it("a torn state file is a problem that names it", () => {
		const h = home();
		writeFileSync(join(h, "accounts.json"), "{");
		expect(() => accountStatus(two, { home: h })).toThrow(/accounts\.json/);
	});

	it("the profile wants unique names and detached workers for accounts", () => {
		const base = { ...testProfile() };
		const parse = (workers: unknown) =>
			ProfileSchema.safeParse({ ...base, workers }).success;
		expect(parse({ mode: "detached", accounts: two })).toBe(true);
		expect(parse({ mode: "subagent", accounts: two })).toBe(false);
		expect(parse({ mode: "detached", accounts: [two[0], two[0]] })).toBe(false);
		expect(
			parse({ mode: "detached", accounts: [{ name: "a b", configDir: "/x" }] }),
		).toBe(false);
		expect(parse({ mode: "detached", accounts: [{ name: "personal" }] })).toBe(
			true,
		);
		expect(
			parse({ mode: "detached", accounts: [{ name: "a", configDir: "" }] }),
		).toBe(false);
	});
});
