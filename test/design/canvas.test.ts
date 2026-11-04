import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { loadCanvas } from "../../src/design/canvas";
import { listFrames } from "../../src/design/store";

it("renders a local canvas at the frame width and reads its values", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-design-"));
	const meta = await loadCanvas(
		join(__dirname, "../fixtures/canvas.html"),
		"ACME-2",
		"cold-start-400",
		400,
		dir,
	);
	expect(meta).toMatchObject({
		name: "cold-start-400",
		width: 400,
		source: "canvas",
	});
	expect(listFrames(dir, "ACME-2")).toHaveLength(1);
	const base = join(dir, "design", "ACME-2", "cold-start-400");
	expect(PNG.sync.read(readFileSync(join(base, "frame.png"))).width).toBe(400);
	const values = JSON.parse(readFileSync(join(base, "values.json"), "utf8"));
	expect(values).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				role: "button",
				name: "Link your child",
				height: 48,
				radius: 12,
			}),
		]),
	);
}, 60_000);
