import type { ViewState } from "../runtime/state";
import {
	type Ctx,
	findRun,
	type Models,
	makeCtx,
	type Size,
	type Tick,
} from "./common";
import { MIN, tooSmall } from "./frame";
import { type Ink, sgr } from "./ink";
import { withHelp } from "./overlays";
import { activityScreen } from "./screens/activity";
import { childScreen } from "./screens/child";
import { homeScreen } from "./screens/home";
import { machineScreen } from "./screens/machine";
import { runScreen } from "./screens/run";
import { workerScreen } from "./screens/worker";
import { type Line, lineWidth, truncate } from "./text";

export type { Models, Size, Tick };

export interface RenderOut {
	lines: string[];
	/** The frame before painting, for tests and `--frame`. */
	spans: Line[];
	scroll: Record<string, number>;
	/** Something moves: render again in 100 ms. */
	animating: boolean;
	/** A clock shows seconds: render again on the next second. */
	seconds: boolean;
	/** The next moment something on screen expires, like a toast. */
	deadline?: number;
	/** The page shows its last row. */
	atEnd: boolean;
}

/** The ink the frame is painted with: the view's own toggles over what was detected. */
export const effectiveInk = (ink: Ink, s: ViewState): Ink => ({
	...ink,
	motion: ink.motion && s.motion,
	unicode: s.ascii === undefined ? ink.unicode : !s.ascii,
});

/** The page the state is on; a run or child that has gone falls back to Home. */
function page(ctx: Ctx): Line[] {
	const { state } = ctx;
	switch (state.screen) {
		case "activity":
			return activityScreen(ctx);
		case "machine":
			return machineScreen(ctx);
		case "run":
		case "child":
		case "worker": {
			const run = findRun(ctx, state.runKey);
			if (!run) break;
			if (state.screen === "run") return runScreen(ctx, run);
			const child = run.children.find((c) => c.key === state.childKey);
			if (!child) return runScreen(ctx, run);
			return state.screen === "worker"
				? workerScreen(ctx, run, child)
				: childScreen(ctx, run, child);
		}
	}
	return homeScreen(ctx);
}

function screen(ctx: Ctx): Line[] {
	if (ctx.size.cols < MIN.cols || ctx.size.rows < MIN.rows)
		return tooSmall(ctx);
	const lines = page(ctx);
	return ctx.state.overlay === "help" ? withHelp(ctx, lines) : lines;
}

/** One frame: exactly `rows` lines, none wider than `cols − 1` cells. Pure. */
export function render(
	state: ViewState,
	models: Models,
	ink: Ink,
	size: Size,
	tick: Tick,
): RenderOut {
	const ctx = makeCtx(state, models, effectiveInk(ink, state), size, tick);
	const spans = screen(ctx).map((l) =>
		lineWidth(l) > ctx.W ? truncate(l, ctx.W) : l,
	);
	return {
		lines: spans.map((l) => sgr(l, ctx.ink)),
		spans,
		scroll: ctx.scroll,
		animating: ctx.flags.animating,
		seconds: ctx.flags.seconds,
		deadline: (ctx.flags as { deadline?: number }).deadline,
		atEnd: ctx.flags.atEnd ?? true,
	};
}
