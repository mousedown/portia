import { join } from "node:path";
import type { RunRow } from "../../core/types";
import { ms } from "./format";
import type { ViewFs } from "./fs";

/** How much of a worker's log the view reads: its tail, never the whole of a long log. */
export const LOG_TAIL = 256 * 1024;
/** A detached worker whose log has not grown for this long reads as stalled (the default `stallMin`). */
export const STALL_MS = 20 * 60_000;

/** What a run directory holds about one child's detached worker, as read. */
export interface WorkerFiles {
	record: string;
	/** The worker's log: its lines when it was read, and always its size and mtime. */
	log?: {
		lines: LogLine[];
		size: number;
		mtimeMs: number;
		/** The log was longer than what was read. */
		cut: boolean;
		/** Only stat'ed: no page that shows the log is open, so its lines were not read. */
		unread?: boolean;
	};
	/** Its result file exists. */
	result: boolean;
	/** Its pid answers and is the process the record names; undefined when the record has no pid. */
	alive?: boolean;
}

/**
 * What the view has parsed of each worker log, by path: it reads only the bytes added
 * since, so a log streaming many writes a second costs a stat and its new lines, and a
 * log that has not changed keeps the same lines array, so the Worker page's wrap is reused.
 */
export type LogCache = Map<string, LogEntry>;
export interface LogEntry {
	size: number;
	mtimeMs: number;
	/** The bytes after the last newline: a line still being written. */
	rest: string;
	/** Whole lines, oldest first. */
	whole: LogLine[];
	/** `whole` and the line being written, which is what the page shows. */
	lines: LogLine[];
	cut: boolean;
}

/** The most lines a cached log keeps; older ones go, as the tail read leaves them out. */
export const LOG_LINES = 20_000;

export type LogKind =
	| "init"
	| "say"
	| "tool"
	| "out"
	| "error"
	| "result"
	| "raw";
export interface LogLine {
	kind: LogKind;
	text: string;
}

export type WorkerStatus = "alive" | "stalled" | "exited" | "finished";

