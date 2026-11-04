import { one } from "./base.mjs";
export const inc = (n) => n + one();
export const selfTest = () => {
	if (inc(1) !== 2) throw new Error("inc");
};
