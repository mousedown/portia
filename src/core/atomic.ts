import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";

/** A temp name beside `path` that no other call shares and no reader takes for the file. */
export const tempPath = (path: string) =>
	`${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;

/**
 * Replaces `path` with `data` in one step: the data is written and synced under a name of
 * its own, then renamed over the file, so a reader sees the old file or the new one, never
 * a torn one. Each call has its own temp name, so concurrent writers never share one.
 */
export function writeFileAtomic(path: string, data: string): void {
	const tmp = tempPath(path);
	try {
		const fd = openSync(tmp, "w");
		try {
			writeFileSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}
