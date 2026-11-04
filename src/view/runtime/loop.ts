import { join } from "node:path";
import type { Profile } from "../../core/config";
import { stateFor, type ViewArgs } from "../args";
import { nodeFs, type ViewFs } from "../model/fs";
import { homeOf, runKeys } from "../model/home";
import {
	MachineSampler,
	nodeMachineProbes,
	PROCS_MS,
	runAsync,
	SAMPLE_MS,
} from "../model/machine";
import {
	buildRun,
	gatherRun,
	LOG,
	type LogReads,
	type RunFiles,
} from "../model/run";
import type { ChildView, HomeView, RunView } from "../model/types";
import type { ProcId } from "../model/worker";
import { render } from "../render";
import { tilde } from "../render/common";
import { detectInk, type Ink } from "../render/ink";
import { arrivalAt } from "../render/logo";
import { answerPark } from "./answer";
import { archiveRun } from "./archive";
import { refuseAsk, sentAsk, settleAsk } from "./ask";
import { decode, type Key } from "./keys";
import {
	diskPaths,
	machineAccounts,
	machineSlots,
	resolveViewProfile,
	worktreesOf,
} from "./machine";
import {
	type Effect,
	expire,
	reduce,
	settleTail,
	type ViewState,
} from "./state";
import {
	createTerm,
	edit,
	launchInGhostty,
	launchInTmux,
	openUrl,
	osc52,
	page,
	queryBackground,
	remoteOf,
	repoRootOf,
} from "./tty";
import { advance, type Tail, watchRuns } from "./watch";
import { diffFrame } from "./writer";

export interface Flags {
	animating: boolean;
	seconds: boolean;
	deadline?: number;
	/** The header clock shows HH:MM, so it changes on the minute. */
	minute?: boolean;
}

/** The scheduler's one timer: nothing at all when nothing on screen can change. */
export function nextDelay(f: Flags, now: number): number | undefined {
	const c: number[] = [];
	if (f.animating) c.push(100);
	if (f.seconds) c.push(1000 - (now % 1000) + 5);
	if (f.minute) c.push(60_000 - (now % 60_000) + 5);
	if (f.deadline !== undefined) c.push(Math.max(10, f.deadline - now));
	return c.length ? Math.min(...c) : undefined;
}

/** What each run and child looked like, to know which rows to ink in after a refresh. */
export function signatures(home: HomeView): Map<string, string> {
	const out = new Map<string, string>();
	for (const r of home.runs) {
		out.set(r.key, `${r.glyph}|${r.lastEvent}|${r.events.length}`);
		for (const c of r.children)
			out.set(
				c.key,
				`${c.state}|${c.phase}|${c.attempts.at(-1)?.events.length}`,
			);
	}
	return out;
}

/** Flashes for every run and child whose signature changed, and the events that arrived. */
export function flashesFor(
	prev: Map<string, string>,
	next: Map<string, string>,
	now: number,
	home: HomeView,
	prevCounts: Map<string, number>,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, sig] of next) {
		const was = prev.get(k);
		if (was === undefined || was === sig) continue;
		out[k] = now;
		const [before] = was.split("|");
		const [after] = sig.split("|");
		if (before === "running" && (after === "done" || after === "landed"))
			out[`settle:${k}`] = now;
	}
	for (const r of home.runs) {
		const n = prevCounts.get(r.key);
		if (n !== undefined) for (const e of r.events.slice(n)) out[e.id] = now;
	}
	return out;
}

const MIN_FRAME_MS = 33;

