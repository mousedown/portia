#!/usr/bin/env bun
/**
 * Writes the invented ACME home that `portia view` is tested against (spec §15.2), as of
 * 2026-10-20T14:02:31Z. Run it again after changing it: `bun test/fixtures/view/make-home.ts`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "home", "runs");
const TASK = ["typecheck", "lint", "related-unit"];
const EXIT = [
	"typecheck",
	"lint",
	"unit",
	"integration",
	"acceptance",
	"e2e",
	"debt",
];
const WT = "/home/acme/.portia/worktrees/acme-app";

type Row = Record<string, unknown>;
const t = (hms: string, day = "20") => `2026-10-${day}T${hms}.000Z`;
const steps = (names: string[], failAt?: string) => {
	const out: { name: string; ok: boolean }[] = [];
	for (const name of names) {
		out.push({ name, ok: name !== failAt });
		if (name === failAt) break;
	}
	return out;
};
const sha = (seed: string) => `${seed.repeat(8)}0123456789abcdef`.slice(0, 40);

class Log {
	rows: Row[] = [];
	envUp(child: string, at: string, port: number) {
		const n = child.toLowerCase().replace("-", "_");
		this.rows.push({
			at,
			child,
			attempt: 0,
			stage: "env",
			status: "up",
			data: {
				worktree: `${WT}/${child}`,
				branch: `epic/${child}`,
				db: `portia_${n}`,
				port,
				envFile: `${WT}/${child}/.env.portia`,
			},
		});
		return this;
	}
	envDown(child: string, at: string, parent: string) {
		this.rows.push({
			at,
			child,
			attempt: 0,
			stage: "env",
			status: "down",
			data: { parent },
		});
		return this;
	}
	dispatch(
		child: string,
		at: string,
		attempt: number,
		model: string,
		data?: Record<string, unknown>,
	) {
		this.rows.push({
			at,
			child,
			attempt,
			stage: "dispatched",
			model: { requested: model },
			...(data ? { data } : {}),
		});
		return this;
	}
	gate(child: string, at: string, kind: "task" | "exit", failAt?: string) {
		this.rows.push({
			at,
			child,
			attempt: 0,
			stage: "gate",
			status: failAt ? "fail" : "pass",
			data: { kind, steps: steps(kind === "task" ? TASK : EXIT, failAt) },
		});
		return this;
	}
	result(
		child: string,
		at: string,
		attempt: number,
		model: string,
		o: {
			status?: string;
			tokens: number;
			message?: string;
			outside?: string[];
			evidence?: Record<string, string>;
		},
	) {
		const status = o.status ?? "done";
		this.rows.push({
			at,
			child,
			attempt,
			stage: "result",
			status,
			tokens: o.tokens,
			...(status === "done" ? { touchesMatched: !o.outside?.length } : {}),
			model: { requested: model },
			data: {
				message:
					o.message ??
					`done; evidence for ${Object.keys(o.evidence ?? {}).join(", ")}`,
				outside: o.outside ?? [],
				evidence: o.evidence ?? {},
			},
		});
		return this;
	}
	decision(
		child: string,
		at: string,
		answer: string,
		kind: string,
		why: string,
	) {
		this.rows.push({
			at,
			child,
			attempt: 0,
			stage: "decision",
			status: answer,
			data: { kind, by: "rule", answer, why },
		});
		return this;
	}
	landFailed(child: string, at: string, attempt: number, reason: string) {
		this.rows.push({
			at,
			child,
			attempt,
			stage: "land",
			status: "failed",
			data: { reason },
		});
		return this;
	}
	landed(child: string, at: string, attempt: number, pr: number, seed: string) {
		this.rows.push({
			at,
			child,
			attempt,
			stage: "landed",
			status: "landed",
			data: { pr, sha: sha(seed) },
		});
		return this;
	}
	epic(parent: string, at: string, failAt?: string) {
		this.rows.push({
			at,
			child: parent,
			attempt: 0,
			stage: "epic",
			status: failAt ? "fail" : "pass",
			data: { steps: steps(EXIT, failAt) },
		});
		return this;
	}
	/** One child, start to finish, on its first attempt. */
	clean(
		child: string,
		o: {
			day?: string;
			from: string;
			task: string;
			exit: string;
			result: string;
			landed: string;
			model: string;
			tokens: number;
			pr: number;
			req: string;
			port: number;
			parent: string;
		},
	) {
		const d = o.day;
		return this.envUp(child, t(o.from, d), o.port)
			.dispatch(child, t(o.from, d), 1, o.model)
			.gate(child, t(o.task, d), "task")
			.gate(child, t(o.exit, d), "exit")
			.result(child, t(o.result, d), 1, o.model, {
				tokens: o.tokens,
				evidence: { [o.req]: `bun test ${child.toLowerCase()} passed` },
			})
			.landed(child, t(o.landed, d), 1, o.pr, child.slice(-3))
			.envDown(child, t(o.landed, d), o.parent);
	}
	text() {
		return this.rows.map((r) => `${JSON.stringify(r)}\n`).join("");
	}
}

