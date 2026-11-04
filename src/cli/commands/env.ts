import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { runDir } from "../../core/rundir";
import { envDown, envTemplate, envUp } from "../../env/env";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";

export const flag = (args: string[], name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

export const envCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	const { profile } = await cliContext();
	const ctx = (parent: string) => ({
		exec: realExec,
		profile,
		repoRoot: process.cwd(),
		dir: runDir(parent),
	});
	if (sub === "template" && key) {
		await envTemplate(key, ctx(key));
		return EXIT.OK;
	}
	const parent = flag(args, "--parent")?.toUpperCase();
	if (!key || !parent || (sub !== "up" && sub !== "down"))
		throw new PortiaProblem(
			"usage: portia env up|down <KEY> --parent <PARENT> | portia env template <PARENT>",
		);
	if (sub === "down") {
		await envDown(key, parent, ctx(parent));
		return EXIT.OK;
	}
	const c = (await loadForCli(parent)).plan.children.find((x) => x.key === key);
	if (!c) throw new PortiaProblem(`${key} is not a child of ${parent}`);
	io.out(JSON.stringify(await envUp(c, parent, ctx(parent))));
	return EXIT.OK;
};
