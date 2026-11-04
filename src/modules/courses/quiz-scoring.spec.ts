import { scoreAttempt, type StoredQuestion } from "./quiz-scoring";

const q = (id: string, kind: "SINGLE" | "MULTIPLE", correct: string[], all = ["a", "b", "c", "d"]): StoredQuestion => ({ id, kind, options: all.map((o) => ({ id: o, text: o })), correct });

describe("scoreAttempt", () => {
  const questions = [q("q1", "SINGLE", ["a"]), q("q2", "MULTIPLE", ["a", "c"]), q("q3", "SINGLE", ["d"]), q("q4", "MULTIPLE", ["b"])];

  it("scores floor(100 x correct questions / total)", () => {
    expect(scoreAttempt(questions, [{ questionId: "q1", optionIds: ["a"] }, { questionId: "q2", optionIds: ["c", "a"] }, { questionId: "q3", optionIds: ["a"] }]).scorePct).toBe(50);
    expect(scoreAttempt(questions.slice(0, 3), [{ questionId: "q1", optionIds: ["a"] }]).scorePct).toBe(33); // floor(33.3)
    expect(scoreAttempt(questions, questions.map((x) => ({ questionId: x.id, optionIds: x.correct }))).scorePct).toBe(100);
  });

  it("a multiple-choice question needs the exact set: a subset or a superset is wrong", () => {
    const only = [q("m", "MULTIPLE", ["a", "c"])];
    expect(scoreAttempt(only, [{ questionId: "m", optionIds: ["a"] }]).scorePct).toBe(0);
    expect(scoreAttempt(only, [{ questionId: "m", optionIds: ["a", "b", "c"] }]).scorePct).toBe(0);
    expect(scoreAttempt(only, [{ questionId: "m", optionIds: ["c", "a"] }]).scorePct).toBe(100);
  });

  it("unanswered questions are wrong; unknown ids, duplicates and several options for a single-choice question are rejected", () => {
    expect(scoreAttempt(questions, []).scorePct).toBe(0);
    expect(() => scoreAttempt(questions, [{ questionId: "nope", optionIds: ["a"] }])).toThrow(/QUIZ_ANSWER_INVALID|answer/i);
    expect(() => scoreAttempt(questions, [{ questionId: "q1", optionIds: ["zzz"] }])).toThrow();
    expect(() => scoreAttempt(questions, [{ questionId: "q1", optionIds: ["a"] }, { questionId: "q1", optionIds: ["a"] }])).toThrow();
    expect(() => scoreAttempt(questions, [{ questionId: "q1", optionIds: ["a", "b"] }])).toThrow();
    expect(() => scoreAttempt(questions, [{ questionId: "q2", optionIds: ["a", "a"] }])).toThrow();
  });
});
