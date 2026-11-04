import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RunRow } from "./types";

export const LOG = "runlog.jsonl";

/**
 * Appends one row in a single write and syncs it. A log left ending mid-row by a torn
 * write gets a newline first, so only the torn fragment is skipped, never this row too.
 */
export function appendRow(
	dir: string,
	row: Omit<RunRow, "at"> & { at?: string },
): RunRow {
	const full = { at: new Date().toISOString(), ...row } as RunRow;
	const fd = openSync(join(dir, LOG), "a+");
	try {
		const size = fstatSync(fd).size;
		const last = Buffer.alloc(1);
		const torn =
			size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
		writeFileSync(fd, `${torn ? "\n" : ""}${JSON.stringify(full)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return full;
}

export function readRows(dir: string): { rows: RunRow[]; skipped: number } {
	const path = join(dir, LOG);
	if (!existsSync(path)) return { rows: [], skipped: 0 };
	const rows: RunRow[] = [];
	let skipped = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as RunRow);
		} catch {
			skipped++;
		}
	}
	return { rows, skipped };
}

export function nextAttempt(rows: RunRow[], child: string): number {
	return (
		Math.max(
			0,
			...rows
				.filter((r) => r.child === child && r.stage === "dispatched")
				.map((r) => r.attempt),
		) + 1
	);
}

export interface Failure {
	attempt: number;
	reason: string;
}

/**
 * A child's failed outcomes in log order: failed results and failed lands. Dispatches are
 * not failures, nor are lands CI or GitHub failed (`infra`): those are not the child's, and
 * capRelands bounds them on its own.
 */
export function failures(rows: RunRow[], child: string): Failure[] {
	const out: Failure[] = [];
	for (const r of rows) {
		if (r.child !== child || r.status !== "failed") continue;
		if (r.stage === "result")
			out.push({ attempt: r.attempt, reason: String(r.data?.message ?? "") });
		else if (r.stage === "land" && r.data?.infra !== true)
			out.push({ attempt: r.attempt, reason: String(r.data?.reason ?? "") });
	}
	return out;
}

const REDISPATCHED =
	"Your worktree may already hold partial work from an earlier attempt: check `git status` and `git log` first, and build on it rather than starting over.";

/**
 * The brief section for a retried or redispatched worker: why the last attempt failed
 * (a multi-line reason's output in a code block), or the child review's findings when
 * they parked it since, and, from attempt 2 on, that its worktree may hold earlier work.
 * Empty on a first attempt with no failure.
 */
export function previousAttempt(rows: RunRow[], child: string): string {
	let last: (Failure & { parked?: boolean }) | undefined;
	for (const r of rows) {
		if (r.child !== child) continue;
		const failed = failures([r], child)[0];
		if (failed) last = failed;
		else if (
			r.stage === "land" &&
			r.status === "parked" &&
			r.data?.review === "findings"
		)
			last = {
				attempt: r.attempt,
				reason: String(r.data?.reason ?? ""),
				parked: true,
			};
	}
	const attempt = nextAttempt(rows, child) - 1;
	const parts: string[] = [];
	if (last) {
		const [head = "", ...rest] = last.reason.trim().split("\n");
		const output = rest.join("\n").trim();
		parts.push(
			`Attempt ${last.attempt} ${last.parked ? "was parked" : "failed"}: ${head.replace(/\.+$/, "")}. Fix that first.`,
		);
		if (output) parts.push(`\`\`\`\n${output}\n\`\`\``);
	}
	if (attempt > 1) parts.push(REDISPATCHED);
	return parts.length ? `## Previous attempt\n\n${parts.join("\n\n")}\n` : "";
}
