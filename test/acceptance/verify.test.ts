import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { writePlanSnapshot } from "../../src/core/plan-snapshot";
import type { ReceiptCounts } from "../../src/core/receipts";
import { sandbox } from "../helpers/git-sandbox";
import { child, parent, spine } from "../helpers/plan";
import { portia, runLog } from "./support";

const PROFILE = join(import.meta.dirname, "../fixtures/profile.ts");
const SPECS = "packages/acme-web/test/acceptance/invoices.test.ts";
const RUN = "ACME-300";

/**
 * A run of a spine and two children, landed as Portia lands them: each child rebased onto
 * the integration tip, gated there, then squash-merged. The spine's specs come first, fail
 * when committed, carry a test per scenario, and a person signed them off.
 */
async function landedRun(o: { gateFor?: (child: string) => boolean } = {}) {
	const gated = o.gateFor ?? (() => true);
	const s = await sandbox();
	const home = mkdtempSync(join(tmpdir(), "portia-verify-"));
	const integration = `epic/${RUN}`;
	const head = async (cwd = s.repo) =>
		(await s.g(cwd, "rev-parse", "HEAD")).trim();
	await s.g(s.repo, "checkout", "-q", "-b", integration);
	await s.g(
		s.repo,
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		`chore(invoices): ${RUN} open the integration branch`,
	);
	await s.g(s.repo, "push", "-q", "origin", integration);

	const plan = {
		...parent(
			[
				spine({ key: "ACME-301", acceptance: { F1: SPECS, F2: SPECS } }),
				child("ACME-302", { requirements: ["F1"] }),
				child("ACME-303", { requirements: ["F2"], wave: 2 }),
			],
			[
				{ id: "F1", text: "Given an invoice, Then its total includes VAT" },
				{ id: "F2", text: "Given a ledger, Then it exports as CSV" },
			],
		),
		key: RUN,
	};
	const log = runLog(home, RUN);
	writePlanSnapshot(log.dir, plan);
	log.add(0, RUN, 0, "approval", {
		status: "approved",
		data: { by: "person", commit: await head(), waitedMinutes: 1 },
	});

	const work: Record<string, Record<string, string>> = {
		"ACME-301": {
			[SPECS]: [
				'import { expect, it } from "vitest";',
				'import { total } from "../../src/total";',
				'import { csv } from "../../src/csv";',
				'it("F1: Given an invoice, Then its total includes VAT", () => expect(total(100)).toBe(120));',
				'it("F2: Given a ledger, Then it exports as CSV", () => expect(csv([1, 2])).toBe("1,2"));',
				"",
			].join("\n"),
		},
		"ACME-302": {
			"packages/acme-web/src/total.ts":
				"export const total = (n: number) => n * 1.2;\n",
		},
		"ACME-303": {
			"packages/acme-web/src/csv.ts":
				'export const csv = (xs: number[]) => xs.join(",");\n',
		},
	};
	let minute = 1;
	let pr = 0;
	for (const [key, files] of Object.entries(work)) {
		const onto = await head();
		await s.g(s.repo, "checkout", "-q", "-b", `epic/${key}`, onto);
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(s.repo, path)), { recursive: true });
			writeFileSync(join(s.repo, path), text);
		}
		await s.g(s.repo, "add", ".");
		await s.g(s.repo, "commit", "-q", "-m", `${key} work`);
		await s.g(s.repo, "push", "-q", "origin", `epic/${key}`);
		const sha = await head();
		const isSpine = key === "ACME-301";
		log.add(minute++, key, 0, "env", {
			status: "up",
			data: { worktree: join(s.root, "wt", key), branch: `epic/${key}` },
		});
		log.add(minute++, key, 1, "dispatched");
		log.add(minute++, key, 1, "result", {
			status: "done",
			tokens: 10_000,
			data: {
				head: sha,
				evidence: isSpine
					? {
							F1: `bunx vitest run ${SPECS} -t "F1: " → Tests 1 failed (1)`,
							F2: `bunx vitest run ${SPECS} -t "F2: " → Tests 1 failed (1)`,
						}
					: { [key === "ACME-302" ? "F1" : "F2"]: "Tests 1 passed (1)" },
			},
		});
		if (isSpine)
			log.add(minute++, key, 1, "signoff", {
				status: "approved",
				data: { by: "person", commit: sha, waitedMinutes: 2 },
			});
		if (gated(key))
			log.add(minute++, key, 0, "gate", {
				status: "pass",
				data: { kind: "exit", steps: [{ name: "test", ok: true }] },
			});
		await s.g(s.repo, "checkout", "-q", integration);
		await s.g(s.repo, "merge", "-q", "--squash", `epic/${key}`);
		pr++;
		await s.g(
			s.repo,
			"commit",
			"-q",
			"-m",
			`feat(invoices): ${RUN} ${key} (#${pr})`,
		);
		await s.g(s.repo, "push", "-q", "origin", integration);
		log.add(minute++, key, 1, "landed", {
			status: "landed",
			data: { pr, sha, onto, tracker: "pending" },
		});
	}
	const verify = (...args: string[]) =>
		portia(["verify", RUN, ...args], {
			home,
			cwd: s.repo,
			env: { PORTIA_PROFILE: PROFILE },
		});
	return { verify };
}

const built = (r: { err: string }) =>
	expect(r.err).not.toMatch(/not built yet/);

it("V1: Given a run whose every landed child has full receipts, Then the verify command reports them all complete and exits 0", async () => {
	const { verify } = await landedRun();
	const plain = verify();
	built(plain);
	expect(plain.code).toBe(0);
	for (const key of ["ACME-301", "ACME-302", "ACME-303"])
		expect(plain.out).toContain(key);
	const json = verify("--json");
	expect(json.code).toBe(0);
	expect(JSON.parse(json.out) as ReceiptCounts).toEqual({
		runs: 1,
		landed: 3,
		complete: 3,
		exceptions: {},
	});
});

it("V2: Given a run log missing one receipt, Then the verify command reports exactly that exception and exits non-zero", async () => {
	const { verify } = await landedRun({ gateFor: (k) => k !== "ACME-303" });
	const plain = verify();
	built(plain);
	expect(plain.code).not.toBe(0);
	expect(`${plain.out}\n${plain.err}`).toMatch(
		/ACME-303[^\n]*gated-commit|gated-commit[^\n]*ACME-303/,
	);
	const json = verify("--json");
	expect(json.code).not.toBe(0);
	expect(JSON.parse(json.out) as ReceiptCounts).toEqual({
		runs: 1,
		landed: 3,
		complete: 2,
		exceptions: { "gated-commit": 1 },
	});
});
