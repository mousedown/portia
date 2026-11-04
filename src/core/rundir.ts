import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function portiaHome(
	env: Record<string, string | undefined> = process.env,
): string {
	return env.PORTIA_HOME ?? join(homedir(), ".portia");
}

/** Where `parent`'s run lives, without creating it: for read-only commands. */
export function runPath(
	parent: string,
	env: Record<string, string | undefined> = process.env,
): string {
	return join(portiaHome(env), "runs", parent.toUpperCase());
}

export function runDir(
	parent: string,
	env: Record<string, string | undefined> = process.env,
): string {
	const dir = runPath(parent, env);
	mkdirSync(dir, { recursive: true });
	return dir;
}
