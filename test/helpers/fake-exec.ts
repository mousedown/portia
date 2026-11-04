import type { Exec, ExecResult } from "../../src/core/exec";

export interface ExecCall {
	cmd: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}
export function fakeExec(
	handler: (c: ExecCall) => Partial<ExecResult> | undefined = () => undefined,
) {
	const calls: ExecCall[] = [];
	const exec: Exec = async (cmd, args, opts = {}) => {
		const call = {
			cmd,
			args,
			cwd: opts.cwd,
			env: opts.env,
			timeoutMs: opts.timeoutMs,
		};
		calls.push(call);
		return { code: 0, stdout: "", stderr: "", ...handler(call) };
	};
	return { exec, calls, line: (c: ExecCall) => [c.cmd, ...c.args].join(" ") };
}
