const pad2 = (n: number) => String(n).padStart(2, "0");

export function tokens(n?: number): string {
	if (n === undefined) return "—";
	if (n < 1000) return String(n);
	if (n < 999_500) return `${Math.round(n / 1000)}k`;
	return `${(n / 1e6).toFixed(2)}M`;
}

/** Tokens to a tenth of a thousand: 842, 599.1k, 1.28M. */
export function tokensFine(n: number): string {
	if (n < 1000) return String(n);
	if (n < 999_950) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1e6).toFixed(2)}M`;
}

/** A span in its two largest units, no spaces: 42s, 1m40s, 37m32s, 4h12m, 1d4h. */
export function span(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (s < 3600) return `${m}m${pad2(s % 60)}s`;
	const h = Math.floor(s / 3600);
	if (s < 86_400) return `${h}h${pad2(m % 60)}m`;
	return `${Math.floor(s / 86_400)}d${h % 24}h`;
}

/** A running or elapsed clock: 42s, 12m 04s, 1h 12m, 2d 3h (12:04, 1h12, 2d3h narrow). */
export function clock(ms: number, narrow = false): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (s < 3600)
		return narrow ? `${m}:${pad2(s % 60)}` : `${m}m ${pad2(s % 60)}s`;
	const h = Math.floor(s / 3600);
	if (s < 86_400)
		return narrow ? `${h}h${pad2(m % 60)}` : `${h}h ${pad2(m % 60)}m`;
	const d = Math.floor(s / 86_400);
	return narrow ? `${d}d${h % 24}h` : `${d}d ${h % 24}h`;
}

/** An age in its largest whole unit: 12s, 4m, 3h, 2d. */
export function age(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86_400)}d`;
}

/** Local time of day: HH:MM:SS, or HH:MM. */
export function hhmm(at: string | number, seconds = false): string {
	const d = new Date(at);
	if (Number.isNaN(d.getTime())) return seconds ? "--:--:--" : "--:--";
	const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	return seconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** "Oct 20 09:12", in local time. */
export function monthDay(at: string, time = true): string {
	const d = new Date(at);
	if (Number.isNaN(d.getTime())) return "";
	const day = `${MONTHS[d.getMonth()]} ${pad2(d.getDate())}`;
	return time ? `${day} ${hhmm(at)}` : day;
}

/** One space between letters and three between words. */
export const letterSpace = (s: string): string =>
	s
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => [...w].join(" "))
		.join("   ");

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** True when `at` falls on the same local day as `now`. */
export const isToday = (at: string, now: number): boolean =>
	dayKey(new Date(at)) === dayKey(new Date(now));

export function dayLabel(at: string, now: number): string {
	const d = new Date(at);
	const today = new Date(now);
	if (dayKey(d) === dayKey(today)) return letterSpace("TODAY");
	const y = new Date(now);
	y.setDate(y.getDate() - 1);
	if (dayKey(d) === dayKey(y)) return letterSpace("YESTERDAY");
	return letterSpace(monthDay(at, false).toUpperCase());
}

export const ms = (at?: string): number => (at ? Date.parse(at) : Number.NaN);
