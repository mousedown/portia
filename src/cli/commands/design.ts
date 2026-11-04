import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { z } from "zod";
import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { loadCanvas } from "../../design/canvas";
import { designCheck } from "../../design/check";
import { writeFrame } from "../../design/store";
import { readEnv } from "../../env/env";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

const Values = z.array(
	z.object({
		role: z.string(),
		name: z.string(),
		color: z.string(),
		background: z.string(),
		fontFamily: z.string(),
		fontSize: z.number(),
		fontWeight: z.number(),
		lineHeight: z.number(),
		padding: z.array(z.number()),
		radius: z.number(),
		width: z.number(),
		height: z.number(),
	}),
);

const USAGE =
	"usage: portia design load-canvas|ingest|check <KEY> --parent <PARENT> [--html f --frame n --width w | --frame n --png f --values f]";

export const designCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	const parent = flag(args, "--parent")?.toUpperCase();
	if (!key || !parent) throw new PortiaProblem(USAGE);
	const need = (name: string) => {
		const v = flag(args, name);
		if (!v) throw new PortiaProblem(`${name} is required. ${USAGE}`);
		return v;
	};
	const { plan, dir } = await loadForCli(parent);
	if (sub === "load-canvas") {
		const width = Number(need("--width"));
		if (!Number.isFinite(width) || width <= 0)
			throw new PortiaProblem("--width must be a positive number");
		const meta = await loadCanvas(
			need("--html"),
			key,
			need("--frame"),
			width,
			dir,
		);
		io.out(JSON.stringify(meta));
		return EXIT.OK;
	}
	if (sub === "ingest") {
		const png = readFileSync(need("--png"));
		const values = Values.safeParse(
			JSON.parse(readFileSync(need("--values"), "utf8")),
		);
		if (!values.success)
			throw new PortiaProblem(
				`values file is invalid: ${values.error.message}`,
			);
		const { width, height } = PNG.sync.read(png);
		const meta = {
			name: need("--frame"),
			width,
			height,
			source: "figma" as const,
		};
		writeFrame(dir, key, meta, png, values.data);
		io.out(JSON.stringify(meta));
		return EXIT.OK;
	}
	if (sub === "check") {
		const child = plan.children.find((c) => c.key === key);
		if (!child?.design) throw new PortiaProblem(`${key} has no design line`);
		const result = await designCheck(child, {
			exec: realExec,
			profile: (await cliContext()).profile,
			dir,
			env: readEnv(dir, key),
		});
		io.out(result.tail);
		return result.ok ? EXIT.OK : EXIT.PROBLEM;
	}
	throw new PortiaProblem(USAGE);
};
