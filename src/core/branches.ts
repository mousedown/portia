/**
 * Every branch Portia creates or reads derives from the profile's `branchPrefix`, so the
 * tool's name never reaches the remote. This is the only place that builds one.
 */
type Prefixed = { branchPrefix: string };

export const integrationBranch = (p: Prefixed, parent: string) =>
	`${p.branchPrefix}/${parent}`;
export const childBranch = (p: Prefixed, key: string) =>
	`${p.branchPrefix}/${key}`;
/** The child key a branch was made for, or undefined when the branch is not Portia's. */
export const childKeyOf = (p: Prefixed, branch: string): string | undefined =>
	branch.startsWith(`${p.branchPrefix}/`)
		? branch.slice(p.branchPrefix.length + 1)
		: undefined;
