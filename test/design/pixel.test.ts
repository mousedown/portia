import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { pixelVerdict } from "../../src/design/pixel";

const png = (w: number, h: number, paintedShare = 0) => {
	const p = new PNG({ width: w, height: h });
	for (let i = 0; i < w * h; i++) {
		const black = i < w * h * paintedShare;
		p.data.set(black ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
	}
	return PNG.sync.write(p);
};
const t = { pass: 0.02, fail: 0.1 };

it("grades by the share of differing pixels", () => {
	expect(pixelVerdict(png(100, 100), png(100, 100), t)).toMatchObject({
		ratio: 0,
		verdict: "PASS",
	});
	expect(pixelVerdict(png(100, 100), png(100, 100, 0.05), t).verdict).toBe(
		"UNCERTAIN",
	);
	expect(pixelVerdict(png(100, 100), png(100, 100, 0.5), t).verdict).toBe(
		"FAIL",
	);
});
it("treats a size mismatch as a scale problem, UNCERTAIN", () => {
	expect(pixelVerdict(png(100, 100), png(200, 200), t)).toMatchObject({
		verdict: "UNCERTAIN",
		note: expect.stringContaining("scale"),
	});
});
