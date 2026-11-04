import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { frameText } from "../../src/cli/commands/view";
import { parseViewArgs, type ViewArgs } from "../../src/view/args";
import { fixedMtimes, memoryFs, type ViewFs } from "../../src/view/model/fs";
import {
	type MachineView,
	parseMachineFixture,
} from "../../src/view/model/machine";

/** The moment the fixture home describes (spec §15.2). */
export const NOW = Date.parse("2026-10-20T14:02:31Z");
export const HOME = "/fx";
const DIR = join(import.meta.dirname, "../fixtures/view/home");

const walk = (p: string): string[] =>
	statSync(p).isDirectory()
		? readdirSync(p).flatMap((n) => walk(join(p, n)))
		: [p];

/** The fixture home in memory, with the mtimes the mockups assume (its `mtimes.json`). */
export function fixtureFs(
	extra: Record<string, string> = {},
	keep: (path: string) => boolean = () => true,
): ViewFs {
	const files: Record<string, string> = {};
	for (const f of walk(DIR))
		if (keep(f)) files[join(HOME, relative(DIR, f))] = readFileSync(f, "utf8");
	files[join(HOME, "mtimes.json")] = readFileSync(
		join(DIR, "mtimes.json"),
		"utf8",
	);
	return fixedMtimes(memoryFs({ ...files, ...extra }), HOME);
}

const MTIMES = JSON.parse(readFileSync(join(DIR, "mtimes.json"), "utf8"));
const RUN = join(HOME, "runs", "ACME-500");

/** The fixture home with its mtimes.json changed: ACME-506's log time, the pids alive, or what ps says of them. */
export function withMtimes(
	o: {
		log?: string;
		alive?: number[];
		procs?: Record<string, { start?: string; tty?: string }>;
	},
	extra: Record<string, string> = {},
): ViewFs {
	return fixtureFs({
		...extra,
		[join(HOME, "mtimes.json")]: JSON.stringify({
			...MTIMES,
			paths: {
				...MTIMES.paths,
				...(o.log ? { "runs/ACME-500/worker-ACME-506-1.log": o.log } : {}),
			},
			alive: o.alive ?? MTIMES.alive,
			procs: { ...MTIMES.procs, ...o.procs },
		}),
	});
}

/** ACME-506's detached worker started at 13:30 and last wrote to its log at 13:40. */
export function stalledFs(): ViewFs {
	const record = join(RUN, "worker-ACME-506.json");
	const rec = JSON.parse(fixtureFs().read(record) ?? "{}");
	return withMtimes(
		{ log: "2026-10-20T13:40:00Z" },
		{ [record]: JSON.stringify({ ...rec, startedAt: "2026-10-20T13:30:00Z" }) },
	);
}

/** The invented build machine every frame shows: acme-build-01, 8 cores, 64 GB. */
export const MACHINE_FIXTURE = join(
	import.meta.dirname,
	"../fixtures/view/machine.json",
);
export const MACHINE = parseMachineFixture(
	readFileSync(MACHINE_FIXTURE, "utf8"),
) as MachineView;

/** One frame, exactly as `portia view --frame` prints it; `machine: null` shows none. */
export function frame(
	args: string[],
	o: {
		fs?: ViewFs;
		env?: Record<string, string>;
		machine?: MachineView | null;
	} = {},
): string {
	const a: ViewArgs = parseViewArgs([...args, "--frame"], false);
	return frameText(
		{ ...a, now: a.now ?? NOW },
		{
			fs: o.fs ?? fixtureFs(),
			home: HOME,
			env: { HOME: "/home/acme", ...o.env },
			isTTY: false,
			machine: o.machine === null ? undefined : (o.machine ?? MACHINE),
		},
	);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR
export const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Every page, as `portia view --frame` arguments. */
export const SCREENS: [string, string[]][] = [
	["home", []],
	["activity", ["--page", "activity"]],
	["machine", ["--page", "machine"]],
	["run", ["ACME-500", "--select", "ACME-505"]],
	["run-gates", ["ACME-500", "--page", "gates", "--select", "ACME-505"]],
	["run-from-ledger", ["ACME-410"]],
	["run-from-runlog", ["ACME-366"]],
	["child", ["ACME-500", "ACME-505"]],
	["child-detached", ["ACME-500", "ACME-506"]],
	["child-landed", ["ACME-500", "ACME-503"]],
	["child-parked", ["ACME-410/ACME-418"]],
	["child-failed", ["ACME-366", "ACME-369"]],
	["worker", ["ACME-500", "ACME-506", "--page", "worker"]],
	["worker-subagent", ["ACME-500", "ACME-505", "--page", "worker"]],
	["help", ["ACME-500", "--overlay", "help"]],
	["filter", ["--overlay", "filter:state:parked state:failed"]],
	["command", ["--overlay", "command:run ACME-4"]],
];
