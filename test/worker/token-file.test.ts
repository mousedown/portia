import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tokenFromFile } from "../../src/worker/detached";

it("passes a worker the token from the file PORTIA_WORKER_TOKEN_FILE names, and nothing without one", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-token-"));
	const file = join(dir, "token");
	writeFileSync(file, "sk-ant-oat01-example\n");
	expect(tokenFromFile({ PORTIA_WORKER_TOKEN_FILE: file })).toEqual({
		CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-example",
	});
	expect(tokenFromFile({})).toEqual({});
	expect(
		tokenFromFile({ PORTIA_WORKER_TOKEN_FILE: join(dir, "none") }),
	).toEqual({});
	writeFileSync(file, "  \n");
	expect(tokenFromFile({ PORTIA_WORKER_TOKEN_FILE: file })).toEqual({});
});
