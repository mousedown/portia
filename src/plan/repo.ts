import { type Exec, must } from "../core/exec";

export async function repoFiles(exec: Exec, cwd: string): Promise<string[]> {
	return (await must(exec, "git", ["ls-files"], { cwd }))
		.split("\n")
		.filter(Boolean);
}

export function topLevelOf(files: string[]): string[] {
	return [...new Set(files.map((f) => f.split("/")[0] ?? ""))].filter(Boolean);
}
