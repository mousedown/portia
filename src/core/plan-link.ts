/** Where `portia plan link` records the plan's published page, in the run directory. */
export const PLAN_LINK_FILE = "plan-link.json";

const ARTIFACT_URL = /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+$/;

/** Whether `url` is a Claude artifact link. The view prints it, so nothing else gets through. */
export const isPlanUrl = (url: unknown): url is string =>
	typeof url === "string" && ARTIFACT_URL.test(url);

/** The link in a parsed `plan-link.json`, or none when the file holds no valid one. */
export function planUrlOf(link: unknown): string | undefined {
	const url = (link as { url?: unknown } | undefined)?.url;
	return isPlanUrl(url) ? url : undefined;
}
