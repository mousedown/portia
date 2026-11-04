import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileSchema, testProfile } from "../../src/core/config";
import { spawnExec } from "../../src/core/exec";
import { appendRow } from "../../src/core/runlog";
import { commandWords } from "../../src/core/words";
import {
	type NotifySpec,
	notifyPark,
	notifySpec,
	parkCommand,
	REMINDERS,
	remindParks,
} from "../../src/notify/park";
import { fakeExec } from "../helpers/fake-exec";

const park = {
	parent: "ACME-1",
	child: "ACME-2",
	question: 'Use "blue" or red?\nThe form is blue.',
	attempt: 3,
};
const DESKTOP: NotifySpec = { remindMin: 30 };
const quiet = () => {
	const lines: string[] = [];
	return { lines, log: (s: string) => lines.push(s) };
};

describe("notify on park", () => {
	it("shows a desktop notification on macOS by default, the question's first line quoted for AppleScript", async () => {
		const f = fakeExec();
		expect(
			await notifyPark(park, {
				exec: f.exec,
				notify: DESKTOP,
				platform: "darwin",
			}),
		).toBe(true);
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]?.cmd).toBe("osascript");
		expect(f.calls[0]?.args).toEqual([
			"-e",
			'display notification "ACME-2 is waiting on you: Use \\"blue\\" or red?" with title "Portia ACME-1"',
		]);
		expect(f.calls[0]?.timeoutMs).toBeGreaterThan(0);
	});

	it("uses notify-send on Linux, and nothing where neither exists", async () => {
		const f = fakeExec();
		await notifyPark(park, {
			exec: f.exec,
			notify: DESKTOP,
			platform: "linux",
		});
		expect(f.calls.map((c) => [c.cmd, ...c.args])).toEqual([
			[
				"notify-send",
				"--",
				"Portia ACME-1",
				'ACME-2 is waiting on you: Use "blue" or red?',
			],
		]);
		const w = fakeExec();
		expect(
			await notifyPark(park, {
				exec: w.exec,
				notify: DESKTOP,
				platform: "win32",
			}),
		).toBe(false);
		expect(w.calls).toEqual([]);
	});

	it("runs the profile's onPark hook instead, with every placeholder filled", async () => {
		const f = fakeExec();
		await notifyPark(park, {
			exec: f.exec,
			notify: {
				onPark:
					"terminal-notifier -title 'Portia {parent}' -message '{child}: {question}' -group {child}-{attempt}",
				remindMin: 30,
			},
			platform: "darwin",
		});
		expect(f.calls.map((c) => [c.cmd, ...c.args])).toEqual([
			[
				"terminal-notifier",
				"-title",
				"Portia ACME-1",
				"-message",
				`ACME-2: ${park.question}`,
				"-group",
				"ACME-2-3",
			],
		]);
		expect(f.calls[0]?.env).toMatchObject({
			PORTIA_PARENT: "ACME-1",
			PORTIA_CHILD: "ACME-2",
			PORTIA_QUESTION: park.question,
			PORTIA_ATTEMPT: "3",
			PORTIA_REMINDER: "0",
		});
	});

	it("never lets a question inject shell: it stays one literal argument", async () => {
		const question =
			'it\'s $(touch /tmp/pwned) `id`; rm -rf ~ && echo "x" | cat';
		const hostile = { ...park, question };
		const spec = { onPark: "printf %s '{question}'", remindMin: 30 };
		expect(parkCommand(hostile, spec, "linux")).toEqual([
			"printf",
			["%s", question],
		]);
		expect(
			parkCommand(
				hostile,
				{ ...spec, onPark: "printf %s {question}" },
				"linux",
			),
		).toEqual(["printf", ["%s", question]]);
		// Run for real: what comes back is the question, byte for byte.
		let out = "";
		const exec: typeof spawnExec = async (cmd, args, opts) => {
			const r = await spawnExec(cmd, args, opts);
			out = r.stdout;
			return r;
		};
		expect(
			await notifyPark(hostile, { exec, notify: spec, platform: "linux" }),
		).toBe(true);
		expect(out).toBe(question);
	});

	it("does nothing with notify: false", async () => {
		const f = fakeExec();
		expect(
			await notifyPark(park, {
				exec: f.exec,
				notify: false,
				platform: "darwin",
			}),
		).toBe(false);
		expect(f.calls).toEqual([]);
	});

	it("logs a notifier that fails or is missing, and never throws", async () => {
		const q = quiet();
		const failing = fakeExec(() => ({ code: 1, stderr: "no display" }));
		expect(
			await notifyPark(park, {
				exec: failing.exec,
				notify: DESKTOP,
				platform: "linux",
				log: q.log,
			}),
		).toBe(false);
		expect(
			await notifyPark(park, {
				exec: async () => {
					throw new Error("spawn notify-send ENOENT");
				},
				notify: DESKTOP,
				platform: "linux",
				log: q.log,
			}),
		).toBe(false);
		expect(q.lines).toEqual([
			"ACME-2: the park notification failed (1): no display",
			"ACME-2: the park notification failed: spawn notify-send ENOENT",
		]);
	});
});

