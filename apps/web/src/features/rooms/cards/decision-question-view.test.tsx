import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { getTranslation } from "@/i18n/language";

import type { DecisionMessageCard } from "./decision-card";
import { cardNoticeLines, settledCardNotice } from "./card-notice";
import { QuestionDecision } from "./decision-question-view";

const assignee = {
  display_name: "mallory",
  id: "actor_other_mallory",
  kind: "human" as const,
};

function questionsCard(
  status: "pending" | "answered" | "expired",
): DecisionMessageCard {
  const question = {
    questions: [
      {
        id: "hobby",
        input: "radio" as const,
        options: [
          { id: "walk", label: "Go for a walk" },
          { id: "home", label: "Rest at home" },
        ],
        prompt: "What would you rather do this weekend?",
      },
      {
        id: "day",
        input: "radio" as const,
        options: [
          { id: "sat", label: "Saturday" },
          { id: "sun", label: "Sunday" },
        ],
        prompt: "Which day?",
      },
    ],
  };
  const common = {
    card_type: "personal_notice" as const,
    decision_id: "decision-1",
    decision_owner: assignee,
    intent: "decision_requested" as const,
    kind: "question" as const,
    question,
    requester: {
      display_name: "Another Me",
      id: "actor_agent",
      kind: "agent" as const,
    },
    title: "Please answer a few easy questions.",
  };
  if (status === "pending") {
    return { ...common, status: "pending", version: 1 };
  }
  if (status === "expired") {
    return { ...common, status: "expired", version: 2 };
  }
  return {
    ...common,
    answer: {
      answers: { day: "sat", hobby: "walk" },
      decision: "submit",
    },
    decided_at: "2026-08-20T07:00:00Z",
    decided_by: assignee,
    status: "answered",
    version: 2,
  };
}

/** The system lines a settled card becomes, as the reader sees them. */
function noticeLines(
  card: Parameters<typeof settledCardNotice>[0],
  viewerId: string,
) {
  const notice = settledCardNotice(card, viewerId);
  return (
    notice &&
    cardNoticeLines(notice, getTranslation()).map((line) =>
      line.parts.map((part) => part.text).join(""),
    )
  );
}

