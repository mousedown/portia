import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertRunOwner, markRunOwner, type RunOwner } from "./run-repo";

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

let owner: RunOwner | undefined;

/** The repository this process works for: `runDir` refuses another's run from here on. */
export function setRunOwner(next: RunOwner | undefined): void {
	owner = next;
}

/** Refuses `parent`'s run if another repository owns it, for a command that only reads it. */
export function checkRunOwner(
	parent: string,
	env: Record<string, string | undefined> = process.env,
): void {
	if (owner) assertRunOwner(parent, runPath(parent, env), owner);
}

export function runDir(
	parent: string,
	env: Record<string, string | undefined> = process.env,
): string {
	const dir = runPath(parent, env);
	const repo = owner ? assertRunOwner(parent, dir, owner) : undefined;
	mkdirSync(dir, { recursive: true });
	if (owner) markRunOwner(dir, repo ?? owner.repo);
	return dir;
}
