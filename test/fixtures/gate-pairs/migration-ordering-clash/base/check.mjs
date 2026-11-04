import { readdirSync } from "node:fs";

const files = readdirSync("migrations")
	.filter((n) => n.endsWith(".sql"))
	.sort();
const seen = new Set();
for (const f of files) {
	const n = f.split("_")[0];
	if (seen.has(n)) throw new Error(`migration number ${n} used twice`);
	seen.add(n);
}
