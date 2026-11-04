import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDryRun } from "../../core/exec";
import { EXIT } from "../../core/exit";
import { mergeDenies } from "../../core/permissions";
import { cliContext } from "../context";
import type { Command } from "../main";

export const permissionsCommand: Command = async (_args, io) => {
	const { profile } = await cliContext();
	const file = join(process.cwd(), ".claude", "settings.local.json");
	const before = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	const after = mergeDenies(before, profile.denyRules);
	if (isDryRun()) {
		io.out(JSON.stringify(after, null, 2));
		return EXIT.OK;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(after, null, 2)}\n`);
	io.out(
		`deny rules in ${file} (they persist in this checkout's .claude/settings.local.json until removed):\n${(after.permissions?.deny ?? []).join("\n")}`,
	);
	return EXIT.OK;
};