export interface WorkerView {
	kind: "detached" | "subagent";
	attempt: number;
	/** Detached: the worker's own process. */
	pid?: number;
	/** Detached: the Claude login it runs under, when the profile rotates accounts. */
	account?: string;
	startedAt?: string;
	worktree?: string;
	logPath?: string;
	logBytes?: number;
	/** The log was longer than what was read. */
	logCut?: boolean;
	lines: LogLine[];
	status?: WorkerStatus;
	/** Since the log last grew (or the worker started). */
	quietMs?: number;
	/** Subagent: the orchestrator's process, when dispatch recorded it, and its terminal. */
	owner?: { pid: number; started?: string; alive?: boolean; tty?: string };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? v : undefined;

const json = (text: string): Record<string, unknown> | undefined => {
	try {
		const v = JSON.parse(text);
		return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
	} catch {
		return undefined;
	}
};

export const workerFile = (key: string) => `worker-${key}.json`;
export const workerLog = (key: string, attempt: number) =>
	`worker-${key}-${attempt}.log`;
export const resultFile = (key: string, attempt: number) =>
	`result-${key}-${attempt}.json`;

/** A log's lines from its newest `LOG_TAIL` bytes, or from the bytes added since `prev`. */
function readLog(
	fs: ViewFs,
	path: string,
	st: { size: number; mtimeMs: number },
	prev?: LogEntry,
): LogEntry {
	if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev;
	let text: string;
	let whole: LogLine[] = [];
	let cut = false;
	if (prev && st.size > prev.size) {
		text = prev.rest + (fs.readFrom(path, prev.size) ?? "");
		whole = prev.whole;
		cut = prev.cut;
	} else {
		const from = Math.max(0, st.size - LOG_TAIL);
		text = (from ? fs.readFrom(path, from) : fs.read(path)) ?? "";
		// A tail starts mid-line: the partial first line goes.
		if (from) text = text.slice(text.indexOf("\n") + 1);
		cut = from > 0;
	}
	const nl = text.lastIndexOf("\n");
	const rest = text.slice(nl + 1);
	const added = nl < 0 ? [] : parseLog(text.slice(0, nl));
	if (added.length) whole = [...whole, ...added];
	if (whole.length > LOG_LINES) {
		whole = whole.slice(-LOG_LINES);
		cut = true;
	}
	const tail = rest.trim() ? logLines(rest) : [];
	return {
		size: st.size,
		mtimeMs: st.mtimeMs,
		rest,
		whole,
		lines: tail.length ? [...whole, ...tail] : whole,
		cut,
	};
}

/** What identifies a live process: its start time (`ps -o lstart=`) and its terminal. */
export interface ProcId {
	start?: string;
	tty?: string;
}

/**
 * Whether a recorded pid is still the process that was recorded: it answers signal 0
 * and, once its start time is known, started when the record says. A pid reused after a
 * reboot answers too, but started later.
 */
export function sameProcess(
	fs: ViewFs,
	pid: number,
	started?: string,
): boolean {
	if (!fs.alive(pid)) return false;
	const id = started ? fs.identity?.(pid) : undefined;
	return !id?.start || id.start === started;
}

/**
 * Reads `worker-<KEY>.json`, its log and whether its pid is still that worker. The log's
 * lines are read only when `read` holds (a page that shows them is open); otherwise it is
 * only stat'ed. With a cache only the bytes added since the last read are read.
 */
export function readWorkerFiles(
	fs: ViewFs,
	dir: string,
	key: string,
	o: { cache?: LogCache; read?: boolean } = {},
): WorkerFiles | undefined {
	const record = fs.read(join(dir, workerFile(key)));
	if (record === undefined) return undefined;
	const rec = json(record) ?? {};
	const attempt = num(rec.attempt) ?? 0;
	const pid = num(rec.pid);
	// The log sits in the run directory; a record written elsewhere names it.
	const candidates = [join(dir, workerLog(key, attempt)), str(rec.log)].filter(
		Boolean,
	);
	let log: WorkerFiles["log"];
	for (const path of candidates) {
		const st = fs.stat(path);
		if (!st) continue;
		const prev = o.cache?.get(path);
		if (o.read === false) {
			log = {
				lines: prev?.lines ?? [],
				size: st.size,
				mtimeMs: st.mtimeMs,
				cut: prev?.cut ?? false,
				unread: !prev,
			};
		} else {
			const next = readLog(fs, path, st, prev);
			o.cache?.set(path, next);
			log = {
				lines: next.lines,
				size: st.size,
				mtimeMs: st.mtimeMs,
				cut: next.cut,
			};
		}
		break;
	}
	return {
		record,
		log,
		result:
			fs.exists(join(dir, resultFile(key, attempt))) ||
			(!!str(rec.result) && fs.exists(str(rec.result))),
		alive:
			pid === undefined
				? undefined
				: sameProcess(fs, pid, str(rec.proc) || undefined),
	};
}

const firstLine = (s: string) =>
	s
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean) ?? "";

/** The one argument that says what a tool call does. */
function toolArg(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const i = input as Record<string, unknown>;
	for (const k of [
		"command",
		"file_path",
		"path",
		"pattern",
		"url",
		"description",
		"prompt",
	])
		if (typeof i[k] === "string" && i[k]) return firstLine(i[k] as string);
	return "";
}

const resultText = (c: unknown): string =>
	typeof c === "string"
		? c
		: Array.isArray(c)
			? c
					.map((x) =>
						x && typeof x === "object" && typeof x.text === "string"
							? x.text
							: "",
					)
					.join("\n")
			: "";

/**
 * One log line as the lines a person reads. A `stream-json` line becomes what was said,
 * the tool called and the first line it answered; anything else is shown as written.
 */
