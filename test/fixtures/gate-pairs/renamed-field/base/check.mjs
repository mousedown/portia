import { readdirSync } from "node:fs";

for (const f of readdirSync("src")
	.filter((n) => n.endsWith(".mjs"))
	.sort()) {
	const m = await import(`./src/${f}`);
	if (typeof m.selfTest === "function") await m.selfTest();
}
