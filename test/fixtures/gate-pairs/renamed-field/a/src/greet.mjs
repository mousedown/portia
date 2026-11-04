import { makeUser } from "./user.mjs";
export const greet = (u) => `hello ${u.fullName}`;
export const selfTest = () => {
	if (greet(makeUser("Ann")) !== "hello Ann") throw new Error("greet");
};