export function logLines(line: string): LogLine[] {
	const t = line.trimEnd();
	if (!t.trim()) return [];
	const v = t.startsWith("{") ? json(t) : undefined;
	if (!v) return [{ kind: "raw", text: t }];
	const msg = (v.message ?? {}) as { content?: unknown };
	const content = Array.isArray(msg.content) ? msg.content : [];
	switch (v.type) {
		case "system":
			return v.subtype === "init"
				? [
						{
							kind: "init",
							text: ["session started", str(v.model)]
								.filter(Boolean)
								.join(" · "),
						},
					]
				: [];
		case "assistant": {
			const out: LogLine[] = [];
			for (const c of content as Record<string, unknown>[]) {
				if (c?.type === "text")
					for (const l of str(c.text).split("\n"))
						if (l.trim()) out.push({ kind: "say", text: l.trimEnd() });
				if (c?.type === "tool_use")
					out.push({
						kind: "tool",
						text: [str(c.name), toolArg(c.input)].filter(Boolean).join("  "),
					});
			}
			return out;
		}
		case "user":
			return (content as Record<string, unknown>[])
				.filter((c) => c?.type === "tool_result")
				.map((c) => ({
					kind: c.is_error ? ("error" as const) : ("out" as const),
					text: firstLine(resultText(c.content)) || "(no output)",
				}));
		case "result": {
			const head = [
				"result",
				str(v.subtype),
				num(v.duration_ms) !== undefined
					? `${Math.round((num(v.duration_ms) ?? 0) / 1000)}s`
					: "",
			]
				.filter(Boolean)
				.join(" · ");
			const body = firstLine(str(v.result));
			return [{ kind: "result", text: body ? `${head} · ${body}` : head }];
		}
		default:
			return [];
	}
}

/** Every readable line of a log's text, oldest first. */
export const parseLog = (text: string): LogLine[] =>
	text.split("\n").flatMap(logLines);

/**
 * The worker behind a child's newest attempt. A detached worker started for that attempt
 * is read from its record; otherwise the worker was a subagent in the orchestrator's
 * session, whose pid dispatch records when it sizes waves from memory.
 */
export function workerView(
	rows: RunRow[],
	files: WorkerFiles | undefined,
	owners: Record<number, { alive: boolean; tty?: string }>,
	now: number,
): WorkerView | undefined {
	const dispatch = rows.filter((r) => r.stage === "dispatched").at(-1);
	if (!dispatch) return undefined;
	const rec = files ? json(files.record) : undefined;
	const attempt = num(rec?.attempt);
	if (files && rec && attempt === dispatch.attempt) {
		const lines = files.log?.lines ?? [];
		const started = str(rec.startedAt);
		const last = Math.max(ms(started) || 0, files.log?.mtimeMs ?? 0);
		const quietMs = last ? Math.max(0, now - last) : undefined;
		const finished = files.result || lines.some((l) => l.kind === "result");
		const status: WorkerStatus = finished
			? "finished"
			: files.alive === false
				? "exited"
				: (quietMs ?? 0) >= STALL_MS
					? "stalled"
					: "alive";
		return {
			kind: "detached",
			attempt,
			pid: num(rec.pid),
			account: str(rec.account) || undefined,
			startedAt: started || undefined,
			worktree: str(rec.worktree) || undefined,
			logPath: str(rec.log) || undefined,
			logBytes: files.log?.size,
			logCut: files.log?.cut,
			lines,
			status,
			quietMs,
		};
	}
	const pid = num(dispatch.data?.pid);
	return {
		kind: "subagent",
		attempt: dispatch.attempt,
		lines: [],
		owner:
			pid === undefined
				? undefined
				: {
						pid,
						started: str(dispatch.data?.started) || undefined,
						alive: owners[pid]?.alive,
						tty: owners[pid]?.tty,
					},
	};
}
