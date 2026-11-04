import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendRow } from "../../src/core/runlog";
import type { RunRow, Stage } from "../../src/core/types";

const MAIN = join(import.meta.dirname, "../../src/cli/main.ts");

/** Runs the real CLI as a person would: its own process, in `cwd`, with this Portia home. */
export function portia(
	args: string[],
	o: { home: string; cwd?: string; env?: Record<string, string> },
): { code: number; out: string; err: string } {
	const r = spawnSync("bun", [MAIN, ...args], {
		cwd: o.cwd ?? process.cwd(),
		env: { ...process.env, PORTIA_HOME: o.home, NO_COLOR: "1", ...o.env },
		encoding: "utf8",
	});
	return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** A run directory under `home`, and a writer of its run log rows at minutes after a fixed start. */
export function runLog(home: string, key: string) {
	const dir = join(home, "runs", key);
	mkdirSync(dir, { recursive: true });
	const start = Date.parse("2026-10-01T09:00:00.000Z");
	const add = (
		minute: number,
		child: string,
		attempt: number,
		stage: Stage,
		rest: Partial<Pick<RunRow, "status" | "tokens" | "data">> = {},
	) =>
		appendRow(dir, {
			at: new Date(start + minute * 60_000).toISOString(),
			child,
			attempt,
			stage,
			...rest,
		});
	return { dir, add };
}
