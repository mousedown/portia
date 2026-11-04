import { readdirSync } from "node:fs";

const ids = new Map();
for (const f of readdirSync("plugins")
	.filter((n) => n.endsWith(".json"))
	.sort()) {
	const { id } = JSON.parse(await Bun.file(`plugins/${f}`).text());
	if (ids.has(id))
		throw new Error(`duplicate plugin id ${id}: ${ids.get(id)} and ${f}`);
	ids.set(id, f);
}
