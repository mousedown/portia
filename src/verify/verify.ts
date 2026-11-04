import type {
	ChildReceipts,
	Receipt,
	ReceiptCounts,
	ReceiptException,
	ReceiptKind,
	RunReceipts,
} from "../core/receipts";
import type { Run } from "../core/runs";
import type { ChildPlan, RunRow } from "../core/types";
import { ownedScenarios } from "../plan/owned";
import type { History } from "./git";

const ok = (kind: ReceiptKind, detail?: string): Receipt => ({
	kind,
	status: "ok",
	...(detail ? { detail } : {}),
});
const missing = (kind: ReceiptKind, detail: string): Receipt => ({
	kind,
	status: "missing",
	detail,
});

function lastIndex<T>(xs: T[], f: (x: T, i: number) => boolean): number {
	for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i] as T, i)) return i;
	return -1;
}

const lastRow = <T>(xs: T[], f: (x: T) => boolean): T | undefined =>
	xs[lastIndex(xs, f)];

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The last `landed` row of a child: the commit that landed and the tip it was rebased on. */
function landedRow(rows: RunRow[], child: string): number {
	return lastIndex(
		rows,
		(r) => r.child === child && r.stage === "landed" && r.status === "landed",
	);
}

/** Gate rows do not record a commit, so "on the landed commit" is read from row order: an exit pass after the last result, before the landing. */
function gatedCommit(rows: RunRow[], child: string, landed: number): Receipt {
	const result = lastIndex(
		rows,
		(r, i) => i < landed && r.child === child && r.stage === "result",
	);
	const gate = lastIndex(
		rows,
		(r, i) =>
			i < landed &&
			i > result &&
			r.child === child &&
			r.stage === "gate" &&
			r.status === "pass" &&
			r.data?.kind === "exit",
	);
	return gate >= 0
		? ok(
				"gated-commit",
				"exit gate passed after the last result, before landing",
			)
		: missing(
				"gated-commit",
				"no passing exit gate between its last result and its landing",
			);
}

/** What finds a landed row's commit: its PR, or for a direct landing the child's key. */
const landedBy = (row: RunRow): number | string | undefined =>
	Number(row.data?.pr) || (row.data?.direct === true ? row.child : undefined);

async function rebasedOnTip(row: RunRow, history: History): Promise<Receipt> {
	const kind = "rebased-on-tip";
	const sha = str(row.data?.gated) || str(row.data?.sha);
	const onto = str(row.data?.onto);
	if (!history.branch)
		return missing(kind, "the integration branch is not in this repository");
	const by = landedBy(row);
	if (!by || !sha || !onto)
		return missing(kind, "the landed row records no pr, sha or onto");
	const landing = await history.landing(by);
	if (!landing)
		return missing(
			kind,
			`no commit for ${typeof by === "number" ? `#${by}` : by} on ${history.branch}`,
		);
	if (landing.parent !== onto)
		return missing(
			kind,
			`landed on ${landing.parent.slice(0, 9)}, not the recorded tip ${onto.slice(0, 9)}`,
		);
	if (!(await history.isAncestor(onto, sha)))
		return missing(
			kind,
			`${sha.slice(0, 9)} does not contain the tip ${onto.slice(0, 9)}`,
		);
	return ok(kind, `on ${onto.slice(0, 9)}`);
}

async function specsFirst(
	plan: {
		spine?: ChildPlan;
		spineRow?: RunRow;
		result?: RunRow;
		owns?: string[];
	},
	child: string,
	row: RunRow,
	history: History,
): Promise<Receipt> {
	const kind = "specs-first";
	const { spine, spineRow, result, owns = [] } = plan;
	if (!spine || !spineRow) return missing(kind, "no spine landed in this run");
	// A scenario the spine owns it also makes pass, so its evidence shows the pass.
	const unfailed = Object.keys(spine.acceptance).filter((id) => {
		if (owns.includes(id)) return false;
		const evidence = (
			result?.data?.evidence as Record<string, string> | undefined
		)?.[id];
		return !evidence || !/\bfail/i.test(evidence);
	});
	if (unfailed.length)
		return missing(
			kind,
			`the spine shows no failing run for ${unfailed.join(", ")}`,
		);
	if (child === spine.key) return ok(kind, "failed when committed");
	const by = landedBy(spineRow);
	const landing = by ? await history.landing(by) : undefined;
	const onto = str(row.data?.onto);
	if (!landing || !onto)
		return missing(kind, "cannot place the spine's landing before this child");
	return (await history.isAncestor(landing.sha, onto))
		? ok(kind, "the spine landed first and failed when committed")
		: missing(kind, `the spine did not land before ${child}'s base`);
}

