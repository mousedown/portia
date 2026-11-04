import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withLockSync } from "../gate/lock";
import { writeFileAtomic } from "./atomic";
import type { Profile } from "./config";
import { PortiaProblem } from "./exit";
import { portiaHome } from "./rundir";

/**
 * A Claude login a detached worker runs under: its `CLAUDE_CONFIG_DIR`; with `defaultLogin`, the
 * default login, with `CLAUDE_CONFIG_DIR` removed; with neither, the CLI's own.
 */
export type Account = { name: string; configDir?: string; defaultLogin?: true };
/** The account the CLI itself runs under, when the profile lists none. */
export const DEFAULT_ACCOUNT = "default";

/**
 * Shared by every run under the Portia home, since two runs may use the same login:
 * where the rotation goes next, and which accounts are at their usage limit until when,
 * or not logged in, which lasts until cleared.
 */
type AccountState = {
	next: number;
	limited: Record<string, { until?: string; reason: string; login?: true }>;
};
type Opts = { home?: string; now?: number };

const expandHome = (p: string) =>
	p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;

/** The profile's accounts, or the one the CLI runs under when it lists none. */
export function accountsOf(workers: Profile["workers"]): Account[] {
	return workers.accounts.length
		? workers.accounts.map((a) =>
				a.configDir
					? { name: a.name, configDir: expandHome(a.configDir) }
					: { name: a.name, defaultLogin: true as const },
			)
		: [{ name: DEFAULT_ACCOUNT }];
}

const stateFile = (home: string) => join(home, "accounts.json");

function readState(home: string): AccountState {
	const file = stateFile(home);
	if (!existsSync(file)) return { next: 0, limited: {} };
	try {
		const s = JSON.parse(readFileSync(file, "utf8")) as Partial<AccountState>;
		return { next: Number(s.next) || 0, limited: s.limited ?? {} };
	} catch {
		throw new PortiaProblem(
			`the account state ${file} is not valid JSON; remove it to clear every usage limit`,
		);
	}
}

/** `fn` over the shared state under a lock; what it returns is written back unless undefined. */
function update<T>(
	home: string,
	fn: (s: AccountState) => { state?: AccountState; value: T },
): T {
	mkdirSync(home, { recursive: true });
	return withLockSync(
		home,
		() => {
			const { state, value } = fn(readState(home));
			if (state) writeFileAtomic(stateFile(home), JSON.stringify(state));
			return value;
		},
		{ name: "accounts.lock" },
	);
}

const until = (s: AccountState, name: string, now: number) => {
	const t = Date.parse(s.limited[name]?.until ?? "");
	return Number.isFinite(t) && t > now ? t : undefined;
};
const benched = (s: AccountState, name: string, now: number) =>
	s.limited[name]?.login === true || until(s, name, now) !== undefined;

export type AccountStatus = Account & {
	limitedUntil?: string;
	/** Not logged in: benched until `portia accounts clear` lifts it. */
	notLoggedIn?: true;
	reason?: string;
};
/** Whether the account can take no worker now. */
export const isBenched = (a: AccountStatus) =>
	a.notLoggedIn === true || a.limitedUntil !== undefined;
/** What benches an account, or "available". */
export const benchText = (a: AccountStatus) =>
	a.notLoggedIn
		? `not logged in: ${a.reason}`
		: a.limitedUntil
			? `limited until ${a.limitedUntil}: ${a.reason}`
			: "available";

/** Each account and, while it lasts, the usage limit it is under or that it is not logged in. */
export function accountStatus(
	accounts: Account[],
	o: Opts = {},
): AccountStatus[] {
	const home = o.home ?? portiaHome();
	const now = o.now ?? Date.now();
	const s = readState(home);
	return accounts.map((a) => {
		const held = s.limited[a.name];
		if (held?.login) return { ...a, notLoggedIn: true, reason: held.reason };
		return until(s, a.name, now) === undefined
			? a
			: { ...a, limitedUntil: held?.until, reason: held?.reason };
	});
}

/** Why no account can take a worker now, naming when each frees; undefined when one can. */
export function allLimited(
	accounts: Account[],
	o: Opts = {},
): string | undefined {
	const status = accountStatus(accounts, o);
	if (!status.every(isBenched)) return undefined;
	if (status.every((a) => a.notLoggedIn))
		return `no account is logged in (${status.map((a) => a.name).join(", ")}). Log one in, then run portia accounts clear <name>`;
	const soonest = status
		.flatMap((a) => (a.limitedUntil ? [a.limitedUntil] : []))
		.sort()
		.at(0);
	return `every account is at its usage limit or not logged in (${status.map((a) => (a.notLoggedIn ? `${a.name} not logged in` : `${a.name} until ${a.limitedUntil}`)).join(", ")}); the soonest frees at ${soonest}. Run portia accounts clear <name> if one has reset sooner or been logged in`;
}

/**
 * The account the next worker runs under: the next in rotation that is not at its usage
 * limit. Refuses, naming when each frees, when every account is.
 */
export function pickAccount(accounts: Account[], o: Opts = {}): Account {
	const home = o.home ?? portiaHome();
	const now = o.now ?? Date.now();
	const picked = update(home, (s) => {
		for (let i = 0; i < accounts.length; i++) {
			const at = (s.next + i) % accounts.length;
			const a = accounts[at];
			if (a && !benched(s, a.name, now))
				return { state: { ...s, next: at + 1 }, value: a };
		}
		return { value: undefined };
	});
	if (picked) return picked;
	throw new PortiaProblem(allLimited(accounts, { home, now }) ?? "no account");
}

/** Benches `name` until `at`; a later limit already recorded, or a missing login, stands. */
export function markLimited(
	name: string,
	at: number,
	reason: string,
	o: Opts = {},
): void {
	update(o.home ?? portiaHome(), (s) => {
		if (s.limited[name]?.login) return { value: undefined };
		const held = Date.parse(s.limited[name]?.until ?? "");
		if (Number.isFinite(held) && held >= at) return { value: undefined };
		return {
			state: {
				...s,
				limited: {
					...s.limited,
					[name]: { until: new Date(at).toISOString(), reason },
				},
			},
			value: undefined,
		};
	});
}

/**
 * Benches `name` until cleared: a login does not come back on a timer, so only
 * `portia accounts clear`, once it is logged in, lifts it.
 */
export function markNotLoggedIn(
	name: string,
	reason: string,
	o: Opts = {},
): void {
	update(o.home ?? portiaHome(), (s) => ({
		state: { ...s, limited: { ...s.limited, [name]: { reason, login: true } } },
		value: undefined,
	}));
}

/** Lifts the bench on `names`, or on every account when none is named. Returns those lifted. */
export function clearLimits(names: string[], o: Opts = {}): string[] {
	return update(o.home ?? portiaHome(), (s) => {
		const lifted = Object.keys(s.limited).filter(
			(n) => !names.length || names.includes(n),
		);
		const limited = Object.fromEntries(
			Object.entries(s.limited).filter(([n]) => !lifted.includes(n)),
		);
		return { state: { ...s, limited }, value: lifted };
	});
}