const child = (
	key: string,
	summary: string,
	wave: number,
	req: string[],
	needs: string[] = [],
) => ({
	key,
	summary,
	wave,
	needs: needs.map((k) => ({ key: k, reason: "builds on its contract" })),
	touches: [`src/${key.toLowerCase()}/**`],
	requirements: req,
	evidence: `bun test ${key.toLowerCase()}`,
	tier: "standard",
	size: "S",
	acceptance: {},
	blockedBy: needs,
});
const snapshot = (at: string, plan: object) =>
	`${JSON.stringify({ version: 1, at, plan }, null, "\t")}\n`;
const ledger = (key: string, rows: string[], evidence: string[]) =>
	[
		"<p>Some text the PR author wrote.</p>",
		"<table><tr><td>1</td><td>not the ledger</td></tr></table>",
		"| 9 | NOT-1 outside the markers | landed | #1 | X1 ✓ | matched |  | opus |",
		"",
		"<!-- epic-ledger:start -->",
		`## Ledger: ${key}`,
		"",
		"| Wave | Child | State | PR | Requirements | Touches | Design | Model |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows,
		"",
		"### Evidence",
		"",
		...evidence,
		"",
		"_Rendered from the tracker, GitHub and the run log. Edits between the markers are overwritten._",
		"<!-- epic-ledger:end -->",
		"",
	].join("\n");

const files: Record<string, string> = {};
const put = (run: string, name: string, text: string) => {
	files[join(run, name)] = text;
};

