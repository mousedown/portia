import picomatch from "picomatch";

export async function git(cwd: string, args: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	if (code) throw new Error(`git ${args.join(" ")} in ${cwd}: ${err.trim()}`);
	return out.trim();
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
	const p = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "ignore",
		stderr: "ignore",
	});
	return (await p.exited) === 0;
}

/** Files changed between two refs. */
export async function changedFiles(
	cwd: string,
	from: string,
	to: string,
): Promise<string[]> {
	const out = await git(cwd, ["diff", "--name-only", `${from}...${to}`]);
	return out ? out.split("\n") : [];
}

/**
 * Files an arm changed that no child declared. For Portia the run log is the authority;
 * for baselines this is the same question asked of git: did the work stay where the
 * tickets said it would?
 */
export function outsideDeclared(
	files: string[],
	children: { touches: string[] }[],
): string[] {
	const globs = children.flatMap((c) => c.touches);
	if (!globs.length) return [];
	const ok = picomatch(globs, { dot: true });
	return files.filter((f) => !ok(f));
}

/** Commits on `branch` that are not on `main`, oldest first. */
export async function commitsSince(
	cwd: string,
	main: string,
	branch: string,
): Promise<{ sha: string; at: string; subject: string }[]> {
	const out = await git(cwd, [
		"log",
		"--reverse",
		"--format=%H%x1f%cI%x1f%s",
		`${main}..${branch}`,
	]);
	return out
		? out.split("\n").map((l) => {
				const [sha = "", at = "", subject = ""] = l.split("\x1f");
				return { sha, at, subject };
			})
		: [];
}
