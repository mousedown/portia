// The fixture profile with generated output declared, for the ripple scenarios. Test globs
// are left out so the defaults apply.
import base from "../fixtures/profile";

export default {
	...base,
	ripple: { generated: ["packages/acme-web/src/generated/**"] },
};
