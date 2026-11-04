/** What a landed child must carry to prove it. */
export const RECEIPTS = [
	/** A gate passed on the exact commit that landed. */
	"gated-commit",
	/** That commit was rebased on the integration tip at the time it landed. */
	"rebased-on-tip",
	/** The spine's acceptance specs were committed before any child's implementation, and failed then. */
	"specs-first",
	/** Each scenario has an acceptance test whose title starts with its id. */
	"scenario-tests",
	/** A person signed off the acceptance specs. */
	"signoff",
] as const;
export type ReceiptKind = (typeof RECEIPTS)[number];

/** `not-recorded` is for runs older than the record (sign-offs before they were logged): never an exception. */
export type ReceiptStatus = "ok" | "missing" | "not-recorded";

export interface Receipt {
	kind: ReceiptKind;
	status: ReceiptStatus;
	detail?: string;
}

export interface ReceiptException {
	run: string;
	child: string;
	kind: ReceiptKind;
	reason: string;
}

export interface ChildReceipts {
	child: string;
	pr?: number;
	/** The commit that landed. */
	sha: string;
	receipts: Receipt[];
	complete: boolean;
}

export interface RunReceipts {
	run: string;
	children: ChildReceipts[];
	exceptions: ReceiptException[];
}

/** What `portia verify --json` prints: aggregate counts only, safe to share. */
export interface ReceiptCounts {
	runs: number;
	landed: number;
	complete: number;
	/** Exceptions by receipt; a receipt with none is left out. */
	exceptions: Partial<Record<ReceiptKind, number>>;
}
