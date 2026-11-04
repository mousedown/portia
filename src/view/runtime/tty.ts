import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** The only module under src/view that writes, and it writes only to the terminal. */
export const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h";
export const LEAVE = "\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l";

export interface Term {
	enter(): void;
	leave(): void;
	write(s: string): void;
	size(): { cols: number; rows: number };
	readonly active: boolean;
}

export function createTerm(
	stdin: NodeJS.ReadStream = process.stdin,
	stdout: NodeJS.WriteStream = process.stdout,
): Term {
	let active = false;
	return {
		get active() {
			return active;
		},
		enter() {
			if (active) return;
			active = true;
			if (stdin.isTTY) stdin.setRawMode(true);
			stdout.write(`${ENTER}\x1b[2J`);
		},
		leave() {
			if (!active) return;
			active = false;
			stdout.write(`\x1b[0m${LEAVE}`);
			if (stdin.isTTY) stdin.setRawMode(false);
		},
		write: (s) => {
			if (s) stdout.write(s);
		},
		size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
	};
}

/** Copy through the terminal (OSC 52): nothing touches the disk. */
export const osc52 = (text: string) =>
	`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;

/**
 * Asks the terminal for its background (OSC 11) and waits up to `ms` for the reply.
 * Anything else typed meanwhile is handed back, to be read as keys.
 */
export function queryBackground(
	stdin: NodeJS.ReadStream,
	stdout: NodeJS.WriteStream,
	ms = 100,
): Promise<{ reply?: string; queued: string }> {
	return new Promise((resolve) => {
		let buf = "";
		const wasRaw = stdin.isRaw;
		stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		const done = () => {
			clearTimeout(timer);
			stdin.off("data", onData);
			stdin.setRawMode(wasRaw);
			stdin.pause();
			// biome-ignore lint/suspicious/noControlCharactersInRegex: an OSC reply is escapes
			const m = /\x1b\]11;(rgb:[0-9a-f/]+)(\x07|\x1b\\)/i.exec(buf);
			resolve({ reply: m?.[1], queued: m ? buf.replace(m[0], "") : buf });
		};
		const onData = (d: string) => {
			buf += d;
			// biome-ignore lint/suspicious/noControlCharactersInRegex: an OSC reply is escapes
			if (/\x1b\]11;rgb:[0-9a-f/]+(\x07|\x1b\\)/i.test(buf)) done();
		};
		const timer = setTimeout(done, ms);
		stdin.on("data", onData);
		stdin.resume();
		stdout.write("\x1b]11;?\x1b\\");
	});
}

/** `git@host:o/r(.git)` and `https://host/o/r(.git)` both become `https://host/o/r`. */
export function normaliseRemote(url: string): string | undefined {
	const u = url.trim();
	const ssh = /^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)[:/](.+?)(?:\.git)?\/?$/.exec(u);
	if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
	const http = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(u);
	return http ? `https://${http[1]}/${http[2]}` : undefined;
}

/** `git -C <worktree> remote get-url origin`, normalised. */
export function remoteOf(worktree: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (!existsSync(worktree)) return resolve(undefined);
		const p = spawn("git", ["-C", worktree, "remote", "get-url", "origin"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		p.stdout.on("data", (d) => {
			out += d;
		});
		p.on("error", () => resolve(undefined));
		p.on("close", (code) =>
			resolve(code === 0 ? normaliseRemote(out) : undefined),
		);
	});
}

/** The main checkout a path belongs to, also when the path is a linked worktree. */
export function repoRootOf(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const r = spawnSync(
		"git",
		["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	const common = r.status === 0 ? r.stdout.trim() : "";
	return common.endsWith("/.git") ? dirname(common) : undefined;
}

/**
 * `claude "<prompt>"` in a new tmux window named after the key, started in `cwd`, so the
 * run has a session of its own to ask its questions in. False outside tmux, or when tmux
 * would not start it.
 */
export function launchInTmux(
	env: Record<string, string | undefined>,
	o: { cwd: string; name: string; prompt: string },
): boolean {
	if (!env.TMUX) return false;
	const r = spawnSync(
		"tmux",
		["new-window", "-n", o.name, "-c", o.cwd, "claude", o.prompt],
		{ stdio: "ignore" },
	);
	return r.status === 0;
}

/**
 * The same in a new Ghostty window, on a Mac the view is open on in Ghostty. Never over
 * SSH, where the window would open on a screen nobody is looking at.
 */
export function launchInGhostty(
	env: Record<string, string | undefined>,
	o: { cwd: string; prompt: string },
): boolean {
	if (process.platform !== "darwin" || env.SSH_CONNECTION) return false;
	if (env.TERM_PROGRAM !== "ghostty" && env.TERM !== "xterm-ghostty")
		return false;
	const r = spawnSync(
		"open",
		[
			"-na",
			"Ghostty.app",
			"--args",
			`--working-directory=${o.cwd}`,
			"-e",
			"claude",
			o.prompt,
		],
		{ stdio: "ignore" },
	);
	return r.status === 0;
}

export function openUrl(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : "xdg-open";
	try {
		const p = spawn(cmd, [url], { detached: true, stdio: "ignore" });
		p.on("error", () => {});
		p.unref();
	} catch {}
}

/** Runs $PAGER (default `less -R`) on a file or on text, with the terminal handed over. */
export function page(o: { path?: string; text?: string }): void {
	const pager = process.env.PAGER || "less -R";
	const [cmd = "less", ...args] = pager.split(/\s+/).filter(Boolean);
	if (o.path) spawnSync(cmd, [...args, o.path], { stdio: "inherit" });
	else
		spawnSync(cmd, args, {
			input: o.text ?? "",
			stdio: ["pipe", "inherit", "inherit"],
		});
}

/**
 * Runs `$VISUAL` or `$EDITOR` on a worktree, with the terminal handed over. The path is
 * absolute, so it starts with `/` and no editor reads it as an option. Returns false when
 * the editor could not be started.
 */
export function edit(editor: string, path: string): boolean {
	const [cmd = "", ...args] = editor.split(/\s+/).filter(Boolean);
	if (!cmd) return false;
	const r = spawnSync(cmd, [...args, resolve(path)], { stdio: "inherit" });
	return !r.error;
}
