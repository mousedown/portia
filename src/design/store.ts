import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ElementValues, FrameMeta } from "./types";

export const designDir = (dir: string, key: string) => join(dir, "design", key);

export function writeFrame(
	dir: string,
	key: string,
	meta: FrameMeta,
	png: Buffer,
	values: ElementValues[],
): void {
	const d = join(designDir(dir, key), meta.name);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, "frame.png"), png);
	writeFileSync(join(d, "values.json"), JSON.stringify(values));
	writeFileSync(join(d, "meta.json"), JSON.stringify(meta));
}

export function listFrames(dir: string, key: string): FrameMeta[] {
	const d = designDir(dir, key);
	if (!existsSync(d)) return [];
	return readdirSync(d)
		.filter((n) => existsSync(join(d, n, "meta.json")))
		.map(
			(n) =>
				JSON.parse(readFileSync(join(d, n, "meta.json"), "utf8")) as FrameMeta,
		);
}
