import { makeUser } from "./user.mjs";
export const badge = (u) => `[${u.name}]`;
export const selfTest = () => {
	if (badge(makeUser("Ann")) !== "[Ann]") throw new Error("badge");
};