// ACME-500: in session. Plan and ledger. 505 is in its exit gate on attempt 2; 506 works.
{
	const P = "ACME-500";
	const log = new Log().clean("ACME-501", {
		from: "07:21:31",
		task: "07:39:22",
		exit: "07:47:11",
		result: "07:48:30",
		landed: "08:02:40",
		model: "opus",
		tokens: 139204,
		pr: 415,
		req: "R1",
		port: 3100,
		parent: P,
	});
	log.rows[1] = { ...log.rows[1], at: t("07:21:40") };
	log
		.envUp("ACME-502", t("08:04:50"), 3105)
		.envUp("ACME-503", t("08:05:05"), 3102)
		.dispatch("ACME-502", t("08:05:00"), 1, "sonnet")
		.dispatch("ACME-503", t("08:05:10"), 1, "opus")
		.gate("ACME-502", t("08:15:00"), "task")
		.gate("ACME-503", t("08:20:00"), "task")
		.gate("ACME-502", t("08:21:12"), "exit")
		.result("ACME-502", t("08:22:00"), 1, "sonnet", {
			tokens: 96112,
			evidence: { R2: "pricing acceptance 3 passed" },
		})
		.landed("ACME-502", t("08:33:00"), 1, 418, "502")
		.envDown("ACME-502", t("08:33:20"), P)
		.gate("ACME-503", t("08:35:00"), "exit", "integration")
		.result("ACME-503", t("08:36:00"), 1, "opus", {
			status: "failed",
			tokens: 98000,
			message:
				"exit gate failed: integration\n\n  tax.itest.ts > reverse charge > zero-rates a business buyer\n    expected 0, received 20",
		})
		.decision("ACME-503", t("08:36:20"), "retry", "failure", "attempt 1 of 2")
		.dispatch("ACME-503", t("08:37:00"), 2, "opus")
		.gate("ACME-503", t("08:50:00"), "task")
		.gate("ACME-503", t("08:59:03"), "exit")
		.result("ACME-503", t("09:00:00"), 2, "opus", {
			tokens: 113480,
			outside: ["src/tax/rates.ts", "specs/tax/rates.spec.ts"],
			evidence: { R3: "tax.itest.ts 6 passed" },
		})
		.decision(
			"ACME-503",
			t("09:12:30"),
			"accept",
			"touches-mismatch",
			"every file outside touches is approved",
		)
		.landed("ACME-503", t("09:17:10"), 2, 421, "503")
		.envDown("ACME-503", t("09:17:30"), P)
		.envUp("ACME-504", t("12:57:55"), 3103)
		.dispatch("ACME-504", t("12:58:02"), 1, "sonnet")
		.envUp("ACME-505", t("13:03:30"), 3101)
		.dispatch("ACME-505", t("13:03:40"), 1, "sonnet")
		.gate("ACME-505", t("13:12:31"), "task")
		.gate("ACME-504", t("13:20:00"), "task")
		.gate("ACME-505", t("13:21:07"), "exit")
		.result("ACME-505", t("13:22:15"), 1, "sonnet", {
			tokens: 127315,
			outside: ["src/invoice/render/pdf.ts"],
			evidence: { R5: "invoice-pdf.spec.ts 5 passed" },
		})
		.decision(
			"ACME-505",
			t("13:22:30"),
			"accept",
			"touches-mismatch",
			"every file outside touches is approved",
		)
		.gate("ACME-504", t("13:25:40"), "exit")
		.result("ACME-504", t("13:26:10"), 1, "sonnet", {
			tokens: 88051,
			evidence: { R4: "invoice-list.spec.tsx 9 passed" },
		})
		.landed("ACME-504", t("13:31:02"), 1, 427, "3f9e2c1")
		.envDown("ACME-504", t("13:31:20"), P)
		.gate("ACME-505", t("13:49:40"), "exit", "unit")
		.landFailed(
			"ACME-505",
			t("13:49:58"),
			1,
			"exit gate failed on the rebased head: unit\n\n2 suites failed: invoice/pdf.spec.ts and invoice/period.spec.ts, both rounding half-cents the wrong way.\n\n  expected 10.05, received 10.04",
		)
		.decision("ACME-505", t("13:50:11"), "retry", "failure", "attempt 1 of 2")
		// A subagent: dispatch recorded the orchestrator's pid (4242, alive in mtimes.json).
		.dispatch("ACME-505", t("13:50:27"), 2, "sonnet", {
			pid: 4242,
			started: "Tue Oct 20 08:00:00 2026",
		})
		.envUp("ACME-506", t("13:58:36"), 3102)
		.dispatch("ACME-506", t("13:58:40"), 1, "opus")
		.gate("ACME-505", t("14:02:19"), "task");
	put(P, "runlog.jsonl", log.text());
	put(
		P,
		"plan.json",
		snapshot(t("14:00:31"), {
			key: P,
			summary: "Self-serve invoices for team accounts",
			scope: "billing",
			scenarios: [
				{
					id: "R1",
					text: "an invoice lists every line item of a billing period",
				},
				{ id: "R2", text: "a line item is priced from the plan catalogue" },
				{ id: "R3", text: "tax follows the billing country" },
				{ id: "R4", text: "a team admin sees every invoice of the team" },
				{ id: "R5", text: "a team admin downloads an invoice as PDF" },
				{ id: "R6", text: "the invoice is emailed when a period closes" },
				{ id: "R7", text: "a credit note reverses a paid line item" },
				{ id: "R8", text: "metered usage becomes invoice lines" },
			],
			children: [
				child("ACME-501", "Invoice model and line items", 0, ["R1"]),
				child(
					"ACME-502",
					"Price a line item from the plan catalogue",
					1,
					["R2"],
					["ACME-501"],
				),
				child(
					"ACME-503",
					"Tax rules per billing country",
					1,
					["R3"],
					["ACME-501"],
				),
				child(
					"ACME-504",
					"Invoice list for team admins",
					2,
					["R4"],
					["ACME-502"],
				),
				child(
					"ACME-505",
					"Team admins download an invoice as PDF",
					2,
					["R5"],
					["ACME-502"],
				),
				child(
					"ACME-506",
					"Email the invoice when a billing period closes",
					2,
					["R6"],
					["ACME-503"],
				),
				child(
					"ACME-507",
					"Credit notes reverse a paid line item",
					3,
					["R7"],
					["ACME-504"],
				),
				child(
					"ACME-508",
					"Usage-based lines from metered events",
					4,
					["R8"],
					["ACME-506"],
				),
			],
		}),
	);
	put(
		P,
		"ledger-body.md",
		ledger(
			P,
			[
				"| 0 | ACME-501 Invoice model and line items | landed | #415 | R1 ✓ | matched |  | opus |",
				"| 1 | ACME-502 Price a line item from the plan catalogue | landed | #418 | R2 ✓ | matched |  | sonnet |",
				"| 1 | ACME-503 Tax rules per billing country | landed | #421 | R3 ✓ | **outside touches** |  | opus |",
				"| 2 | ACME-504 Invoice list for team admins | landed | #427 | R4 ✓ | matched |  | sonnet |",
				"| 2 | ACME-505 Team admins download an invoice as PDF | running |  | R5 ✗ |  |  | sonnet |",
				"| 2 | ACME-506 Email the invoice when a billing period closes | running |  | R6 ✗ |  |  | opus |",
				"| 3 | ACME-507 Credit notes reverse a paid line item | pending |  | R7 ✗ |  |  |  |",
				"| 4 | ACME-508 Usage-based lines from metered events | pending |  | R8 ✗ |  |  |  |",
			],
			[
				"- ACME-501 R1: bun test invoice/ → 31 pass, 0 fail; acceptance invoice.itest.ts 4 passed",
				"- ACME-502 R2: pricing acceptance 3 passed; a plan with no price refuses to invoice",
				"- ACME-503 R3: tax.itest.ts 6 passed; a country with no rule falls back to zero-rated",
				"- ACME-504 R4: invoice-list.spec.tsx 9 passed; an admin of two teams sees both lists",
			],
		),
	);
	put(P, "epic.json", `${JSON.stringify({ epicPr: 412 })}\n`);
	put(P, "ports.json", "[3100,3101,3102]\n");
	put(P, "baseline.json", "[]\n");
	const approval = (glob: string, at: string, why: string) => ({
		glob,
		at,
		by: "person",
		why,
	});
	put(
		P,
		"touches-ACME-503.json",
		`${JSON.stringify(
			[
				approval(
					"src/tax/rates.ts",
					t("09:12:00"),
					"the shared rate table had to learn about reverse charge",
				),
				approval(
					"specs/tax/rates.spec.ts",
					t("09:12:00"),
					"its test moves with it",
				),
			],
			null,
			"\t",
		)}\n`,
	);
	put(
		P,
		"touches-ACME-505.json",
		`${JSON.stringify([approval("src/invoice/render/**", t("13:20:00"), "the PDF renderer lives beside the HTML one")], null, "\t")}\n`,
	);
	// ACME-506 runs as a detached worker (pid 48211, alive in mtimes.json), with a
	// stream-json log whose mtime mtimes.json sets 12 s before the fixture's now.
	put(
		P,
		"worker-ACME-506.json",
		`${JSON.stringify({
			child: "ACME-506",
			attempt: 1,
			pid: 48211,
			proc: "Tue Oct 20 13:58:41 2026",
			worktree: `${WT}/ACME-506`,
			log: `/home/acme/.portia/runs/${P}/worker-ACME-506-1.log`,
			result: `/home/acme/.portia/runs/${P}/result-ACME-506-1.json`,
			startedAt: t("13:58:41"),
		})}\n`,
	);
	const say = (text: string) => ({
		type: "assistant",
		message: { content: [{ type: "text", text }] },
	});
	const tool = (name: string, input: Record<string, unknown>) => ({
		type: "assistant",
		message: { content: [{ type: "tool_use", name, input }] },
	});
	const out = (content: string, is_error = false) => ({
		type: "user",
		message: { content: [{ type: "tool_result", content, is_error }] },
	});
	put(
		P,
		"worker-ACME-506-1.log",
		`${[
			{
				type: "system",
				subtype: "init",
				model: "claude-opus",
				session_id: "s1",
			},
			say(
				"Reading the brief: ACME-506 emails the invoice when a billing period closes, proving R6.",
			),
			tool("Read", { file_path: "src/billing/period.ts" }),
			out("export function closePeriod(team: Team, at: Date): Period {"),
			tool("Grep", { pattern: "onPeriodClosed" }),
			out(
				"src/billing/events.ts:14: export const onPeriodClosed = topic('period.closed')",
			),
			say(
				"The close event already exists. I will subscribe a mailer to it rather than call it from closePeriod.",
			),
			tool("Write", { file_path: "src/invoice/mail/on-close.ts" }),
			out("File created successfully at: src/invoice/mail/on-close.ts"),
			tool("Write", { file_path: "specs/invoice/mail-on-close.spec.ts" }),
			out("File created successfully at: specs/invoice/mail-on-close.spec.ts"),
			tool("Bash", { command: "bun test specs/invoice/mail-on-close.spec.ts" }),
			out(
				"error: expected 1 email, received 0\n  at specs/invoice/mail-on-close.spec.ts:22",
				true,
			),
			say(
				"The subscriber is registered after the event fires in the test. Moving the registration into the module's init.",
			),
			tool("Edit", { file_path: "src/invoice/mail/on-close.ts" }),
			out("The file src/invoice/mail/on-close.ts has been updated."),
			tool("Bash", { command: "bun test specs/invoice/mail-on-close.spec.ts" }),
			out(" 4 pass\n 0 fail\nRan 4 tests across 1 file."),
			say("R6 passes locally. Running the task gate next."),
			tool("Bash", { command: "portia gate task ACME-506 --parent ACME-500" }),
		]
			.map((x) => JSON.stringify(x))
			.join("\n")}\n`,
	);
	for (const [k, port] of [
		["ACME-505", 3101],
		["ACME-506", 3102],
	] as const) {
		const n = k.toLowerCase().replace("-", "_");
		put(
			P,
			`env-${k}.json`,
			`${JSON.stringify({ worktree: `${WT}/${k}`, branch: `epic/${k}`, db: `portia_${n}`, port, envFile: `${WT}/${k}/.env.portia` })}\n`,
		);
	}
}

