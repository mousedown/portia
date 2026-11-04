import { one } from "./base.mjs";
export const dec = (n) => n - one();
export const selfTest = () => {
	if (dec(2) !== 1) throw new Error("dec");
};
