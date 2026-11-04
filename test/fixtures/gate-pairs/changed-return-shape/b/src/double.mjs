import { parse } from "./parse.mjs";
export const double = (s) => parse(s) * 2;
export const selfTest = () => {
	if (double("4") !== 8) throw new Error("double");
};
