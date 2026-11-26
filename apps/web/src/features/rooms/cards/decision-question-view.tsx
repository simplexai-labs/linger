import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Clock01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";

import { AutoHeight } from "@/components/ui/auto-height";

import { CardBox, CardDone, CardHeading } from "./card-shell";
import { cardsMessages } from "./cards.messages";

import type { DecisionMessageCard } from "./decision-card";
import {
  formatExpiryCountdown,
  useDecisionExpiryClock,
} from "./decision-expiry";
import type { RoomCardDecision } from "./room-message-card-contract";

type InteractionQuestion = NonNullable<
  DecisionMessageCard["question"]
>["questions"][number];
type AnswerMap = Record<string, string | string[]>;

/** How long a chosen option stays lit before the card moves on. */
const choiceBeatMs = 140;

/**
 * A question card for its decision owner: the question as the card's bold
 * heading and its options as rows, one question at a time, with an "Other…"
 * row for an answer of their own. An open question is asked in a message
 * instead. Once settled,
 * the chat shows the answers as system lines and the card is gone.
 */
export function QuestionDecision({
  card,
  currentActorId,
  messageId,
  onDecision,
}: {
  card: DecisionMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
}) {
  const t = useT();
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [stepIndex, setStepIndex] = useState(0);
  // Fade a step in only once the card has moved, not when it first shows.
  const [stepped, setStepped] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const advanceTimerRef = useRef<number | null>(null);
  const advancingRef = useRef(false);
  const submittingRef = useRef(false);
  const pending = card.status === "pending";
  const now = useDecisionExpiryClock(card.expires_at, pending);
  const expired =
    pending &&
    card.expires_at !== undefined &&
    Date.parse(card.expires_at) <= now;
  const canDecide =
    pending && !expired && currentActorId === card.decision_owner.id;
  const countdown =
    pending && !expired ? formatExpiryCountdown(card.expires_at, now, t) : null;
  const questions: InteractionQuestion[] = card.question?.questions ?? [];
  const activeQuestion = questions[stepIndex];
  const isFinalStep = stepIndex >= questions.length - 1;
  const locked = submitting || advancing;

  function clearAdvanceTimer() {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    advancingRef.current = false;
    setAdvancing(false);
  }

  useEffect(() => {
    return () => {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
      advancingRef.current = false;
    };
  }, []);

  async function submit(nextAnswers: AnswerMap = answers) {
    if (submittingRef.current) return;
    clearAdvanceTimer();
    submittingRef.current = true;
    setDecisionError(null);
    setSubmitting(true);
    try {
      await onDecision({
        answers: nextAnswers,
        decision: "submit",
        expectedVersion: card.version,
        messageId,
        requestId: card.decision_id,
      });
    } catch (error) {
      setDecisionError(
        error instanceof Error
          ? error.message
          : translate(cardsMessages.cardDecisionFailed),
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // The chosen row lights up for a beat before the card moves on. Lock input
  // during that beat so rapid double-clicks cannot skip a step or double-submit.
  function selectRadio(question: InteractionQuestion, optionId: string) {
    if (advancingRef.current || submittingRef.current) return;
    const nextAnswers = { ...answers, [question.id]: optionId };
    setAnswers(nextAnswers);
    advancingRef.current = true;
    setAdvancing(true);
    const currentStep = stepIndex;
    const finalStep = isFinalStep;
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      advancingRef.current = false;
      setAdvancing(false);
      if (finalStep) {
        void submit(nextAnswers);
        return;
      }
      goToStep(currentStep + 1);
    }, choiceBeatMs);
  }

  function goToStep(next: number) {
    clearAdvanceTimer();
    setStepped(true);
    setStepIndex(Math.max(0, Math.min(next, questions.length - 1)));
  }

  function toggleCheckbox(question: InteractionQuestion, optionId: string) {
    if (advancingRef.current || submittingRef.current) return;
    const current = Array.isArray(answers[question.id])
      ? (answers[question.id] as string[])
      : [];
    setAnswers({
      ...answers,
      [question.id]: current.includes(optionId)
        ? current.filter((value) => value !== optionId)
        : [...current, optionId],
    });
  }

  // A written answer replaces a radio choice and joins checkbox choices.
  function writeAnswer(question: InteractionQuestion, text: string) {
    if (advancingRef.current || submittingRef.current) return;
    if (question.input !== "checkbox") {
      setAnswers({ ...answers, [question.id]: text });
      return;
    }
    const current = answers[question.id];
    const chosen = (Array.isArray(current) ? current : []).filter((item) =>
      isOptionId(question, item),
    );
    setAnswers({
      ...answers,
      [question.id]: text.trim() ? [...chosen, text] : chosen,
    });
  }

  if (!pending || !activeQuestion) return null;
  const value = answers[activeQuestion.id];
  const checkbox = activeQuestion.input === "checkbox";
  const written = writtenAnswer(activeQuestion, value).trim() !== "";
  const stepAnswered = hasAnswer(activeQuestion, value);

  function advanceOrSubmit() {
    if (locked || !stepAnswered) return;
    if (isFinalStep) {
      void submit();
      return;
    }
    goToStep(stepIndex + 1);
  }

  return (
    <CardBox label={t(cardsMessages.labelHumanInteraction)}>
      <AutoHeight>
        <div className={stepped ? "card-step-in" : undefined} key={stepIndex}>
          <CardHeading>{activeQuestion.prompt}</CardHeading>
          <div className="flex flex-col">
            {(activeQuestion.options ?? []).map((option) => (
              <ChoiceRow
                // A single choice moves on at once, so only multiple choices
                // keep a check.
                check={checkbox}
                disabled={locked || !canDecide}
                key={option.id}
                onSelect={
                  canDecide
                    ? () =>
                        checkbox
                          ? toggleCheckbox(activeQuestion, option.id)
                          : selectRadio(activeQuestion, option.id)
                    : undefined
                }
                selected={
                  Array.isArray(value)
                    ? value.includes(option.id)
                    : value === option.id
                }
              >
                {option.label}
              </ChoiceRow>
            ))}
            {canDecide ? (
              <OtherRow
                canSubmit={stepAnswered}
                disabled={locked}
                key={activeQuestion.id}
                onSubmit={advanceOrSubmit}
                onWrite={(text) => writeAnswer(activeQuestion, text)}
                question={activeQuestion}
                value={writtenAnswer(activeQuestion, value)}
              />
            ) : null}
          </div>
        </div>
        {expired ? (
          <CardDone
            icon={Clock01Icon}
            text={t(cardsMessages.expired)}
            tone="muted"
          />
        ) : canDecide ? (
          <>
            {countdown ? (
              <p className="flex items-center gap-1.5 pt-1 text-xs tabular-nums text-app-muted">
                <Icon className="shrink-0" icon={Clock01Icon} size={13} />
                <span>{countdown}</span>
              </p>
            ) : null}
            {questions.length > 1 || checkbox || written ? (
              <div className="flex items-center justify-between gap-2 pt-1 pb-1.5">
                <div className="flex items-center gap-0.5 text-xs text-app-muted">
                  {questions.length > 1 ? (
                    <>
                      <button
                        aria-label={t(cardsMessages.previousQuestion)}
                        className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-app-ink disabled:opacity-35"
                        disabled={stepIndex === 0 || locked}
                        onClick={() => goToStep(stepIndex - 1)}
                        type="button"
                      >
                        <Icon icon={ArrowLeft01Icon} size={14} />
                      </button>
                      <span className="tabular-nums">
                        {stepIndex + 1} / {questions.length}
                      </span>
                      <button
                        aria-label={t(cardsMessages.nextQuestion)}
                        className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-app-ink disabled:opacity-35"
                        disabled={locked || isFinalStep || !stepAnswered}
                        onClick={() => goToStep(stepIndex + 1)}
                        type="button"
                      >
                        <Icon icon={ArrowRight01Icon} size={14} />
                      </button>
                    </>
                  ) : checkbox ? (
                    <span>{t(cardsMessages.chooseAny)}</span>
                  ) : null}
                </div>
                {checkbox || written ? (
                  <Button
                    data-voice-risk={isFinalStep ? "never" : undefined}
                    disabled={locked || !stepAnswered}
                    onClick={advanceOrSubmit}
                    size="large"
                    tone="primary"
                  >
                    {t(isFinalStep ? cardsMessages.send : cardsMessages.next)}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardDone
              icon={Clock01Icon}
              text={t(cardsMessages.waitingForAnswer, {
                name: card.decision_owner.display_name,
              })}
              tone="muted"
            />
            {countdown ? (
              <span className="pb-0.5 text-xs tabular-nums text-app-muted">
                {countdown}
              </span>
            ) : null}
          </div>
        )}
        {decisionError ? (
          <p className="pb-1.5 text-xs text-app-danger">{decisionError}</p>
        ) : null}
      </AutoHeight>
    </CardBox>
  );
}

/**
 * The "Other…" row: a muted row that becomes a field for the Human's own
 * answer once clicked, in place of a radio choice or beside checkbox picks.
 */
function OtherRow({
  canSubmit,
  disabled,
  onSubmit,
  onWrite,
  question,
  value,
}: {
  canSubmit: boolean;
  disabled?: boolean;
  onSubmit: () => void;
  onWrite: (text: string) => void;
  question: InteractionQuestion;
  value: string;
}) {
  const t = useT();
  const [writing, setWriting] = useState(value !== "");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (writing) field.current?.focus();
  }, [writing]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      if (!disabled && canSubmit) {
        onSubmit();
      }
    } else if (event.key === "Escape" && value.trim() === "") {
      event.preventDefault();
      setWriting(false);
    }
  }

  if (!writing) {
    return (
      <button
        className="question-choice question-choice-other"
        disabled={disabled}
        onClick={() => setWriting(true)}
        type="button"
      >
        {t(cardsMessages.other)}
      </button>
    );
  }
  return (
    <label className="question-choice question-choice-writing">
      <input
        aria-label={t(cardsMessages.ownAnswerTo, {
          question: question.prompt,
        })}
        className="min-w-0 flex-1 bg-transparent text-sm text-app-ink outline-none placeholder:text-app-placeholder"
        disabled={disabled}
        maxLength={question.input === "checkbox" ? 200 : 10000}
        onChange={(event) => onWrite(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t(cardsMessages.ownAnswer)}
        ref={field}
        value={value}
      />
    </label>
  );
}

function isOptionId(question: InteractionQuestion, value: string) {
  return (question.options ?? []).some((option) => option.id === value);
}

/** The part of an answer that names no option: the Human's own words. */
function writtenAnswer(
  question: InteractionQuestion,
  value: string | string[] | undefined,
) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.find((item) => !isOptionId(question, item)) ?? "";
}

/**
 * An option is a full-width row that tints under the pointer; on a multiple
 * choice question a check marks it chosen.
 */
function ChoiceRow({
  check,
  children,
  disabled,
  onSelect,
  selected,
}: {
  /** Mark a chosen row with a check; only multiple-choice picks stay. */
  check: boolean;
  children: string;
  disabled?: boolean;
  onSelect?: () => void;
  selected: boolean;
}) {
  const className = `question-choice ${selected ? "question-choice-selected" : ""}`;
  const content = (
    <>
      <span className="min-w-0">{children}</span>
      {check && selected ? (
        <Icon className="question-choice-check" icon={Tick02Icon} size={16} />
      ) : null}
    </>
  );
  if (!onSelect) {
    return (
      <div className={`${className} question-choice-readonly`}>{content}</div>
    );
  }
  return (
    <button
      aria-pressed={selected}
      className={className}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      {content}
    </button>
  );
}

function hasAnswer(
  question: InteractionQuestion,
  value: string | string[] | undefined,
) {
  return question.input === "checkbox"
    ? Array.isArray(value) && value.length > 0
    : typeof value === "string" && value.trim() !== "";
}
