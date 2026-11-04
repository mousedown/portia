import { makeUser } from "./user.mjs";
export const greet = (u) => `hello ${u.name}`;
export const selfTest = () => {
	if (greet(makeUser("Ann")) !== "hello Ann") throw new Error("greet");
};
