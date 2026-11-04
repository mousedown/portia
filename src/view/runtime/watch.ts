import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { ViewFs } from "../model/fs";
import { LEDGER, LOG } from "../model/run";
import { appendRunlog, type ParsedLog, parseRunlog } from "../model/runlog";
import { PLAN_FILE } from "../model/snapshot";

/** A run's log, read up to its last whole line; growth is read from there on. */
export interface Tail {
	log: ParsedLog;
	offset: number;
}

/** Reads a runlog from scratch, keeping only whole lines. */
export function readTail(fs: ViewFs, path: string): Tail | undefined {
	const text = fs.read(path);
	if (text === undefined) return undefined;
	const end = text.lastIndexOf("\n") + 1;
	const whole = text.slice(0, end);
	return { log: parseRunlog(whole), offset: Buffer.byteLength(whole) };
}

/** Brings a tail up to date: a grown file is read from its offset, a shrunk one again in full. */
export function advance(
	fs: ViewFs,
	path: string,
	prev: Tail | undefined,
): Tail | undefined {
	const st = fs.stat(path);
	if (!st) return undefined;
	if (!prev || st.size < prev.offset) return readTail(fs, path);
	if (st.size === prev.offset) return prev;
	const chunk = fs.readFrom(path, prev.offset);
	if (chunk === undefined) return prev;
	const end = chunk.lastIndexOf("\n") + 1;
	if (!end) return prev;
	const whole = chunk.slice(0, end);
	return {
		log: appendRunlog(prev.log, whole),
		offset: prev.offset + Buffer.byteLength(whole),
	};
}

const SIDECAR = (n: string) =>
	n === LOG ||
	n === LEDGER ||
	n === PLAN_FILE ||
	n === "epic.json" ||
	/^(touches|env|worker|result)-.*\.json$/.test(n) ||
	/^worker-.*\.log$/.test(n);

/**
 * Watches the runs directory. fs.watch is only a hint; a 1 s stat poll of the runs on
 * screen is the truth. Changes are debounced by 50 ms; "*" means the set of runs changed.
 */
export function watchRuns(
	fs: ViewFs,
	home: string,
	visible: () => { keys: string[]; deep: boolean },
	onChange: (keys: Set<string>) => void,
): { close(): void } {
	const runs = join(home, "runs");
	const pending = new Set<string>();
	let debounce: ReturnType<typeof setTimeout> | undefined;
	const hint = (key: string) => {
		pending.add(key);
		debounce ??= setTimeout(() => {
			debounce = undefined;
			const keys = new Set(pending);
			pending.clear();
			onChange(keys);
		}, 50);
	};
	const watchers: FSWatcher[] = [];
	const add = (dir: string, recursive: boolean, map: (f: string) => string) => {
		try {
			const w = watch(dir, { recursive, persistent: false }, (_e, f) =>
				hint(f ? map(String(f)) : "*"),
			);
			w.on("error", () => {});
			watchers.push(w);
			return true;
		} catch {
			return false;
		}
	};
	if (!add(runs, true, (f) => f.split(/[/\\]/)[0] ?? "*")) {
		add(runs, false, () => "*");
		for (const k of fs.list(runs)) add(join(runs, k), false, () => k);
	}
	const seen = new Map<string, string>();
	let names = fs.list(runs).join("\n");
	const poll = setInterval(() => {
		const now = fs.list(runs).join("\n");
		if (now !== names) {
			names = now;
			hint("*");
		}
		const v = visible();
		for (const key of v.keys) {
			const dir = join(runs, key);
			const files = v.deep ? fs.list(dir).filter(SIDECAR) : [LOG];
			const sig = files
				.map(
					(f) =>
						`${f}:${fs.stat(join(dir, f))?.size}:${fs.stat(join(dir, f))?.mtimeMs}`,
				)
				.join("|");
			if (seen.has(key) && seen.get(key) !== sig) hint(key);
			seen.set(key, sig);
		}
	}, 1000);
	poll.unref?.();
	return {
		close() {
			clearInterval(poll);
			if (debounce) clearTimeout(debounce);
			for (const w of watchers) w.close();
		},
	};
}
