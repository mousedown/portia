import { type Exec, realExec } from "../core/exec";

export interface Landing {
	sha: string;
	parent: string;
}

/** The questions verify puts to the repository's history. */
export interface History {
	/** The integration branch's ref, or undefined when neither it nor its remote copy exists. */
	branch: string | undefined;
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	/** A file as committed at `sha`, or undefined when it is not there. */
	show(sha: string, path: string): Promise<string | undefined>;
	/**
	 * The first-parent commit that landed a child on the branch: the squash merge of PR `pr`,
	 * or, given a child's key, the commit a direct landing (`directLand`) pushed for it.
	 */
	landing(pr: number | string): Promise<Landing | undefined>;
}

export async function gitHistory(
	branchName: string,
	cwd: string,
	exec: Exec = realExec,
): Promise<History> {
	const git = (...args: string[]) => exec("git", args, { cwd });
	let branch: string | undefined;
	for (const ref of [branchName, `origin/${branchName}`])
		if (
			(await git("rev-parse", "--verify", "-q", `${ref}^{commit}`)).code === 0
		) {
			branch = ref;
			break;
		}
	let landings: (Landing & { subject: string })[] | undefined;
	return {
		branch,
		async isAncestor(ancestor, descendant) {
			return (
				(await git("merge-base", "--is-ancestor", ancestor, descendant))
					.code === 0
			);
		},
		async show(sha, path) {
			const r = await git("show", `${sha}:${path}`);
			return r.code === 0 ? r.stdout : undefined;
		},
		async landing(pr) {
			if (!branch) return undefined;
			if (!landings) {
				const r = await git(
					"log",
					"--first-parent",
					"--format=%H%x09%P%x09%s",
					branch,
				);
				landings = r.stdout
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const [sha = "", parents = "", ...subject] = line.split("\t");
						return {
							sha,
							parent: parents.split(" ")[0] ?? "",
							subject: subject.join("\t"),
						};
					});
			}
			return landings.find((l) =>
				typeof pr === "string"
					? l.subject.endsWith(`[${pr}]`)
					: l.subject.endsWith(`(#${pr})`),
			);
		},
	};
}
