import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "./atomic";
import { PortiaProblem } from "./exit";

/**
 * Files outside a child's touches allowed for that child alone: by the person, or by drive
 * when every child owning the file has already landed.
 */
export interface TouchApproval {
	glob: string;
	at: string;
	by: "person" | "drive";
	why?: string;
}

const file = (dir: string, key: string) => join(dir, `touches-${key}.json`);

export function readApprovals(dir: string, key: string): TouchApproval[] {
	const f = file(dir, key);
	return existsSync(f)
		? (JSON.parse(readFileSync(f, "utf8")) as TouchApproval[])
		: [];
}

export const approvedGlobs = (dir: string, key: string): string[] =>
	readApprovals(dir, key).map((a) => a.glob);

/** Records the globs (repo-relative) for this child; a glob already approved is kept once. */
export function approveTouches(
	dir: string,
	key: string,
	globs: string[],
	why?: string,
	by: TouchApproval["by"] = "person",
): TouchApproval[] {
	if (!globs.length) throw new PortiaProblem("name at least one glob to allow");
	for (const g of globs)
		if (isAbsolute(g) || g.split("/").includes(".."))
			throw new PortiaProblem(
				`'${g}' must be a glob relative to the repo root, without '..'`,
			);
	const current = readApprovals(dir, key);
	const at = new Date().toISOString();
	const added = [...new Set(globs)]
		.filter((g) => !current.some((a) => a.glob === g))
		.map(
			(glob): TouchApproval => ({
				glob,
				at,
				by,
				...(why ? { why } : {}),
			}),
		);
	const all = [...current, ...added];
	writeFileAtomic(file(dir, key), `${JSON.stringify(all, null, "\t")}\n`);
	return all;
}
