import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Verdict } from "./types";

export function pixelVerdict(
	expected: Buffer,
	actual: Buffer,
	t: { pass: number; fail: number },
): { ratio: number; verdict: Verdict; note: string } {
	const a = PNG.sync.read(expected);
	const b = PNG.sync.read(actual);
	if (a.width !== b.width || a.height !== b.height) {
		return {
			ratio: 1,
			verdict: "UNCERTAIN",
			note: `scale or size differs: design ${a.width}x${a.height}, page ${b.width}x${b.height}`,
		};
	}
	const diff = pixelmatch(a.data, b.data, undefined, a.width, a.height, {
		threshold: 0.1,
	});
	const ratio = diff / (a.width * a.height);
	const verdict: Verdict =
		ratio <= t.pass ? "PASS" : ratio > t.fail ? "FAIL" : "UNCERTAIN";
	return {
		ratio,
		verdict,
		note: `${(ratio * 100).toFixed(1)}% of pixels differ`,
	};
}
