export type Verdict = "PASS" | "FAIL" | "UNCERTAIN";
export interface ElementValues {
	role: string;
	name: string;
	color: string;
	background: string;
	fontFamily: string;
	fontSize: number;
	fontWeight: number;
	lineHeight: number;
	padding: number[];
	radius: number;
	width: number;
	height: number;
}
export interface PropCheck {
	name: string;
	prop: string;
	verdict: Verdict;
	expected: string;
	actual: string;
}
export interface DesignRef {
	link: string;
	route: string;
	persona: string;
	frames: string[];
}
export interface FrameMeta {
	name: string;
	width: number;
	height: number;
	source: "figma" | "canvas";
}
