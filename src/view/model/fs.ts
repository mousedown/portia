import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { pidAlive } from "../../core/process";
import type { ProcId } from "./worker";

/** Everything the view reads, and nothing that writes. */
export interface ViewFs {
	list(dir: string): string[];
	read(path: string): string | undefined;
	stat(
		path: string,
	): { size: number; mtimeMs: number; dir: boolean } | undefined;
	readFrom(path: string, offset: number): string | undefined;
	exists(path: string): boolean;
	/** Whether a pid answers signal 0: it sends nothing, so it writes nothing. */
	alive(pid: number): boolean;
	/**
	 * What is known of a live pid: its start time and terminal. The runtime reads them
	 * with `ps` off the render thread and caches them, so this never blocks; undefined
	 * until the answer is in.
	 */
	identity?(pid: number): ProcId | undefined;
	/**
	 * A pull request's title, from the repository one of the run's worktrees has as origin.
	 * The runtime asks gh off the render thread and caches it; undefined until it is in.
	 */
	prTitle?(run: string, pr: number, worktrees: string[]): string | undefined;
}

export const nodeFs: ViewFs = {
	list(dir) {
		try {
			return readdirSync(dir).sort();
		} catch {
			return [];
		}
	},
	read(path) {
		try {
			return readFileSync(path, { encoding: "utf8", flag: "r" });
		} catch {
			return undefined;
		}
	},
	stat(path) {
		try {
			const s = statSync(path);
			return { size: s.size, mtimeMs: s.mtimeMs, dir: s.isDirectory() };
		} catch {
			return undefined;
		}
	},
	readFrom(path, offset) {
		let fd: number | undefined;
		try {
			fd = openSync(path, "r");
			const size = fstatSync(fd).size;
			if (size <= offset) return "";
			const buf = Buffer.alloc(size - offset);
			const n = readSync(fd, buf, 0, buf.length, offset);
			return buf.subarray(0, n).toString("utf8");
		} catch {
			return undefined;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	},
	exists: (path) => existsSync(path),
	alive: (pid) => pid > 0 && pidAlive(pid),
};

/**
 * Fixed mtimes for a frozen frame: `<home>/mtimes.json` holds `{ "default": <ISO>, "paths":
 * { "<path under home>": <ISO> } }`. `default` applies to files; `paths` to anything. A
 * home without the file reads as it is. It is how a checked-out fixture renders the same
 * ages wherever it was cloned, since git does not keep mtimes. `alive`, a list of pids,
 * stands in for the process table, so a fixture's workers read the same on every host;
 * `procs`, `{ "<pid>": { start, tty } }`, stands in for what `ps` says of them.
 */
export function fixedMtimes(fs: ViewFs, home: string): ViewFs {
	const text = fs.read(`${home}/mtimes.json`);
	if (text === undefined) return fs;
	let spec: {
		default?: string;
		paths?: Record<string, string>;
		alive?: number[];
		procs?: Record<string, ProcId>;
	};
	try {
		spec = JSON.parse(text);
	} catch {
		return fs;
	}
	const fallback = spec.default ? Date.parse(spec.default) : Number.NaN;
	const paths = new Map(
		Object.entries(spec.paths ?? {}).map(([k, v]) => [
			`${home}/${k}`.replace(/\/+$/, ""),
			Date.parse(v),
		]),
	);
	const alive = Array.isArray(spec.alive) ? new Set(spec.alive) : undefined;
	const procs = spec.procs;
	return {
		...fs,
		alive: alive ? (pid) => alive.has(pid) : fs.alive,
		identity: procs ? (pid) => procs[String(pid)] : fs.identity,
		stat(path) {
			const s = fs.stat(path);
			if (!s) return s;
			const fixed = paths.get(path.replace(/\/+$/, ""));
			if (fixed !== undefined && !Number.isNaN(fixed))
				return { ...s, mtimeMs: fixed };
			if (!s.dir && !Number.isNaN(fallback)) return { ...s, mtimeMs: fallback };
			return s;
		},
	};
}

/**
 * An in-memory filesystem for tests. A key ending in "/" is an empty directory; every
 * other key is a file, and its parents exist.
 */
export function memoryFs(
	files: Record<string, string>,
	mtimes: Record<string, number> = {},
	alive: number[] = [],
): ViewFs {
	const norm = (p: string) => p.replace(/\/+$/, "");
	const dirs = new Set<string>();
	const content = new Map<string, string>();
	for (const [k, v] of Object.entries(files)) {
		const path = norm(k);
		if (k.endsWith("/")) dirs.add(path);
		else content.set(path, v);
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++)
			dirs.add(parts.slice(0, i).join("/"));
	}
	return {
		list(dir) {
			const d = norm(dir);
			const names = new Set<string>();
			for (const p of [...content.keys(), ...dirs])
				if (p.startsWith(`${d}/`)) {
					const name = p.slice(d.length + 1).split("/")[0];
					if (name) names.add(name);
				}
			return [...names].sort();
		},
		read: (p) => content.get(norm(p)),
		stat(p) {
			const path = norm(p);
			const text = content.get(path);
			if (text !== undefined)
				return {
					size: Buffer.byteLength(text),
					mtimeMs: mtimes[path] ?? 0,
					dir: false,
				};
			if (dirs.has(path))
				return { size: 0, mtimeMs: mtimes[path] ?? 0, dir: true };
			return undefined;
		},
		readFrom(p, offset) {
			const text = content.get(norm(p));
			if (text === undefined) return undefined;
			return Buffer.from(text).subarray(offset).toString("utf8");
		},
		exists: (p) => content.has(norm(p)) || dirs.has(norm(p)),
		alive: (pid) => alive.includes(pid),
	};
}