// ACME-410: awaiting judgement. A ledger but no plan; 418 is parked; one runlog line is broken.
{
	const P = "ACME-410";
	const log = new Log();
	const kids: [string, number, string, number][] = [
		["ACME-411", 0, "opus", 351204],
		["ACME-412", 1, "sonnet", 298114],
		["ACME-413", 1, "sonnet", 312877],
		["ACME-414", 1, "opus", 344610],
		["ACME-415", 2, "sonnet", 330918],
		["ACME-416", 2, "opus", 377503],
		["ACME-417", 3, "sonnet", 301245],
		["ACME-419", 3, "sonnet", 362370],
	];
	kids.forEach(([k, , model, tokens], i) => {
		const h = String(2 + i).padStart(2, "0");
		log.clean(k, {
			from: `${h}:00:00`,
			task: `${h}:20:00`,
			exit: `${h}:31:00`,
			result: `${h}:32:00`,
			landed: `${h}:45:00`,
			model,
			tokens,
			pr: 380 + i,
			req: `F${i + 1}`,
			port: 3100,
			parent: P,
		});
	});
	log
		.envUp("ACME-418", t("10:52:50"), 3101)
		.dispatch("ACME-418", t("10:52:57"), 1, "opus")
		.gate("ACME-418", t("11:02:09"), "task")
		.result("ACME-418", t("11:17:40"), 1, "opus", {
			status: "parked",
			tokens: 95000,
			message:
				"May I add the search index migration to my paths?\nThe backfill needs db/migrations/0042_archive_index.sql, which is outside my declared paths.\nWithout it the index cannot be built on an existing database.",
		});
	const text = log.text().split("\n");
	text.splice(9, 0, '{"at":"2026-10-20T03:50:00.000Z","child":"ACME-41');
	put(P, "runlog.jsonl", text.join("\n"));
	put(
		P,
		"ledger-body.md",
		ledger(
			P,
			[
				"| 2 | ACME-415 Filter by archive date | landed | #384 | F5 ✓ | matched |  | sonnet |",
				"| 0 | ACME-411 Search index schema for archived projects | landed | #380 | F1 ✓ | matched |  | opus |",
				"| 1 | ACME-412 Index archived projects nightly | landed | #381 | F2 ✓ | matched |  | sonnet |",
				"| 1 | ACME-413 Rank results by last activity | landed | #382 | F3 ✓ | matched |  | sonnet |",
				"| 1 | ACME-414 Highlight the matched words | landed | #383 | F4 ✓ | matched |  | opus |",
				"| 2 | ACME-416 Search box on the archive page | landed | #385 | F6 ✓ | matched |  | opus |",
				"| 2 | ACME-418 Backfill the index for old archives | parked |  | F9 ✗ |  |  | opus |",
				"| 3 | ACME-417 Empty state for no results | landed | #386 | F7 ✓ | matched |  | sonnet |",
				"| 3 | ACME-419 Keyboard shortcuts in search results | landed | #387 | F8 ✓ | matched |  | sonnet |",
			],
			["- ACME-411 F1: schema migration applies and rolls back cleanly"],
		),
	);
	put(P, "epic.json", `${JSON.stringify({ epicPr: 398 })}\n`);
	put(P, "baseline.json", '["lint"]\n');
}

