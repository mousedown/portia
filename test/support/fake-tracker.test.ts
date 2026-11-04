import { type ContractGraph, trackerContract } from "../plan/tracker-contract";

const graph: ContractGraph = {
	parent: "ACME-500",
	children: {
		"ACME-501": [],
		"ACME-502": ["ACME-501"],
		"ACME-503": ["ACME-501"],
		"ACME-504": ["ACME-501"],
		"ACME-505": ["ACME-502", "ACME-503"],
	},
	missingKey: "ACME-999999",
	writeKey: "ACME-501",
	linkPair: ["ACME-503", "ACME-504"],
};

import { FakeTracker } from "./fake-tracker";

function seeded(): FakeTracker {
	const t = new FakeTracker().add({
		key: graph.parent,
		summary: "parent",
		description: "",
		blockedBy: [],
	});
	for (const [key, blockedBy] of Object.entries(graph.children))
		t.add(
			{
				key,
				summary: key,
				description: `Intro.\n\n\`\`\`plan\nwave: 0\n\`\`\`\n\nTrailing note.\n`,
				blockedBy,
			},
			graph.parent,
		);
	return t;
}

trackerContract("FakeTracker", graph, () => {
	const tracker = seeded();
	return { tracker, writes: () => tracker.writes.length };
});
