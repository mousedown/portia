import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Which Portia and which Claude Code a run used. `portia version` prints a constant, so
 * the checkout's commit is the identity: PORTIA_CHECKOUT, else the directory the `portia`
 * binary is linked from. A result without a sha cannot be compared across versions.
 */
export interface PortiaVersion {
	checkout?: string;
	sha?: string;
	describe?: string;
	dirty?: boolean;
}

export async function portiaVersion(): Promise<PortiaVersion> {
	const checkout =
		process.env.PORTIA_CHECKOUT ?? (await checkoutOfBinary("portia"));
	if (!checkout) return {};
	const sha = await out(["git", "-C", checkout, "rev-parse", "HEAD"]);
	if (!sha) return { checkout };
	const describe = await out([
		"git",
		"-C",
		checkout,
		"describe",
		"--always",
		"--dirty",
		"--tags",
	]);
	return {
		checkout,
		sha,
		describe,
		dirty: describe?.endsWith("-dirty") ?? false,
	};
}

export async function claudeVersion(): Promise<string | undefined> {
	return out(["claude", "--version"]);
}

/** The git checkout a linked binary lives in, walking up from its real path. */
async function checkoutOfBinary(name: string): Promise<string | undefined> {
	const which = await out(["sh", "-c", `command -v ${name}`]);
	if (!which) return undefined;
	let dir: string;
	try {
		dir = dirname(realpathSync(which));
	} catch {
		return undefined;
	}
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return undefined;
}

async function out(cmd: string[]): Promise<string | undefined> {
	try {
		const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
		const [text, code] = await Promise.all([
			new Response(p.stdout).text(),
			p.exited,
		]);
		return code === 0 && text.trim() ? text.trim() : undefined;
	} catch {
		return undefined;
	}
}