// ACME-366: awaiting judgement, from the runlog alone. 369's land failed.
{
	const P = "ACME-366";
	const log = new Log()
		.clean("ACME-367", {
			from: "06:10:00",
			task: "06:25:00",
			exit: "06:35:00",
			result: "06:36:00",
			landed: "06:50:00",
			model: "opus",
			tokens: 241002,
			pr: 357,
			req: "A1",
			port: 3100,
			parent: P,
		})
		.clean("ACME-368", {
			from: "07:00:00",
			task: "07:15:00",
			exit: "07:24:00",
			result: "07:25:00",
			landed: "07:40:00",
			model: "sonnet",
			tokens: 201117,
			pr: 358,
			req: "A2",
			port: 3100,
			parent: P,
		})
		.envUp("ACME-369", t("10:00:00"), 3100)
		.dispatch("ACME-369", t("10:00:05"), 1, "sonnet")
		.gate("ACME-369", t("10:20:00"), "task")
		.gate("ACME-369", t("10:31:00"), "exit")
		.result("ACME-369", t("10:32:00"), 1, "sonnet", {
			tokens: 168114,
			evidence: { A3: "export.spec.ts 4 passed" },
		})
		.landFailed("ACME-369", t("10:59:44"), 1, "CI failed on PR #360");
	put(P, "runlog.jsonl", log.text());
	put(P, "epic.json", `${JSON.stringify({ epicPr: 359 })}\n`);
}