describe("QuestionDecision", () => {
  function renderCard(
    card: DecisionMessageCard,
    onDecision: (decision: unknown) => void = vi.fn(),
  ) {
    return render(
      <QuestionDecision
        card={card}
        currentActorId={assignee.id}
        messageId="message-1"
        onDecision={onDecision}
      />,
    );
  }

  it("puts the question in the box as its heading, with plain option rows", async () => {
    const onDecision = vi.fn();
    renderCard(questionsCard("pending"), onDecision);
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "What would you rather do this weekend?",
      }),
    ).toBeVisible();
    // Options carry no letter keys.
    expect(screen.queryByText("A")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go for a walk" }));
    // The chosen row stays lit for a beat before the next question.
    expect(
      await screen.findByRole("heading", { name: "Which day?" }),
    ).toBeVisible();
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Saturday" }));
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalled());
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { day: "sat", hobby: "walk" },
        decision: "submit",
      }),
    );
  });

  it("takes an answer of their own through Other… in place of an option", async () => {
    const onDecision = vi.fn();
    renderCard(questionsCard("pending"), onDecision);
    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Your own answer to What would you rather do this weekend?",
      }),
      { target: { value: "Go hiking" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Sunday" }));
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalled());
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { day: "sun", hobby: "Go hiking" } }),
    );
  });

  it("lets a multiple choice pick any options and add its own before sending", () => {
    const onDecision = vi.fn();
    const card = questionsCard("pending");
    renderCard(
      {
        ...card,
        question: {
          questions: [
            {
              id: "sides",
              input: "checkbox",
              options: [
                { id: "egg", label: "Egg" },
                { id: "tofu", label: "Tofu" },
              ],
              prompt: "Sides?",
            },
          ],
        },
      },
      onDecision,
    );
    expect(screen.getByText("Choose any")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Egg" }));
    expect(screen.getByRole("button", { name: "Egg" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Your own answer to Sides?" }),
      { target: { value: "Kimchi" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { sides: ["egg", "Kimchi"] } }),
    );
  });

  it("leaves nothing once answered; each answer becomes a system line", () => {
    const card = questionsCard("answered");
    const { container } = renderCard(card);
    expect(container).toBeEmptyDOMElement();
    expect(noticeLines(card, assignee.id)).toEqual([
      "You answered “What would you rather do this weekend?” with “Go for a walk”",
      "You answered “Which day?” with “Saturday”",
    ]);
  });

  it("names someone else who answered, and keeps a note and their own words", () => {
    const card = questionsCard("answered");
    expect(
      noticeLines(
        {
          ...card,
          answer: {
            answers: { day: "sun", hobby: "Go hiking" },
            comment: "Back by six.",
            decision: "submit",
          },
        },
        "someone-else",
      ),
    ).toEqual([
      "mallory answered “What would you rather do this weekend?” with “Go hiking”",
      "mallory answered “Which day?” with “Sunday”",
      "mallory added “Back by six.”",
    ]);
  });

  it("says an expired question went unanswered", () => {
    expect(noticeLines(questionsCard("expired"), assignee.id)).toEqual([
      "No one answered “Please answer a few easy questions.” in time",
    ]);
  });

  it("keeps a waiting question a card", () => {
    expect(settledCardNotice(questionsCard("pending"), assignee.id)).toBeNull();
  });

  it("guards rapid double-clicks on radio options and cleans up timers on unmount", () => {
    vi.useFakeTimers();
    try {
      const onDecision = vi.fn();
      const { unmount } = renderCard(questionsCard("pending"), onDecision);

      const walk = screen.getByRole("button", { name: "Go for a walk" });
      fireEvent.click(walk);
      fireEvent.click(walk);
      expect(walk).toBeDisabled();

      act(() => {
        vi.advanceTimersByTime(140);
      });
      expect(screen.getByRole("heading", { name: "Which day?" })).toBeVisible();
      expect(onDecision).not.toHaveBeenCalled();

      const saturday = screen.getByRole("button", { name: "Saturday" });
      fireEvent.click(saturday);
      fireEvent.click(saturday);
      act(() => {
        vi.advanceTimersByTime(140);
      });
      expect(onDecision).toHaveBeenCalledTimes(1);

      // Unmounting during the radio beat cancels the pending timer.
      unmount();
      const onDecisionAfterUnmount = vi.fn();
      const singleStep = renderCard(
        {
          ...questionsCard("pending"),
          question: {
            questions: [questionsCard("pending").question!.questions[1]!],
          },
        },
        onDecisionAfterUnmount,
      );
      fireEvent.click(screen.getByRole("button", { name: "Sunday" }));
      singleStep.unmount();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(onDecisionAfterUnmount).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits or advances Other… on non-IME Enter and collapses empty Other… on Escape", () => {
    const onDecision = vi.fn();
    renderCard(questionsCard("pending"), onDecision);

    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    const firstInput = screen.getByRole("textbox", {
      name: "Your own answer to What would you rather do this weekend?",
    });
    fireEvent.keyDown(firstInput, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Other…" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    const reopened = screen.getByRole("textbox", {
      name: "Your own answer to What would you rather do this weekend?",
    });
    fireEvent.change(reopened, { target: { value: "Read a book" } });
    fireEvent.keyDown(reopened, {
      isComposing: true,
      key: "Enter",
      keyCode: 229,
    });
    expect(
      screen.queryByRole("heading", { name: "Which day?" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(reopened, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Which day?" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    const secondInput = screen.getByRole("textbox", {
      name: "Your own answer to Which day?",
    });
    fireEvent.change(secondInput, { target: { value: "Friday evening" } });
    fireEvent.keyDown(secondInput, { key: "Enter" });
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { day: "Friday evening", hobby: "Read a book" },
        decision: "submit",
      }),
    );
  });

  it("tells non-owners who needs to answer", () => {
    render(
      <QuestionDecision
        card={questionsCard("pending")}
        currentActorId="someone-else"
        messageId="message-1"
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("Waiting for mallory to answer")).toBeVisible();
  });
});
