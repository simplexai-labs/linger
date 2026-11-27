// Abstention figures for the benchmark report. Accuracy alone cannot tell an
// arm that answers wrongly from one that declines: declining more raises the
// score on unanswerable questions and lowers it on answerable ones. Each side
// is reported, so a change that moves one at the cost of the other shows.
//
// Unanswerable questions need no extra call, because their judge prompt
// already asks whether the answer declined. An answerable question graded
// wrong gets one more judge call that separates a wrong answer from a declined
// one. A correct answer is never counted as declined.
import type { ModelCall } from "../../src/runtime-model-call.js";

const declinedPrompt = (question: string, answer: string) =>
  `I will give you a question and a response from a model. Decide whether the response declines to answer.

Set declined=true if the response gives no answer to the question: it says the information is unknown, unavailable, was not mentioned or recorded, or asks for the missing information instead of answering.
Set declined=false if the response commits to an answer, whether or not that answer is right, including an answer hedged with a caveat.

Question: ${question}

Model Response: ${answer}

First, provide a short (one sentence) explanation of your reasoning.`;

const DECLINED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["declined", "reason"],
  properties: {
    declined: { type: "boolean" },
    reason: { type: "string" },
  },
};

/** Whether an answer to an answerable question declined instead of answering. */
export async function judgeDeclined(
  modelCall: ModelCall,
  key: string,
  question: string,
  answer: string,
): Promise<{ declined: boolean; reason: string }> {
  const result = await modelCall.call({
    kind: "memory",
    key: `benchmark:declined:${key}`,
    effort: "low",
    input: declinedPrompt(question, answer),
    schemaName: "declined",
    outputSchema: DECLINED_SCHEMA,
  });
  const output = result.output as { declined: boolean; reason: string };
  return { declined: output.declined, reason: output.reason };
}

/**
 * Known-answer controls run before any grading, so a judge that cannot tell
 * a declined answer from a wrong one invalidates the run.
 */
export async function calibrateDeclinedJudge(
  modelCall: ModelCall,
): Promise<void> {
  const question = "When did Gina lose her job at Door Dash?";
  const controls: [string, boolean][] = [
    ["I do not have information about this.", true],
    ["Which Gina do you mean? I could not find a record of that.", true],
    ["July 2024", false],
    ["I am not fully sure, but I believe it was in July 2024.", false],
  ];
  for (const [index, [answer, expected]] of controls.entries()) {
    const { declined, reason } = await judgeDeclined(
      modelCall,
      `control:${index}`,
      question,
      answer,
    );
    if (declined !== expected)
      throw new Error(
        `The judge failed known-answer abstention control ${index} (${reason}); abstention figures would be invalid`,
      );
  }
}

/** What the abstention figures read from one stored answer. */
export interface AbstentionAnswer {
  unanswerable: boolean;
  judgment?: { correct: boolean };
  /** Set for an answerable question graded wrong. */
  declined?: { declined: boolean };
}

export interface AbstentionSummary {
  /** Answers to unanswerable questions, over all rounds. */
  unanswerable: number;
  /** Share of them that declined; null without unanswerable questions. */
  correct_abstention: number | null;
  /** Answers to answerable questions, over all rounds. */
  answerable: number;
  /**
   * Share of them that declined; null without answerable questions, or when
   * a wrong answer was stored before declined answers were told apart.
   */
  false_abstention: number | null;
}

/**
 * Whether an answer still needs a declined verdict: an answerable question
 * graded wrong whose verdict is missing, because the call failed or the answer
 * was stored before declined answers were told apart.
 */
export function needsDeclinedVerdict(answer: AbstentionAnswer): boolean {
  return (
    !answer.unanswerable &&
    answer.judgment?.correct === false &&
    !answer.declined
  );
}

/** An answer that failed before it was judged counts on neither side's numerator. */
export function summarizeAbstention(
  answers: readonly AbstentionAnswer[],
): AbstentionSummary {
  const unanswerable = answers.filter((answer) => answer.unanswerable);
  const answerable = answers.filter((answer) => !answer.unanswerable);
  const unclassified = answerable.some(
    (answer) => answer.judgment && !answer.judgment.correct && !answer.declined,
  );
  return {
    unanswerable: unanswerable.length,
    correct_abstention: unanswerable.length
      ? unanswerable.filter((answer) => answer.judgment?.correct).length /
        unanswerable.length
      : null,
    answerable: answerable.length,
    false_abstention:
      answerable.length && !unclassified
        ? answerable.filter(
            (answer) =>
              answer.judgment &&
              !answer.judgment.correct &&
              answer.declined?.declined,
          ).length / answerable.length
        : null,
  };
}
