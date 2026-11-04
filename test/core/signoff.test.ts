import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readRows } from "../../src/core/runlog";
import { minutesSince, recordSignoff } from "../../src/core/signoff";
import { phrase } from "../../src/view/model/phrase";

it("minutes between two instants, to a tenth, never negative", () => {
	expect(minutesSince("2026-10-21T10:00:00Z", "2026-10-21T10:12:30Z")).toBe(
		12.5,
	);
	expect(minutesSince("2026-10-21T10:12:00Z", "2026-10-21T10:00:00Z")).toBe(0);
});

it("a sign-off row says who, which commit and how long it waited, and reads as one line in the view", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-"));
	const row = recordSignoff(
		dir,
		{
			kind: "specs",
			child: "ACME-201",
			attempt: 1,
			approved: true,
			by: "person",
			commit: "0123456789abcdef\n",
			askedAt: "2026-10-21T10:00:00Z",
		},
		"2026-10-21T10:40:00Z",
	);
	expect(readRows(dir).rows).toEqual([row]);
	expect(row).toMatchObject({
		stage: "signoff",
		status: "approved",
		data: { by: "person", commit: "0123456789abcdef", waitedMinutes: 40 },
	});
	expect(phrase(row)).toMatchObject({
		label: "specs signed off",
		detail: "by a person · 0123456 · waited 40m",
		role: "done",
	});
	const plan = recordSignoff(dir, {
		kind: "plan",
		child: "ACME-187",
		attempt: 0,
		approved: false,
		by: "eval",
		commit: "fedcba9876543210",
	});
	expect(plan).toMatchObject({ stage: "approval", status: "rejected" });
	expect(phrase(plan)).toMatchObject({
		label: "plan sent back",
		detail: "by the scripted person · fedcba9",
		role: "parked",
	});
});
