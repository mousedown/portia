import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/atomic";
import type { Profile } from "../core/config";
import { type Exec, isDryRun } from "../core/exec";
import { waitOf } from "../core/park";
import { readRows } from "../core/runlog";
import { commandWords } from "../core/words";
import { withLock } from "../gate/lock";

/** A child parked on something only the person can answer. */
export interface Park {
	parent: string;
	child: string;
	question: string;
	attempt: number;
}
export type NotifySpec = Profile["notify"];
export interface NotifyCtx {
	exec: Exec;
	notify: NotifySpec;
	platform?: NodeJS.Platform;
	log?: (s: string) => void;
}

/** Each run's reminders already sent, by `<child>@<park time>`. */
export const REMINDERS = "notify.json";
const TIMEOUT_MS = 10_000;
const HEAD_MAX = 200;

/** The profile's setting, or off in a dry run and under `PORTIA_NOTIFY=0`. */
export function notifySpec(profile: Pick<Profile, "notify">): NotifySpec {
	if (isDryRun() || process.env.PORTIA_NOTIFY === "0") return false;
	return profile.notify;
}

const PLACEHOLDER = /\{(parent|child|question|attempt)\}/g;
const fill = (word: string, p: Park) =>
	word.replace(PLACEHOLDER, (_, k: keyof Park) => String(p[k]));
const appleString = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/**
 * The program and arguments that announce a park. A profile's `onPark` is split into words
 * first and each placeholder is filled inside its word, so the question, which is free
 * text, can never become shell syntax: no shell runs it.
 */
export function parkCommand(
	p: Park,
	spec: Exclude<NotifySpec, false>,
	platform: NodeJS.Platform,
	reminder = false,
): [string, string[]] | undefined {
	if (spec.onPark) {
		const [cmd, ...args] = (commandWords(spec.onPark) ?? []).map((w) =>
			fill(w, p),
		);
		return cmd ? [cmd, args] : undefined;
	}
	const line = p.question.trim().split("\n")[0] ?? "";
	const head =
		line.length > HEAD_MAX ? `${line.slice(0, HEAD_MAX - 1)}…` : line;
	const title = `Portia ${p.parent}`;
	const body = `${p.child} ${reminder ? "is still waiting on you" : "is waiting on you"}${head ? `: ${head}` : ""}`;
	if (platform === "darwin")
		return [
			"osascript",
			[
				"-e",
				`display notification ${appleString(body)} with title ${appleString(title)}`,
			],
		];
	if (platform === "linux") return ["notify-send", ["--", title, body]];
	return undefined;
}

/**
 * Announces a park to the person. Best effort: a notifier that is missing or fails is
 * logged, never thrown, so it cannot undo the row that recorded the park.
 */
export async function notifyPark(
	p: Park,
	ctx: NotifyCtx,
	reminder = false,
): Promise<boolean> {
	if (ctx.notify === false) return false;
	const log = ctx.log ?? ((s: string) => console.error(s));
	const c = parkCommand(
		p,
		ctx.notify,
		ctx.platform ?? process.platform,
		reminder,
	);
	if (!c) return false;
	try {
		const r = await ctx.exec(c[0], c[1], {
			timeoutMs: TIMEOUT_MS,
			env: {
				PORTIA_PARENT: p.parent,
				PORTIA_CHILD: p.child,
				PORTIA_QUESTION: p.question,
				PORTIA_ATTEMPT: String(p.attempt),
				PORTIA_REMINDER: reminder ? "1" : "0",
			},
		});
		if (r.code === 0) return true;
		log(
			`${p.child}: the park notification failed (${r.code}): ${r.stderr.trim().slice(-200)}`,
		);
	} catch (e) {
		log(`${p.child}: the park notification failed: ${(e as Error).message}`);
	}
	return false;
}

function readReminders(dir: string): Record<string, string> {
	try {
		const v = JSON.parse(readFileSync(join(dir, REMINDERS), "utf8"));
		return v && typeof v.reminded === "object" ? v.reminded : {};
	} catch {
		return {};
	}
}

/**
 * Announces once more each question that has waited on the person for `remindMin`
 * minutes. The reminder is recorded before it is sent, under a lock, so however many
 * callers check, and whether or not the notifier works, a park is reminded at most once.
 * Returns the children reminded.
 */
export async function remindParks(o: {
	dir: string;
	parent: string;
	ctx: NotifyCtx;
	now?: number;
}): Promise<string[]> {
	const spec = o.ctx.notify;
	if (spec === false) return [];
	const now = o.now ?? Date.now();
	const rows = readRows(o.dir).rows;
	const due = [...new Set(rows.map((r) => r.child))].flatMap((child) => {
		const w = waitOf(rows.filter((r) => r.child === child));
		return w?.kind === "question" &&
			now - Date.parse(w.at) >= spec.remindMin * 60_000
			? [{ child, w }]
			: [];
	});
	if (!due.length) return [];
	return withLock(
		o.dir,
		async () => {
			const sent = readReminders(o.dir);
			const out: string[] = [];
			for (const { child, w } of due) {
				const id = `${child}@${w.at}`;
				if (sent[id]) continue;
				sent[id] = new Date(now).toISOString();
				writeFileAtomic(
					join(o.dir, REMINDERS),
					`${JSON.stringify({ reminded: sent }, null, 2)}\n`,
				);
				await notifyPark(
					{
						parent: o.parent,
						child,
						question: w.text,
						attempt: w.attempt,
					},
					o.ctx,
					true,
				);
				out.push(child);
			}
			return out;
		},
		{ name: "notify.lock", pollMs: 200, timeoutMs: 30_000 },
	);
}

/** `remindParks` for a CLI command: never fails the command it runs inside. */
export async function remindQuietly(
	dir: string,
	parent: string,
	ctx: NotifyCtx,
): Promise<void> {
	await remindParks({ dir, parent, ctx }).catch((e: unknown) =>
		console.error(`reminders not checked: ${(e as Error).message}`),
	);
}
