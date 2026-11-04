import { parkedAnswer, readEvalAnswers } from "../../core/eval-answers";
import { EXIT, PortiaProblem } from "../../core/exit";
import { runDir, runPath } from "../../core/rundir";
import { appendRow } from "../../core/runlog";
import {
	answerQuestions,
	readQuestions,
	unanswered,
} from "../../questions/questions";
import type { Command } from "../main";
import { flag } from "./env";
import { signAmendment, signPlan, signSpecs } from "./signoff";

const USAGE =
	'usage: portia eval-answer go <PARENT> | plan <PARENT> --from <file> | specs <PARENT> [--child <SPINE> | --amend <KEY>] | questions <PARENT> | parked <KEY> --parent <PARENT> --question "<text>"';

/**
 * Answers in place of the person from the PORTIA_EVAL_ANSWERS script, for headless eval
 * runs. Exit 10 when the script is unset or leaves this answer out: ask the person as usual.
 * A scripted no to the plan, the specs or the go is exit 11: there is no one to redraft with.
 */
export const evalAnswerCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	if (!key) throw new PortiaProblem(USAGE);
	const script = readEvalAnswers();
	if (!script) {
		io.out("PORTIA_EVAL_ANSWERS is not set: ask the person");
		return EXIT.NOTHING;
	}
	const note = "scripted by PORTIA_EVAL_ANSWERS";
	switch (sub) {
		case "go": {
			if (!script.plan) return missing(io, "plan");
			io.out(JSON.stringify({ approve: script.plan.approve }));
			return script.plan.approve ? EXIT.OK : EXIT.PROBLEM;
		}
		case "plan": {
			const from = flag(args, "--from");
			if (!from) throw new PortiaProblem(USAGE);
			if (!script.plan) return missing(io, "plan");
			const row = await signPlan(key, from, {
				approved: script.plan.approve,
				by: "eval",
				note,
			});
			io.out(JSON.stringify(row));
			return script.plan.approve ? EXIT.OK : EXIT.PROBLEM;
		}
		case "specs": {
			if (!script.signoff) return missing(io, "signoff");
			const amend = flag(args, "--amend")?.toUpperCase();
			const scripted = {
				approved: script.signoff.approve,
				by: "eval" as const,
				note,
			};
			const row = amend
				? await signAmendment(key, amend, scripted)
				: await signSpecs(key, flag(args, "--child"), scripted);
			io.out(JSON.stringify(row));
			return script.signoff.approve ? EXIT.OK : EXIT.PROBLEM;
		}
		case "questions": {
			if (!script.parked) return missing(io, "parked");
			const dir = runPath(key);
			const qs = readQuestions(dir);
			if (!qs)
				throw new PortiaProblem(
					"no questions recorded: run portia questions first",
				);
			const open = unanswered(qs);
			const parked = script.parked;
			const answers = Object.fromEntries(
				open.map((q) => [q.id, parkedAnswer(parked, q.question)]),
			);
			if (open.length) answerQuestions(dir, answers);
			for (const q of open)
				appendRow(dir, {
					child: q.child ?? key,
					attempt: 0,
					stage: "decision",
					status: "answer",
					data: {
						kind: "question",
						by: "eval",
						answer: answers[q.id],
						why: q.question,
					},
				});
			io.out(JSON.stringify(answers));
			return EXIT.OK;
		}
		case "parked": {
			const parent = flag(args, "--parent")?.toUpperCase();
			const question = flag(args, "--question");
			if (!parent || !question) throw new PortiaProblem(USAGE);
			if (!script.parked) return missing(io, "parked");
			const answer = parkedAnswer(script.parked, question);
			appendRow(runDir(parent), {
				child: key,
				attempt: 0,
				stage: "decision",
				status: "answer",
				data: { kind: "parked", by: "eval", answer, why: question },
			});
			io.out(JSON.stringify({ answer }));
			return EXIT.OK;
		}
		default:
			throw new PortiaProblem(USAGE);
	}
};

function missing(io: { out(s: string): void }, section: string): number {
	io.out(`PORTIA_EVAL_ANSWERS has no ${section} answer: ask the person`);
	return EXIT.NOTHING;
}
