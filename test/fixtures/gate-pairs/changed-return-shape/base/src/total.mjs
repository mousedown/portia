import { parse } from "./parse.mjs";
export const total = (a, b) => parse(a) + parse(b);
export const selfTest = () => {
	if (total("1", "2") !== 3) throw new Error("total");
};
