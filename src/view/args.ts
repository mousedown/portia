import { PortiaProblem } from "../core/exit";
import type { HomeView } from "./model/types";
import type { Depth } from "./render/ink";
import { initialState, type ViewState } from "./runtime/state";
import { currentList } from "./select";

export interface ViewArgs {
	run?: string;
	child?: string;
	mode: "tui" | "plain" | "json" | "frame";
	/** A page beside the stack's own: activity or machine (no RUN), gates (a RUN), worker (a CHILD). */
	page?: Page;
	select?: string;
	overlay?: string;
	width?: number;
	height?: number;
	now?: number;
	depth?: Depth;
	theme?: "dark" | "light";
	ascii?: boolean;
	noMotion?: boolean;
}

export const PAGES = ["activity", "machine", "gates", "worker"] as const;
export type Page = (typeof PAGES)[number];

const USAGE =
	"usage: portia view [RUN [CHILD] | RUN/CHILD] [--plain | --json | --frame] [--page NAME] [--select KEY]\n" +
	"                   [--overlay help|filter:<text>|command:<text>] [--width N] [--height N] [--now ISO]\n" +
	"                   [--depth 0|16|256|24] [--theme dark|light] [--ascii] [--no-motion]";

export function parseViewArgs(args: string[], isTTY: boolean): ViewArgs {
	const out: ViewArgs = { mode: isTTY ? "tui" : "plain" };
	const pos: string[] = [];
	const value = (i: number, flag: string) => {
		const v = args[i + 1];
		if (v === undefined || v.startsWith("--"))
			throw new PortiaProblem(`${flag} needs a value\n${USAGE}`);
		return v;
	};
	const int = (v: string, flag: string) => {
		const n = Number(v);
		if (!Number.isInteger(n) || n <= 0)
			throw new PortiaProblem(`${flag} must be a positive whole number`);
		return n;
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i] ?? "";
		switch (a) {
			case "--plain":
				out.mode = "plain";
				break;
			case "--json":
				out.mode = "json";
				break;
			case "--frame":
				out.mode = "frame";
				break;
			case "--ascii":
				out.ascii = true;
				break;
			case "--no-motion":
				out.noMotion = true;
				break;
			case "--page": {
				const t = value(i++, a);
				if (!(PAGES as readonly string[]).includes(t))
					throw new PortiaProblem(`--page is one of ${PAGES.join(", ")}`);
				out.page = t as Page;
				break;
			}
			case "--select":
				out.select = value(i++, a).toUpperCase();
				break;
			case "--overlay":
				out.overlay = value(i++, a);
				if (!/^(help|filter:.*|command:.*)$/.test(out.overlay))
					throw new PortiaProblem(
						"--overlay is help, filter:<text> or command:<text>",
					);
				break;
			case "--width":
				out.width = int(value(i++, a), a);
				break;
			case "--height":
				out.height = int(value(i++, a), a);
				break;
			case "--now": {
				const v = value(i++, a);
				const t = Date.parse(v);
				if (Number.isNaN(t))
					throw new PortiaProblem(`--now is not a date: ${v}`);
				out.now = t;
				break;
			}
			case "--depth": {
				const d = Number(value(i++, a));
				if (![0, 16, 256, 24].includes(d))
					throw new PortiaProblem("--depth is 0, 16, 256 or 24");
				out.depth = d as Depth;
				break;
			}
			case "--theme": {
				const t = value(i++, a);
				if (t !== "dark" && t !== "light")
					throw new PortiaProblem("--theme is dark or light");
				out.theme = t;
				break;
			}
			default:
				if (a.startsWith("--"))
					throw new PortiaProblem(`unknown flag ${a}\n${USAGE}`);
				pos.push(a);
		}
	}
	const [first, second, ...extra] = pos;
	if (extra.length) throw new PortiaProblem(USAGE);
	if (first?.includes("/")) {
		const [run, child] = first.split("/");
		out.run = run?.toUpperCase();
		out.child = child?.toUpperCase() || undefined;
	} else {
		out.run = first?.toUpperCase();
		out.child = second?.toUpperCase();
	}
	return out;
}

/** The state a `--frame` (and the interactive view) starts from. */
export function stateFor(a: ViewArgs, home: HomeView, now: number): ViewState {
	let s = initialState();
	if (a.run)
		s = {
			...s,
			screen: a.child ? "child" : "run",
			runKey: a.run,
			childKey: a.child,
		};
	if (a.page === "activity" || a.page === "machine")
		s = { ...s, screen: a.page };
	else if (a.page === "gates") s = { ...s, matrix: true };
	else if (a.page === "worker" && a.child) s = { ...s, screen: "worker" };
	if (a.overlay === "help") s = { ...s, overlay: "help" };
	else if (a.overlay?.startsWith("filter:"))
		s = { ...s, filter: { text: a.overlay.slice(7), editing: true } };
	else if (a.overlay?.startsWith("command:"))
		s = { ...s, command: { text: a.overlay.slice(8), hist: -1 } };
	if (a.select) {
		const { list, ids } = currentList(s, home, now);
		const want = a.select;
		const id =
			ids.find((x) => x === want) ??
			// Event lists hold event ids: pick the newest row of that child.
			ids.find((x) => {
				const [run, n] = x.split(":");
				const r = home.runs.find((y) => y.key === run);
				return r?.events[Number(n)]?.child === want;
			});
		if (id) s = { ...s, selection: { ...s.selection, [list]: id } };
	}
	return s;
}
