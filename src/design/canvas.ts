import { pathToFileURL } from "node:url";
import { EXTRACT } from "./extract";
import { writeFrame } from "./store";
import type { ElementValues, FrameMeta } from "./types";

export async function loadCanvas(
	htmlPath: string,
	key: string,
	name: string,
	width: number,
	dir: string,
): Promise<FrameMeta> {
	// Loaded here, not at the top: importing playwright costs most of the CLI's start-up,
	// and every command that is not `portia design` would pay it.
	const { chromium } = await import("playwright");
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({
			viewport: { width, height: 900 },
			deviceScaleFactor: 1,
		});
		await page.goto(pathToFileURL(htmlPath).href);
		await page.evaluate(() => document.fonts.ready);
		const height = Math.min(
			4000,
			await page.evaluate(() => document.documentElement.scrollHeight),
		);
		await page.setViewportSize({ width, height });
		const values = (await page.evaluate(`(${EXTRACT})()`)) as ElementValues[];
		const png = await page.screenshot({
			clip: { x: 0, y: 0, width, height },
		});
		const meta: FrameMeta = { name, width, height, source: "canvas" };
		writeFrame(dir, key, meta, png, values);
		return meta;
	} finally {
		await browser.close();
	}
}
