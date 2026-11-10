import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { TextPrompt } from "@clack/core";
import {
	S_BAR,
	S_BAR_END,
	S_STEP_ACTIVE,
	S_STEP_CANCEL,
	S_STEP_ERROR,
	S_STEP_SUBMIT,
} from "@clack/prompts";

export interface SuggestOptions {
	message: string;
	/** Taken on Enter, filled on Tab. Empty means there is nothing to suggest. */
	suggestion: string;
	validate?: (value: string) => string | undefined;
	input?: Readable;
	output?: Writable;
}

/** clack's text prompt, plus Tab: it fills the suggestion so it can be edited. */
class SuggestPrompt extends TextPrompt {
	constructor(
		opts: ConstructorParameters<typeof TextPrompt>[0],
		suggestion: string,
	) {
		super(opts);
		this.on("key", (_char, key) => {
			if (key?.name !== "tab" || !suggestion) return;
			const typed = this.userInput;
			if (typed === suggestion || !suggestion.startsWith(typed)) return;
			this._clearUserInput();
			this._setUserInput(suggestion, true);
		});
	}
}

const HINT = "Tab to edit · Enter to accept";

/** A text prompt whose suggestion is plainly a suggestion, and one key away from being text. */
export function suggestText(o: SuggestOptions): Promise<string | symbol> {
	const { message, suggestion, validate } = o;
	return new SuggestPrompt(
		{
			placeholder: suggestion,
			defaultValue: suggestion,
			validate: validate && ((v) => validate(v || suggestion)),
			input: o.input,
			output: o.output,
			render() {
				const title = (symbol: string) =>
					`${styleText("gray", S_BAR)}\n${symbol}  ${message}\n`;
				const value = this.userInput
					? this.userInputWithCursor
					: suggestion
						? styleText("inverse", suggestion[0] as string) +
							styleText("dim", suggestion.slice(1))
						: styleText(["inverse", "hidden"], "_");
				switch (this.state) {
					case "error":
						return `${title(styleText("yellow", S_STEP_ERROR))}${styleText("yellow", S_BAR)}  ${value}\n${styleText("yellow", S_BAR_END)}  ${styleText("yellow", this.error)}\n`;
					case "submit":
						return `${title(styleText("green", S_STEP_SUBMIT))}${styleText("gray", S_BAR)}  ${styleText("dim", this.value ?? "")}`;
					case "cancel":
						return `${title(styleText("red", S_STEP_CANCEL))}${styleText("gray", S_BAR)}  ${styleText(["strikethrough", "dim"], this.value ?? "")}`;
					default: {
						const hint =
							suggestion && !this.userInput
								? `  ${styleText("dim", HINT)}`
								: "";
						return `${title(styleText("cyan", S_STEP_ACTIVE))}${styleText("cyan", S_BAR)}  ${value}\n${styleText("cyan", S_BAR_END)}${hint}\n`;
					}
				}
			},
		},
		suggestion,
	).prompt() as Promise<string | symbol>;
}
