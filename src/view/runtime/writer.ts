export const SYNC_START = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

/**
 * The bytes that turn `prev` into `next` on screen: only the rows that changed, inside one
 * synchronized update. With no `prev`, every row: a full repaint.
 */
export function diffFrame(prev: string[] | null, next: string[]): string {
	let out = "";
	for (let r = 0; r < next.length; r++)
		if (!prev || prev[r] !== next[r])
			out += `\x1b[${r + 1};1H${next[r]}\x1b[0m\x1b[K`;
	return out ? `${SYNC_START}${out}${SYNC_END}` : "";
}
