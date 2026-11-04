import { type Ctx, hints, indent, pageHeader, rule } from "../common";
import { compose } from "../frame";
import { machineBody, machineNote } from "../machine";
import { footer } from "../overlays";
import { type Line, sp } from "../text";
import { censusCompact } from "./home";

const MACHINE_HINTS = ["↑↓ scroll", "a activity", "← home", "? help", "q quit"];

/** The machine the view runs on, in full: the page beside Home. */
export function machineScreen(ctx: Ctx): Line[] {
	const m = ctx.models.machine;
	const note: Line = m
		? [sp(indent(ctx)), ...machineNote(m, ctx.W - indent(ctx), ctx.ink.unicode)]
		: [];
	return compose(ctx, {
		top: [
			...pageHeader(
				ctx,
				[[{ text: "machine", role: "ink" }]],
				censusCompact(ctx, Math.floor(ctx.W / 2)),
			),
			rule(ctx),
			note,
			[],
		],
		body: machineBody(ctx),
		scrollKey: "machine",
		footer: footer(ctx, hints(ctx, MACHINE_HINTS)),
	});
}