async function scenarioTests(
	child: ChildPlan,
	spine: ChildPlan | undefined,
	sha: string,
	history: History,
): Promise<Receipt> {
	const kind = "scenario-tests";
	const ids = [
		...new Set([...child.requirements, ...Object.keys(child.acceptance)]),
	];
	if (!ids.length) return ok(kind, "owns no scenarios");
	const absent: string[] = [];
	for (const id of ids) {
		const file = child.acceptance[id] ?? spine?.acceptance[id];
		const text = file ? await history.show(sha, file) : undefined;
		const titled = new RegExp(
			`\\b(it|test)(\\.\\w+)*\\(\\s*["'\`]${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
		);
		if (!text || !titled.test(text)) absent.push(id);
	}
	return absent.length
		? missing(kind, `no acceptance test titled from ${absent.join(", ")}`)
		: ok(kind, ids.join(", "));
}

function signoff(
	rows: RunRow[],
	spine: ChildPlan | undefined,
	sha: string,
): Receipt {
	const kind = "signoff";
	if (!rows.some((r) => r.stage === "approval" || r.stage === "signoff"))
		return {
			kind,
			status: "not-recorded",
			detail: "this run predates sign-off rows",
		};
	const last = lastRow(
		rows,
		(r) =>
			r.stage === "signoff" &&
			!r.data?.amends &&
			(!spine || r.child === spine.key),
	);
	if (!last) return missing(kind, "the specs were never put to a person");
	if (last.status !== "approved")
		return missing(kind, "the specs were rejected");
	if (last.data?.by !== "person")
		return missing(
			kind,
			`signed off by ${str(last.data?.by) || "no one"}, not a person`,
		);
	if (sha && str(last.data?.commit) !== sha)
		return missing(
			kind,
			"the sign-off is for a different commit than the spine's",
		);
	return ok(kind, "a person approved the specs");
}

export async function verifyRun(
	run: Run,
	history: History,
): Promise<RunReceipts> {
	const { rows, plan } = run;
	const spine = plan.children.find((c) => Object.keys(c.acceptance).length > 0);
	const spineLanded = spine ? landedRow(rows, spine.key) : -1;
	const spineRow = spineLanded >= 0 ? rows[spineLanded] : undefined;
	const spineResult = spine
		? lastRow(
				rows,
				(r) =>
					r.child === spine.key && r.stage === "result" && r.status === "done",
			)
		: undefined;
	// A direct landing records the gated head apart from the commit it pushed; the sign-off is for the gated one.
	const spineSha = str(spineRow?.data?.gated) || str(spineRow?.data?.sha);
	const children: ChildReceipts[] = [];
	const exceptions: ReceiptException[] = [];
	for (const key of new Set(
		rows
			.filter((r) => r.stage === "landed" && r.status === "landed")
			.map((r) => r.child),
	)) {
		const at = landedRow(rows, key);
		const row = rows[at] as RunRow;
		const sha = str(row.data?.sha);
		const planned = plan.children.find((c) => c.key === key);
		const receipts: Receipt[] = [
			gatedCommit(rows, key, at),
			await rebasedOnTip(row, history),
			await specsFirst(
				{
					spine,
					spineRow,
					result: spineResult,
					owns: spine ? ownedScenarios(plan, spine).map((o) => o.id) : [],
				},
				key,
				row,
				history,
			),
			planned
				? await scenarioTests(planned, spine, sha, history)
				: missing("scenario-tests", "not in the plan"),
			signoff(rows, spine, spineSha),
		];
		const pr = Number(row.data?.pr);
		children.push({
			child: key,
			...(pr ? { pr } : {}),
			sha,
			receipts,
			complete: receipts.every((r) => r.status !== "missing"),
		});
		for (const r of receipts)
			if (r.status === "missing")
				exceptions.push({
					run: run.key,
					child: key,
					kind: r.kind,
					reason: r.detail ?? "",
				});
	}
	return { run: run.key, children, exceptions };
}

export function countReceipts(runs: RunReceipts[]): ReceiptCounts {
	const exceptions: ReceiptCounts["exceptions"] = {};
	for (const e of runs.flatMap((r) => r.exceptions))
		exceptions[e.kind] = (exceptions[e.kind] ?? 0) + 1;
	const children = runs.flatMap((r) => r.children);
	return {
		runs: runs.length,
		landed: children.length,
		complete: children.filter((c) => c.complete).length,
		exceptions,
	};
}

export function renderReceipts(runs: RunReceipts[]): string {
	const lines: string[] = [];
	for (const r of runs) {
		const complete = r.children.filter((c) => c.complete);
		lines.push(
			`${r.run}  ${complete.length}/${r.children.length} landed children with full receipts`,
		);
		for (const c of complete)
			lines.push(`  ok         ${c.child}${c.pr ? `  #${c.pr}` : ""}`);
		for (const c of r.children.filter((c) => !c.complete))
			lines.push(`  exceptions ${c.child}${c.pr ? `  #${c.pr}` : ""}`);
		for (const e of r.exceptions)
			lines.push(`    ${e.child}  ${e.kind}  ${e.reason}`);
		for (const c of r.children)
			for (const n of c.receipts.filter((x) => x.status === "not-recorded"))
				lines.push(
					`  note       ${c.child}  ${n.kind} not recorded: ${n.detail ?? ""}`,
				);
	}
	return lines.join("\n");
}