// ACME-390: at rest. 394 passed its exit gate three hours ago and has written nothing since.
{
	const P = "ACME-390";
	const log = new Log()
		.clean("ACME-391", {
			from: "06:00:00",
			task: "06:15:00",
			exit: "06:24:00",
			result: "06:25:00",
			landed: "06:40:00",
			model: "opus",
			tokens: 300112,
			pr: 382,
			req: "C1",
			port: 3100,
			parent: P,
		})
		.clean("ACME-392", {
			from: "07:00:00",
			task: "07:12:00",
			exit: "07:21:00",
			result: "07:22:00",
			landed: "07:36:00",
			model: "sonnet",
			tokens: 210004,
			pr: 383,
			req: "C2",
			port: 3100,
			parent: P,
		})
		.envUp("ACME-393", t("10:00:00"), 3101)
		.dispatch("ACME-393", t("10:00:10"), 1, "sonnet")
		.gate("ACME-393", t("10:30:00"), "task")
		.gate("ACME-393", t("10:42:00"), "exit")
		.result("ACME-393", t("10:45:00"), 1, "sonnet", {
			tokens: 199002,
			evidence: { C3: "cart-merge.spec.ts 7 passed" },
		})
		.envUp("ACME-394", t("10:39:50"), 3102)
		.dispatch("ACME-394", t("10:40:00"), 1, "opus")
		.gate("ACME-394", t("10:52:00"), "task")
		.gate("ACME-394", t("11:00:12"), "exit");
	put(P, "runlog.jsonl", log.text());
	put(
		P,
		"plan.json",
		snapshot(t("09:00:00"), {
			key: P,
			summary: "Saved carts follow every device",
			scope: "checkout",
			scenarios: [
				{ id: "C1", text: "a cart saved on one device appears on another" },
				{ id: "C2", text: "a guest cart merges into the account cart" },
				{ id: "C3", text: "merging keeps the newest quantity" },
				{ id: "C4", text: "a removed item stays removed everywhere" },
			],
			children: [
				child("ACME-391", "Cart sync contract", 0, ["C1"]),
				child("ACME-392", "Store carts per account", 1, ["C1"], ["ACME-391"]),
				child(
					"ACME-394",
					"Push cart changes to other sessions",
					1,
					["C4"],
					["ACME-391"],
				),
				child(
					"ACME-393",
					"Merge a guest cart on sign-in",
					1,
					["C2", "C3"],
					["ACME-391"],
				),
				child(
					"ACME-395",
					"Cart badge shows the synced count",
					2,
					["C1"],
					["ACME-394"],
				),
				child(
					"ACME-396",
					"Conflict notice when two devices disagree",
					2,
					["C3"],
					["ACME-393"],
				),
			],
		}),
	);
	put(P, "epic.json", `${JSON.stringify({ epicPr: 381 })}\n`);
}

