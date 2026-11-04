export const minutesBetween = (a: Date | string, b: Date | string): number =>
	(new Date(b).getTime() - new Date(a).getTime()) / 60_000;

export const mean = (xs: number[]): number =>
	xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Sample standard deviation; 0 for fewer than two values. */
export const sd = (xs: number[]): number => {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

/** A 95% confidence interval on the mean, t-distribution for small n (n ≤ 30 table, else 1.96). */
export function ci95(xs: number[]): [number, number] {
	const m = mean(xs);
	if (xs.length < 2) return [m, m];
	const t = T95[xs.length - 1] ?? 1.96;
	const h = (t * sd(xs)) / Math.sqrt(xs.length);
	return [m - h, m + h];
}
const T95 = [
	0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
	2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08,
	2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];
