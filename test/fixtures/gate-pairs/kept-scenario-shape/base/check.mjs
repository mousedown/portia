import { existsSync, readdirSync } from "node:fs";

// Runs the spec files named, or every one; a spec registers its scenarios with test().
const failed = [];
const runs = [];
globalThis.test = (title, fn) =>
	runs.push(
		Promise.resolve()
			.then(fn)
			.catch((e) => failed.push(`${title}: ${e.message}`)),
	);
const named = process.argv.slice(2);
const all = existsSync("specs")
	? readdirSync("specs")
			.filter((n) => n.endsWith(".spec.mjs"))
			.sort()
			.map((n) => `specs/${n}`)
	: [];
for (const f of named.length ? named : all) await import(`./${f}`);
await Promise.all(runs);
if (failed.length) {
	console.error(failed.join("\n"));
	process.exit(1);
}
