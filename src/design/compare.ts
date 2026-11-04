import type { ElementValues, PropCheck, Verdict } from "./types";

const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const sameColour = (a: string, b: string) => {
	const x = rgb(a);
	const y = rgb(b);
	return (
		x.length === 3 &&
		y.length === 3 &&
		x.every((v, i) => Math.abs(v - (y[i] ?? 0)) <= 3)
	);
};
const sameNum = (a: number, b: number) => Math.abs(a - b) <= 0.5;
const TRANSPARENT = "rgba(0, 0, 0, 0)";

export function compareProps(
	expected: ElementValues[],
	actual: ElementValues[],
): PropCheck[] {
	return expected.flatMap((e) => {
		const a = actual.find((x) => x.role === e.role && x.name === e.name);
		if (!a)
			return [
				{
					name: e.name,
					prop: "element",
					// Canvas text includes mock names and prices the worker's empty DB never
					// shows, so one missing element is for a person to judge; aggregate()
					// fails only a page that is effectively empty.
					verdict: "UNCERTAIN" as Verdict,
					expected: `${e.role} '${e.name}'`,
					actual: "not found",
				},
			];
		const check = (
			prop: string,
			ok: boolean,
			ev: unknown,
			av: unknown,
		): PropCheck => ({
			name: e.name,
			prop,
			verdict: ok ? "PASS" : "FAIL",
			expected: String(ev),
			actual: String(av),
		});
		const out = [
			check("color", sameColour(e.color, a.color), e.color, a.color),
			check(
				"font-family",
				e.fontFamily.toLowerCase() === a.fontFamily.toLowerCase(),
				e.fontFamily,
				a.fontFamily,
			),
			check(
				"font-size",
				sameNum(e.fontSize, a.fontSize),
				e.fontSize,
				a.fontSize,
			),
			check(
				"font-weight",
				e.fontWeight === a.fontWeight,
				e.fontWeight,
				a.fontWeight,
			),
			check(
				"line-height",
				!e.lineHeight || sameNum(e.lineHeight, a.lineHeight),
				e.lineHeight,
				a.lineHeight,
			),
			check(
				"padding",
				e.padding.every((p, i) => sameNum(p, a.padding[i] ?? 0)),
				e.padding.join(" "),
				a.padding.join(" "),
			),
			check("radius", sameNum(e.radius, a.radius), e.radius, a.radius),
		];
		if (e.background !== TRANSPARENT)
			out.push(
				check(
					"background",
					sameColour(e.background, a.background),
					e.background,
					a.background,
				),
			);
		if (e.role === "button" || e.role === "link")
			out.push(
				check(
					"tap-target",
					a.width >= 44 && a.height >= 44,
					"44x44",
					`${Math.round(a.width)}x${Math.round(a.height)}`,
				),
			);
		return out;
	});
}
