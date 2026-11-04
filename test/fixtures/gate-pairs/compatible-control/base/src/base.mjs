export const one = () => 1;
export const selfTest = () => {
	if (one() !== 1) throw new Error("one");
};