describe("the notify profile option", () => {
	const prev = process.env.PORTIA_NOTIFY;
	afterEach(() => {
		process.env.PORTIA_NOTIFY = prev;
	});
	const parse = (notify: unknown) =>
		ProfileSchema.safeParse({ ...testProfile(), notify });

	it("defaults to the desktop notification and a reminder after 30 minutes", () => {
		const { notify: _, ...rest } = testProfile();
		expect(ProfileSchema.parse(rest).notify).toEqual({ remindMin: 30 });
		expect(parse({ onPark: "say {question}" }).data?.notify).toEqual({
			onPark: "say {question}",
			remindMin: 30,
		});
	});

	it("takes false to switch it off, and refuses a hook it cannot split or a key it does not know", () => {
		expect(parse(false).data?.notify).toBe(false);
		expect(parse({ onPark: "say 'unclosed" }).success).toBe(false);
		expect(parse({ onPark: "say \\" }).success).toBe(false);
		expect(parse({ remindMin: 0 }).success).toBe(false);
		expect(parse({ onPark: "say", remind: 5 }).success).toBe(false);
	});

	it("is off in the test suite through PORTIA_NOTIFY=0, and on otherwise", () => {
		expect(notifySpec(testProfile())).toBe(false);
		delete process.env.PORTIA_NOTIFY;
		expect(notifySpec(testProfile())).toEqual({ remindMin: 30 });
		expect(notifySpec({ notify: false })).toBe(false);
	});

	it("splits a hook into words as a shell quotes them, expanding nothing", () => {
		expect(commandWords(`a 'b c' "d \\"e\\" $f" g\\ h  ''`)).toEqual([
			"a",
			"b c",
			'd "e" $f',
			"g h",
			"",
		]);
		expect(commandWords(`say "open`)).toBeUndefined();
	});
});

describe("remind once", () => {
	const PARKED_AT = Date.parse("2026-10-20T12:00:00.000Z");
	const min = (n: number) => PARKED_AT + n * 60_000;
	const run = () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-remind-"));
		appendRow(dir, {
			at: "2026-10-20T11:00:00.000Z",
			child: "ACME-2",
			attempt: 1,
			stage: "dispatched",
		});
		appendRow(dir, {
			at: new Date(PARKED_AT).toISOString(),
			child: "ACME-2",
			attempt: 1,
			stage: "result",
			status: "parked",
			data: { message: "Which colour?" },
		});
		return dir;
	};
	const remind = (dir: string, now: number, notify: NotifySpec = DESKTOP) => {
		const f = fakeExec();
		return remindParks({
			dir,
			parent: "ACME-1",
			now,
			ctx: { exec: f.exec, notify, platform: "linux" },
		}).then((children) => ({ children, calls: f.calls }));
	};

	it("waits remindMin minutes, then notifies once more, and never again", async () => {
		const dir = run();
		expect((await remind(dir, min(29))).calls).toEqual([]);
		const first = await remind(dir, min(30));
		expect(first.children).toEqual(["ACME-2"]);
		expect(first.calls.map((c) => c.args.at(-1))).toEqual([
			"ACME-2 is still waiting on you: Which colour?",
		]);
		expect(first.calls[0]?.env?.PORTIA_REMINDER).toBe("1");
		expect((await remind(dir, min(31))).calls).toEqual([]);
		expect((await remind(dir, min(600))).calls).toEqual([]);
		expect(
			JSON.parse(readFileSync(join(dir, REMINDERS), "utf8")).reminded,
		).toEqual({
			"ACME-2@2026-10-20T12:00:00.000Z": new Date(min(30)).toISOString(),
		});
	});

	it("reminds once however many callers check at the same moment", async () => {
		const dir = run();
		const all = await Promise.all([
			remind(dir, min(45)),
			remind(dir, min(45)),
			remind(dir, min(45)),
		]);
		expect(all.flatMap((r) => r.calls)).toHaveLength(1);
	});

	it("follows the profile's remindMin, and nothing with notify: false", async () => {
		const dir = run();
		expect((await remind(dir, min(5), false)).calls).toEqual([]);
		expect((await remind(dir, min(50), false)).calls).toEqual([]);
		expect(existsSync(join(dir, REMINDERS))).toBe(false);
		expect((await remind(dir, min(5), { remindMin: 5 })).calls).toHaveLength(1);
	});

	it("never reminds an answered question, nor a park the run clears itself", async () => {
		const dir = run();
		appendRow(dir, {
			at: "2026-10-20T12:10:00.000Z",
			child: "ACME-2",
			attempt: 2,
			stage: "dispatched",
		});
		appendRow(dir, {
			at: "2026-10-20T12:11:00.000Z",
			child: "ACME-3",
			attempt: 1,
			stage: "result",
			status: "failed",
			data: { message: "usage-limit: limit reached" },
		});
		appendRow(dir, {
			at: "2026-10-20T12:11:01.000Z",
			child: "ACME-3",
			attempt: 0,
			stage: "decision",
			status: "park",
			data: {
				kind: "failure",
				why: "every account is at its usage limit or not logged in (a until 2026-10-20T15:00:00.000Z); the soonest frees at 2026-10-20T15:00:00.000Z. Run portia accounts clear <name> if one has reset sooner or been logged in",
			},
		});
		expect((await remind(dir, min(120))).calls).toEqual([]);
	});

	it("reminds a later park of the same child on its own clock", async () => {
		const dir = run();
		await remind(dir, min(30));
		appendRow(dir, {
			at: "2026-10-20T13:00:00.000Z",
			child: "ACME-2",
			attempt: 2,
			stage: "dispatched",
		});
		appendRow(dir, {
			at: "2026-10-20T14:00:00.000Z",
			child: "ACME-2",
			attempt: 2,
			stage: "result",
			status: "parked",
			data: { message: "And the font?" },
		});
		expect(
			(await remind(dir, min(149))).calls.map((c) => c.args.at(-1)),
		).toEqual([]);
		expect(
			(await remind(dir, min(150))).calls.map((c) => c.args.at(-1)),
		).toEqual(["ACME-2 is still waiting on you: And the font?"]);
	});
});