export async function runView(o: {
	args: ViewArgs;
	home: string;
	env: Record<string, string | undefined>;
}): Promise<number> {
	const { stdin, stdout } = process;
	const homePath = o.home;
	const runsDir = join(homePath, "runs");

	let reply: string | undefined;
	let queued = "";
	if (!o.env.PORTIA_THEME && !o.args.theme)
		({ reply, queued } = await queryBackground(stdin, stdout));
	// The live view links keys, PRs and branches (OSC 8), so cmd-click opens them.
	const detect = (): Ink => ({
		...detectInk(o.env, true, reply, {
			depth: o.args.depth,
			theme: o.args.theme,
			ascii: o.args.ascii,
			noMotion: o.args.noMotion,
		}),
		links: true,
	});
	let ink = detect();
	// Each run's repository, for its links: looked up once per run, in the background,
	// by `findRepos` (set once the lookup below exists).
	const repoUrls: Record<string, string> = {};
	let findRepos: (runs: RunView[]) => void = () => {};

	const tails = new Map<string, Tail>();
	const files = new Map<string, RunFiles>();
	// A worker log is read only for the child whose page is open, and only what it added.
	let wanted: { run?: string; child?: string } = o.args.child
		? { run: o.args.run, child: o.args.child }
		: {};
	const logs: LogReads = {
		cache: new Map(),
		want: (run, child) => wanted.run === run && wanted.child === child,
	};
	// What ps says of a recorded pid, asked once and off the render thread.
	const procs = new Map<number, ProcId | null>();
	// An epic PR's title, for a run with no plan snapshot to title it.
	const titles = new Map<string, string | null>();
	const fs: ViewFs = {
		...nodeFs,
		identity(pid) {
			const hit = procs.get(pid);
			if (hit !== undefined) return hit ?? undefined;
			procs.set(pid, null);
			void runAsync("ps", ["-o", "tty=,lstart=", "-p", String(pid)], 2_000)
				.then((r) => {
					const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(r.out ?? "");
					if (!m) return;
					procs.set(pid, {
						tty: m[1] === "??" || m[1] === "?" ? undefined : m[1],
						start: m[2],
					});
					reloadAll();
				})
				.catch(() => {});
			return undefined;
		},
		prTitle(run, pr, worktrees) {
			const id = `${run}#${pr}`;
			const hit = titles.get(id);
			if (hit !== undefined) return hit ?? undefined;
			titles.set(id, null);
			void (async () => {
				let repo: string | undefined;
				for (const w of worktrees) {
					repo = await remoteOf(w);
					if (repo) break;
				}
				// Without a repository, gh would answer from whatever checkout the view runs in.
				if (!repo) return;
				const r = await runAsync(
					"gh",
					[
						"pr",
						"view",
						String(pr),
						"-R",
						repo.replace(/^https:\/\//, ""),
						"--json",
						"title",
						"-q",
						".title",
					],
					10_000,
				);
				const title = r.out?.trim();
				if (!title) return;
				titles.set(id, title);
				reloadAll();
			})().catch(() => {});
			return undefined;
		},
	};
	const load = (key: string) => {
		// A watcher hint names any entry under runs/ (.DS_Store, a lock, a swap file):
		// only a directory runKeys() would list is a run, and one that has gone is dropped.
		if (key.startsWith(".") || !fs.stat(join(runsDir, key))?.dir) {
			files.delete(key);
			tails.delete(key);
			return;
		}
		const t = advance(fs, join(runsDir, key, LOG), tails.get(key));
		if (t) tails.set(key, t);
		else tails.delete(key);
		files.set(key, gatherRun(fs, homePath, key, t?.log, logs));
	};
	const loadAll = () => {
		const keys = runKeys(fs, homePath);
		for (const k of [...files.keys()]) if (!keys.includes(k)) files.delete(k);
		for (const k of keys) load(k);
	};
	loadAll();
	// A pid's identity came in: every run that recorded it reads again.
	let reloadAll = () => {};

	const start = Date.now();
	const startHome = homeOf(
		homePath,
		[...files.values()].map((f) => buildRun(f, start)),
		start,
	);
	const startRun = startHome.runs.find((r) => r.key === o.args.run);
	if (o.args.run && !startRun) {
		process.stderr.write(`no run ${o.args.run} in ${runsDir}\n`);
		return 11;
	}
	if (o.args.child && !startRun?.children.some((c) => c.key === o.args.child)) {
		process.stderr.write(`no child ${o.args.child} in run ${o.args.run}\n`);
		return 11;
	}
	let state: ViewState = stateFor(o.args, startHome, start);
	// Each run's view is cached against the files it was built from. A run with nothing
	// running never changes with the clock; one with a running child has its clocks
	// moved on between full rebuilds, which come with new files or every 30 seconds.
	const views = new Map<
		string,
		{ files: RunFiles; view: RunView; at: number }
	>();
	const viewOf = (f: RunFiles, now: number): RunView => {
		const c = views.get(f.key);
		if (c && c.files === f) {
			const live = c.view.children.some((x) => x.state === "running");
			if (!live) return c.view;
			if (now - c.at < RETIME_MS) return retime(c.view, now - c.at);
		}
		const view = buildRun(f, now);
		views.set(f.key, { files: f, view, at: now });
		return view;
	};
	// Times in the model (elapsed, quiet) move with the clock: rebuild once a second, or on change.
	let model: { home: HomeView; second: number; sort: string } | undefined;
	const homeAt = (now: number, force = false): HomeView => {
		const second = Math.floor(now / 1000);
		if (!force && model && model.second === second && model.sort === state.sort)
			return model.home;
		const runs = [...files.values()].map((f) => viewOf(f, now));
		model = {
			home: homeOf(homePath, runs, now, state.sort),
			second,
			sort: state.sort,
		};
		return model.home;
	};

	// The machine: sampled every 2 s whatever the screen, so the sparklines have a
	// history when the Machine page opens; processes and worktree sizes only while it shows.
	let profile: Profile | undefined;
	const sampler = new MachineSampler(nodeMachineProbes, {
		disks: diskPaths(homePath, undefined, startHome),
	});
	let slotsAt = Number.NEGATIVE_INFINITY;
	const machineVisible = () => state.screen === "machine";
	// Every slower reading is asynchronous and bounded; one that fails leaves its part out.
	const quietly = (p: Promise<boolean>) =>
		void p.then((c) => c && dirty()).catch(() => {});
	const slow = () => {
		if (!machineVisible()) return;
		quietly(sampler.refreshProcs());
		quietly(sampler.refreshWorktrees(worktreesOf(homeAt(Date.now()), fs)));
	};
	const machineTick = () => {
		const now = Date.now();
		// Slots show on Home only, from the rows already loaded and watched.
		if (profile && state.screen === "home" && now - slotsAt >= PROCS_MS) {
			slotsAt = now;
			try {
				sampler.slots = machineSlots(
					profile,
					[...files.values()].map((f) => f.log?.rows ?? []),
				);
			} catch {
				sampler.slots = undefined;
			}
		}
		// One small file every run shares, so it is read on every tick.
		sampler.accounts = profile ? machineAccounts(profile, homePath) : undefined;
		quietly(sampler.refreshDisks());
		quietly(sampler.refreshMemory());
		sampler.sample();
		slow();
		dirty();
	};
	void resolveViewProfile(o.env).then((p) => {
		profile = p;
		sampler.opts = {
			disks: diskPaths(homePath, p, homeAt(Date.now())),
			minFreeMb: p?.minFreeMb,
		};
		slotsAt = Number.NEGATIVE_INFINITY;
		quietly(sampler.refreshDisks(0));
	});
	quietly(sampler.refreshDisks());
	// macOS reads vm_stat off the render thread: sample again once it is in, so the
	// first figure is not os.freemem()'s.
	quietly(
		sampler.refreshMemory().then((c) => {
			if (c) sampler.sample();
			return c;
		}),
	);
	sampler.sample();
	const machineTimer = setInterval(machineTick, SAMPLE_MS);

	const term = createTerm(stdin, stdout);
	let prev: string[] | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let queuedRender = false;
	let lastRender = 0;
	let finished = false;
	let arrivalStart: number | undefined =
		state.screen === "home" &&
		ink.motion &&
		(ink.depth === 24 || ink.depth === 256)
			? start
			: undefined;
	let resolveDone: (code: number) => void = () => {};
	const done = new Promise<number>((r) => {
		resolveDone = r;
	});

	const schedule = (delay: number | undefined) => {
		if (timer) clearTimeout(timer);
		timer = delay === undefined ? undefined : setTimeout(dirty, delay);
	};
	const paint = () => {
		queuedRender = false;
		if (finished || !term.active) return;
		const now = Date.now();
		state = expire(state, now);
		const arrival =
			arrivalStart === undefined ? undefined : arrivalAt(now - arrivalStart);
		if (arrivalStart !== undefined && !arrival) arrivalStart = undefined;
		const home = homeAt(now);
		findRepos(home.runs);
		state = settleAsk(state, home, now);
		const out = render(
			state,
			{
				home,
				machine: sampler.view(),
				repos: repoUrls,
				jira: o.env.JIRA_BASE_URL,
			},
			ink,
			term.size(),
			{ now, arrival },
		);
		state = settleTail({ ...state, scroll: out.scroll }, out.atEnd);
		term.write(diffFrame(prev, out.lines));
		prev = out.lines;
		lastRender = now;
		schedule(arrival ? 35 : nextDelay({ ...out, minute: true }, now));
	};
	function dirty() {
		if (queuedRender) return;
		queuedRender = true;
		const wait = Math.max(0, MIN_FRAME_MS - (Date.now() - lastRender));
		if (wait) setTimeout(paint, wait);
		else queueMicrotask(paint);
	}
	const full = () => {
		prev = null;
		dirty();
	};
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;
	reloadAll = () => {
		if (reloadTimer || finished) return;
		reloadTimer = setTimeout(() => {
			reloadTimer = undefined;
			if (finished) return;
			loadAll();
			homeAt(Date.now(), true);
			dirty();
		}, 50);
	};

	const repos = new Map<string, string | undefined>();
	const treesOf = (run: RunView): string[] => [
		...new Set(
			[
				...run.children.map((c) => c.env?.worktree),
				...run.events
					.filter((e) => e.row.stage === "env")
					.map((e) => e.row.data?.worktree),
			].filter((w): w is string => typeof w === "string" && fs.exists(w)),
		),
	];
	// Where a launched run starts: its own repository, the one the view was opened in,
	// then the newest run's.
	const launchDir = (key?: string): string | undefined => {
		const runs = homeAt(Date.now()).runs;
		const own = runs.find((r) => r.key === key);
		const at = (r: RunView) =>
			r.lastAt ? Date.parse(r.lastAt) : (r.mtimeMs ?? 0);
		const newest = [...runs].sort((a, b) => at(b) - at(a));
		for (const path of [
			...(own ? treesOf(own) : []),
			process.cwd(),
			...newest.flatMap(treesOf),
		]) {
			const root = repoRootOf(path);
			if (root) return root;
		}
		return undefined;
	};
	const repoOf = async (run: RunView): Promise<string | undefined> => {
		if (repos.has(run.key)) return repos.get(run.key);
		const trees = treesOf(run);
		let url: string | undefined;
		for (const w of trees) {
			url = await remoteOf(w);
			if (url) break;
		}
		repos.set(run.key, url);
		return url;
	};
	const asked = new Set<string>();
	findRepos = (runs) => {
		for (const r of runs) {
			if (asked.has(r.key)) continue;
			asked.add(r.key);
			void repoOf(r)
				.then((url) => {
					if (!url) return;
					repoUrls[r.key] = url;
					dirty();
				})
				.catch(() => {});
		}
	};
	const toast = (text: string, role: "ink2" | "dim" | "failed" = "ink2") => {
		state = { ...state, toast: { text, role, until: Date.now() + 3000 } };
		dirty();
	};
	// While a pager has the terminal it owns it: the view's signal handlers stand down
	// (a ^C inside less cancels a search, not the view; ^Z stops us without painting).
	let handingOver = false;
	let deferredExit = false;
	const handover = (fn: () => void) => {
		handingOver = true;
		term.leave();
		try {
			fn();
		} finally {
			handingOver = false;
			if (deferredExit) finish(0);
			else {
				term.enter();
				full();
			}
		}
	};
	const effect = async (e: Effect) => {
		switch (e.kind) {
			case "quit":
				return finish(0);
			case "suspend":
				return onTstp();
			case "copy":
				term.write(osc52(e.text));
				return;
			case "archive": {
				let to: string;
				try {
					to = archiveRun(runsDir, e.run);
				} catch (err) {
					return toast(
						`could not archive ${e.run}: ${(err as Error).message}`,
						"failed",
					);
				}
				files.delete(e.run);
				loadAll();
				homeAt(Date.now(), true);
				toast(`archived ${e.run} · ${tilde(to)}`, "dim");
				return full();
			}
			case "answer": {
				try {
					answerPark(runsDir, e.run, e.child, e.since, e.text);
				} catch (err) {
					// The panel stays on the question with the text, so nothing typed is lost.
					state = refuseAsk(state, homeAt(Date.now()), (err as Error).message);
					return full();
				}
				state = sentAsk(state);
				loadAll();
				homeAt(Date.now(), true);
				toast("saved · its session picks it up, or portia resume", "dim");
				return full();
			}
			case "refresh":
				loadAll();
				homeAt(Date.now(), true);
				state = { ...state, refreshedAt: Date.now() };
				return full();
			case "theme":
				ink =
					state.theme === "auto" ? detect() : { ...ink, theme: state.theme };
				return full();
			case "pager":
				return handover(() =>
					page(e.path ? { path: join(runsDir, e.path) } : { text: e.text }),
				);
			case "editor": {
				const editor = o.env.VISUAL || o.env.EDITOR;
				if (!editor) return toast("set $EDITOR to open the worktree", "dim");
				if (!fs.exists(e.path))
					return toast(`the worktree is no longer on disk: ${e.path}`, "dim");
				let started = true;
				handover(() => {
					started = edit(editor, e.path);
				});
				if (!started)
					toast(
						`could not start ${editor.split(/\s+/)[0] ?? "$EDITOR"}`,
						"failed",
					);
				return;
			}
			case "launch": {
				const dir = launchDir(e.run);
				if (
					dir &&
					launchInTmux(o.env, { cwd: dir, name: e.key, prompt: e.prompt })
				)
					return toast(`started ${e.prompt} in tmux window ${e.key}`, "dim");
				if (dir && launchInGhostty(o.env, { cwd: dir, prompt: e.prompt }))
					return toast(`started ${e.prompt} in a new Ghostty window`, "dim");
				const command = `claude "${e.prompt}"`;
				term.write(osc52(dir ? `cd ${dir} && ${command}` : command));
				return toast(
					dir
						? `no tmux or Ghostty window to open · copied cd ${tilde(dir)} && ${command}`
						: `no repository found · copied ${command}`,
					"dim",
				);
			}
			case "open": {
				const r = homeAt(Date.now()).runs.find((x) => x.key === e.run);
				const repo = r ? await repoOf(r) : undefined;
				if (repo) {
					openUrl(`${repo}/pull/${e.pr}`);
					return toast(`opened ${repo}/pull/${e.pr}`, "dim");
				}
				term.write(osc52(`#${e.pr}`));
				return toast(
					`no worktree left to find the repository · copied #${e.pr}`,
					"dim",
				);
			}
		}
	};

	let rest = "";
	let escTimer: ReturnType<typeof setTimeout> | undefined;
	const feed = (keys: Key[]) => {
		for (const k of keys) {
			if (k.name === "osc") continue;
			arrivalStart = undefined;
			const now = Date.now();
			const r = reduce(state, k, {
				home: homeAt(now),
				now,
				rows: term.size().rows,
			});
			if (r.state.sort !== state.sort) model = undefined;
			if (r.state.motion !== state.motion || r.state.ascii !== state.ascii)
				prev = null;
			const wasVisible = machineVisible();
			state = r.state;
			if (!wasVisible && machineVisible()) slow();
			// Opening a child's page reads its worker log, which until then was only stat'ed.
			const want =
				(state.screen === "child" || state.screen === "worker") &&
				state.childKey
					? { run: state.runKey, child: state.childKey }
					: {};
			if (want.run !== wanted.run || want.child !== wanted.child) {
				wanted = want;
				if (want.run) {
					load(want.run);
					homeAt(now, true);
				}
			}
			for (const e of r.effects) void effect(e);
		}
		dirty();
	};
	const onData = (d: string | Buffer) => {
		if (escTimer) clearTimeout(escTimer);
		const { keys, rest: left } = decode(rest + d.toString());
		rest = left;
		feed(keys);
		if (rest)
			escTimer = setTimeout(() => {
				const lone = rest === "\x1b";
				rest = "";
				if (lone) feed([{ name: "esc" }]);
			}, 25);
	};

	const watcher = watchRuns(
		fs,
		homePath,
		() => ({
			keys:
				state.screen === "home"
					? [...files.keys()]
					: state.runKey
						? [state.runKey]
						: [],
			deep: state.screen !== "home",
		}),
		(keys) => {
			const before = homeAt(Date.now());
			const sigs = signatures(before);
			const counts = new Map(before.runs.map((r) => [r.key, r.events.length]));
			if (keys.has("*")) loadAll();
			else for (const k of keys) load(k);
			const now = Date.now();
			const h = homeAt(now, true);
			state = {
				...state,
				refreshedAt: now,
				flashes: {
					...state.flashes,
					...flashesFor(sigs, signatures(h), now, h, counts),
				},
				scroll:
					state.follow && state.screen === "activity"
						? { ...state.scroll, activity: 0 }
						: state.scroll,
			};
			dirty();
		},
	);

	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	const onResize = () => {
		if (resizeTimer) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(full, 30);
	};
	const onInt = () => {
		if (!handingOver) finish(0);
	};
	const onSignal = () => {
		if (handingOver) deferredExit = true;
		else finish(0);
	};
	const onTstp = () => {
		if (!handingOver) term.leave();
		process.kill(process.pid, "SIGSTOP");
	};
	const onCont = () => {
		if (handingOver) return;
		term.enter();
		full();
	};
	const onCrash = (err: unknown) => {
		term.leave();
		process.stderr.write(
			`portia view: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		);
		process.exit(11);
	};
	const onExit = () => term.leave();

	function finish(code: number) {
		if (finished) return;
		finished = true;
		if (timer) clearTimeout(timer);
		clearInterval(machineTimer);
		if (escTimer) clearTimeout(escTimer);
		if (resizeTimer) clearTimeout(resizeTimer);
		if (reloadTimer) clearTimeout(reloadTimer);
		watcher.close();
		stdin.off("data", onData);
		stdout.off("resize", onResize);
		process.off("SIGINT", onInt);
		for (const s of ["SIGTERM", "SIGHUP"] as const) process.off(s, onSignal);
		process.off("SIGTSTP", onTstp);
		process.off("SIGCONT", onCont);
		process.off("uncaughtException", onCrash);
		process.off("exit", onExit);
		term.leave();
		stdin.pause();
		resolveDone(code);
	}

	process.on("SIGINT", onInt);
	for (const s of ["SIGTERM", "SIGHUP"] as const) process.on(s, onSignal);
	process.on("SIGTSTP", onTstp);
	process.on("SIGCONT", onCont);
	process.on("uncaughtException", onCrash);
	process.on("exit", onExit);
	stdout.on("resize", onResize);
	term.enter();
	stdin.setEncoding("utf8");
	stdin.on("data", onData);
	stdin.resume();
	if (queued) onData(queued);
	full();
	return done;
}

const RETIME_MS = 30_000;

/** A run's clocks moved on by `d` ms, without rebuilding it from its log. */
export function retime(view: RunView, d: number): RunView {
	const moved = new Map<ChildView, ChildView>();
	const children = view.children.map((c) => {
		if (c.state !== "running") return c;
		const n = {
			...c,
			elapsedMs: c.elapsedMs === undefined ? undefined : c.elapsedMs + d,
			quietMs: c.quietMs === undefined ? undefined : c.quietMs + d,
		};
		moved.set(c, n);
		return n;
	});
	return {
		...view,
		children,
		waves: view.waves.map((w) => ({
			...w,
			children: w.children.map((c) => moved.get(c) ?? c),
		})),
	};
}
