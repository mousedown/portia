import { EXTRACT } from "./extract";
import type { FrameMeta } from "./types";

export function generateSpec(o: {
	key: string;
	route: string;
	/** Module path relative to the package's e2e dir, e.g. `accounts/personas`. */
	personaModule: string;
	/** The export in that module: `(page) => Promise<void>` that seeds a fresh user and signs in. */
	personaExport: string;
	outDir: string;
	frames: FrameMeta[];
}): string {
	return `// Generated design check for ${o.key}. Never committed: it is listed in .git/info/exclude.
import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import { ${o.personaExport} as persona } from ${JSON.stringify(`../${o.personaModule}`)};

const FRAMES = ${JSON.stringify(o.frames)};
const OUT = ${JSON.stringify(o.outDir)};

test("design check ${o.key}", async ({ page }) => {
  await persona(page);
  for (const f of FRAMES) {
    await page.setViewportSize({ width: f.width, height: f.height });
    await page.goto(${JSON.stringify(o.route)});
    await page.evaluate(() => document.fonts.ready);
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const values = await page.evaluate(${EXTRACT});
    writeFileSync(\`\${OUT}/actual-\${f.name}.json\`, JSON.stringify({ dpr, values }));
    await page.screenshot({ path: \`\${OUT}/actual-\${f.name}.png\`, clip: { x: 0, y: 0, width: f.width, height: f.height } });
  }
});
`;
}