// ACME-352: an empty run directory.
put("ACME-352", ".gitkeep", "");

// ACME-377: delivered. The newest epic row passes after an earlier failure; the log ends mid-write.
{
	const P = "ACME-377";
	const log = new Log();
	const kids: [string, number, string, number][] = [
		["ACME-378", 0, "opus", 512330],
		["ACME-379", 1, "sonnet", 388112],
		["ACME-380", 1, "sonnet", 401229],
		["ACME-381", 2, "opus", 455871],
		["ACME-382", 2, "sonnet", 299802],
		["ACME-383", 2, "sonnet", 320116],
		["ACME-384", 3, "opus", 424435],
	];
	kids.forEach(([k, , model, tokens], i) => {
		const h = String(8 + i).padStart(2, "0");
		log.clean(k, {
			day: "19",
			from: `${h}:00:00`,
			task: `${h}:18:00`,
			exit: `${h}:27:00`,
			result: `${h}:28:00`,
			landed: `${h}:40:00`,
			model,
			tokens,
			pr: 362 + i,
			req: `N${i + 1}`,
			port: 3100,
			parent: P,
		});
	});
	log.epic(P, t("18:20:00", "19"), "integration").epic(P, t("18:55:07", "19"));
	put(
		P,
		"runlog.jsonl",
		`${log.text()}{"at":"2026-10-19T18:56:02.000Z","child":"ACME-37`,
	);
	const plan = {
		key: P,
		summary: "Notification preferences per channel",
		scope: "notifications",
		scenarios: kids.map(([, , ,], i) => ({
			id: `N${i + 1}`,
			text: `notification scenario ${i + 1}`,
		})),
		children: [
			child("ACME-378", "Preference model per channel", 0, ["N1"]),
			child(
				"ACME-379",
				"Email channel honours preferences",
				1,
				["N2"],
				["ACME-378"],
			),
			child(
				"ACME-380",
				"Push channel honours preferences",
				1,
				["N3"],
				["ACME-378"],
			),
			child("ACME-381", "Preferences page", 2, ["N4"], ["ACME-379"]),
			child(
				"ACME-382",
				"Digest frequency per channel",
				2,
				["N5"],
				["ACME-379"],
			),
			child("ACME-383", "Quiet hours", 2, ["N6"], ["ACME-380"]),
			child("ACME-384", "Defaults for new members", 3, ["N7"], ["ACME-381"]),
		],
	};
	put(P, "plan.json", snapshot(t("17:00:00", "19"), plan));
	put(
		P,
		"ledger-body.md",
		ledger(
			P,
			plan.children.map(
				(c, i) =>
					`| ${c.wave} | ${c.key} ${c.summary} | landed | #${362 + i} | N${i + 1} ✓ | matched |  | ${kids[i]?.[2]} |`,
			),
			[],
		),
	);
	put(P, "epic.json", `${JSON.stringify({ epicPr: 371 })}\n`);
}

rmSync(ROOT, { recursive: true, force: true });
for (const [path, text] of Object.entries(files)) {
	mkdirSync(join(ROOT, path, ".."), { recursive: true });
	writeFileSync(join(ROOT, path), text);
}
console.log(`wrote ${Object.keys(files).length} files under ${ROOT}`);
