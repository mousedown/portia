/**
 * Splits a command line into words as a POSIX shell would quote them: single quotes keep
 * everything, double quotes keep everything but `\\"`, `\\\\`, `\\$` and `` \\` ``, and a
 * backslash outside quotes keeps the next character. Nothing is expanded. Undefined on an
 * unterminated quote or a trailing backslash.
 */
export function commandWords(line: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else word += ch;
		} else if (quote === '"') {
			if (ch === '"') quote = undefined;
			else if (ch === "\\" && /["\\$`]/.test(line[i + 1] ?? "")) {
				word += line[i + 1];
				i++;
			} else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === "\\") {
			if (i + 1 >= line.length) return undefined;
			word += line[i + 1];
			i++;
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
		} else {
			word += ch;
			inWord = true;
		}
	}
	if (quote) return undefined;
	if (inWord) words.push(word);
	return words;
}
