import { AppError } from "../../common/errors/app-error";

export interface StoredOption {
  id: string;
  text: string;
}

/** A question as stored: option ids are stable, `correct` lists the right ones. */
export interface StoredQuestion {
  id: string;
  kind: "SINGLE" | "MULTIPLE";
  options: StoredOption[];
  correct: string[];
}

export interface GivenAnswer {
  questionId: string;
  optionIds: string[];
}

const invalid = (message: string) => new AppError("QUIZ_ANSWER_INVALID", 422, message);

/**
 * Score = floor(100 x correct questions / total questions). A question is correct only when the chosen option ids are exactly the
 * correct set (a subset or a superset is wrong; single choice is the same rule with a set of one). An unanswered question is wrong.
 * Answers that name a question or option the quiz does not have, repeat a question or an option, or pick several options for a
 * single-choice question are rejected rather than scored.
 */
export function scoreAttempt(questions: StoredQuestion[], answers: GivenAnswer[]): { scorePct: number; correctCount: number } {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const given = new Map<string, Set<string>>();
  for (const a of answers) {
    const question = byId.get(a.questionId);
    if (!question) throw invalid("An answer refers to a question that is not in this quiz");
    if (given.has(a.questionId)) throw invalid("A question can be answered only once per attempt");
    const chosen = new Set(a.optionIds);
    if (chosen.size !== a.optionIds.length) throw invalid("An option can be chosen only once");
    const valid = new Set(question.options.map((o) => o.id));
    if (a.optionIds.some((id) => !valid.has(id))) throw invalid("An answer refers to an option that is not part of the question");
    if (question.kind === "SINGLE" && chosen.size > 1) throw invalid("A single-choice question takes exactly one option");
    given.set(a.questionId, chosen);
  }
  let correctCount = 0;
  for (const q of questions) {
    const chosen = given.get(q.id);
    if (chosen && chosen.size === q.correct.length && q.correct.every((id) => chosen.has(id))) correctCount += 1;
  }
  return { scorePct: questions.length === 0 ? 0 : Math.floor((100 * correctCount) / questions.length), correctCount };
}

/** A question row as the scorer and the views need it (Json columns narrowed). */
export function toStoredQuestion(row: { id: string; kind: "SINGLE" | "MULTIPLE"; options: unknown; correct: unknown }): StoredQuestion {
  return { id: row.id, kind: row.kind, options: row.options as StoredOption[], correct: row.correct as string[] };
}
