import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineGlobalProperty } from "@/test/global-properties";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceCaptureQuestion } from "@/features/teamhub/teamhub-types";
import {
  openVoicePip,
  resetVoicePipForTest,
} from "../chat/voice-mode/voice-pip";
import RecordingWindow, { pinchedPlacement } from "./recording-window";
import { RecordingEntry } from "./recording-entry";
import {
  openRecordingWindow,
  resetRecordingWindowForTest,
  useRecordingWindow,
} from "./recording-window-store";
import {
  VoiceControlContext,
  type VoiceControlContextValue,
} from "./voice-control-context";

const capture = {
  created_at: "2026-10-12T02:00:00Z",
  gap_count: 0,
  gap_duration_ms: 0,
  id: "capture-1",
  requested_start_offset_ms: 60_000,
  room_id: "room-1",
  status: "recording" as const,
  updated_at: "2026-10-12T02:00:00Z",
  voice_session_id: "voice-session-1",
};

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function voiceValue(
  overrides: Partial<VoiceControlContextValue> = {},
): VoiceControlContextValue {
  return {
    acquireComposerMicrophone: vi.fn(async () => async () => undefined),
    boundDevice: { deviceId: "mic", groupId: "group", label: "Mic" },
    captureSyncStatus: "live",
    captureState: { status: "recording", capture },
    composerMicrophoneActive: false,
    connectDevice: vi.fn(async () => undefined),
    devices: [],
    discoverDevices: vi.fn(async () => []),
    disconnectDevice: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    enable: vi.fn(async () => undefined),
    leavePage: vi.fn(async () => undefined),
    listenerStatus: "listening",
    selectedDeviceId: "mic",
    microphoneMuted: false,
    setMicrophoneMuted: vi.fn(async () => undefined),
    selectDevice: vi.fn(async () => undefined),
    startCapture: vi.fn(async () => undefined),
    startNewCapture: vi.fn(async () => undefined),
    stopCapture: vi.fn(async () => undefined),
    targetAgentName: "Another Me",
    transcriptItems: [],
    transcriptStatus: "live",
    ...overrides,
  };
}

function api() {
  const base = createTestTeamHubRuntime();
  const asked: TeamHubVoiceCaptureQuestion[] = [];
  const routes = {
    sendVoiceCaptureQuestionTask: vi.fn(
      async (_id: string, questionId: string) => {
        const request = asked.find((each) => each.id === questionId)!;
        request.sent_message_id = "message-2";
        return structuredClone(request);
      },
    ),
    listVoiceCaptureQuestions: vi.fn(async () => ({
      items: structuredClone(asked),
    })),
    askVoiceCaptureQuestion: vi.fn(
      async (
        _id: string,
        question: string,
      ): Promise<TeamHubVoiceCaptureQuestion> => {
        // The recording's Agent hears "Help me…" as a request for Another Me.
        if (question.startsWith("Help me")) {
          const request: TeamHubVoiceCaptureQuestion = {
            id: `q${asked.length + 1}`,
            kind: "task",
            question,
            answer: "",
            answered: true,
            task_title: "Draft the pricing email",
            cutoff_offset_ms: 185_000,
            sources: [],
            created_at: "2026-10-12T02:03:00Z",
          };
          asked.push(request);
          return structuredClone(request);
        }
        const answer: TeamHubVoiceCaptureQuestion = {
          id: `q${asked.length + 1}`,
          kind: "answer",
          question,
          answer: "Budget is 200k.",
          answered: true,
          cutoff_offset_ms: 185_000,
          sources: [
            {
              start_offset_ms: 125_000,
              end_offset_ms: 130_000,
              text: "We settle on 200k.",
            },
          ],
          created_at: "2026-10-12T02:03:00Z",
        };
        asked.push(answer);
        return answer;
      },
    ),
  };
  base.server
    .on(
      "POST",
      "/v0/voice-captures/{captureSessionId}/questions/{questionId}/task",
      ({ params }) =>
        routes.sendVoiceCaptureQuestionTask(
          params.captureSessionId!,
          params.questionId!,
        ),
    )
    .on("GET", "/v0/voice-captures/{captureSessionId}/questions", () =>
      routes.listVoiceCaptureQuestions(),
    )
    .on(
      "POST",
      "/v0/voice-captures/{captureSessionId}/questions",
      ({ params, body }) =>
        routes.askVoiceCaptureQuestion(
          params.captureSessionId!,
          (body as { question: string }).question,
        ),
    );
  return { runtime: base, routes };
}

function WindowState() {
  const state = useRecordingWindow();
  return (
    <span data-testid="window-state">
      {state.open ? (state.minimized ? "minimized" : "open") : "closed"}
      {state.autoStart ? ":autostart" : ""}
      {state.ending ? ":ending" : ""}
    </span>
  );
}

function renderWindow(
  voice: VoiceControlContextValue,
  {
    tenantId,
    showEntry = false,
  }: { tenantId?: string; showEntry?: boolean } = {},
) {
  const { runtime, routes } = api();
  const queryClient = new QueryClient();
  const content = (value: VoiceControlContextValue) => (
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceControlContext value={value}>
          <RecordingWindow />
          <WindowState />
          {showEntry ? (
            <RecordingEntry anotherMeRoomId="room-1" tenantId="tenant-1" />
          ) : null}
        </VoiceControlContext>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
  // Inside a tenant route the window can link a created Task.
  const tree = (value: VoiceControlContextValue) =>
    tenantId ? (
      <MemoryRouter initialEntries={[`/t/${tenantId}/rooms/room-1/chat`]}>
        <Routes>
          <Route element={content(value)} path="/t/:tenantId/*" />
        </Routes>
      </MemoryRouter>
    ) : (
      content(value)
    );
  const view = render(tree(voice));
  return {
    routes,
    rerender: (value: VoiceControlContextValue) => view.rerender(tree(value)),
    unmount: view.unmount,
  };
}

beforeEach(() => {
  resetRecordingWindowForTest();
  resetVoicePipForTest();
  openRecordingWindow();
});
afterEach(() => {
  // Unmount portals before removing their picture-in-picture documents.
  cleanup();
  Reflect.deleteProperty(window, "documentPictureInPicture");
  Reflect.deleteProperty(window, "lingerDesktop");
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
});

function askInWindow(text: string) {
  const box = screen.getByRole("textbox", {
    name: "Ask about this recording",
  });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

describe("Recording window", () => {
  it("does not retry a failed question from the previous recording", async () => {
    const { routes, rerender } = renderWindow(voiceValue());
    routes.askVoiceCaptureQuestion.mockRejectedValueOnce(new Error("offline"));
    const ask = screen.getByRole("textbox", {
      name: "Ask about this recording",
    });
    fireEvent.change(ask, { target: { value: "Only recording A?" } });
    fireEvent.keyDown(ask, { key: "Enter" });
    await screen.findByRole("button", { name: "Retry" });
    rerender(
      voiceValue({
        captureState: {
          status: "recording",
          capture: { ...capture, id: "capture-2" },
        },
      }),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("Only recording A?")).toBeNull();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
      {
        target: { value: "Only recording B?" },
      },
    );
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
      { key: "Enter" },
    );
    await waitFor(() =>
      expect(routes.askVoiceCaptureQuestion).toHaveBeenLastCalledWith(
        "capture-2",
        "Only recording B?",
      ),
    );
  });

  it.each(["success", "failure"] as const)(
    "keeps the current question pending after a late %s from another recording",
    async (outcome) => {
      const { routes, rerender } = renderWindow(voiceValue());
      const old = pending<TeamHubVoiceCaptureQuestion>();
      const current = pending<TeamHubVoiceCaptureQuestion>();
      routes.askVoiceCaptureQuestion
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const ask = () =>
        screen.getByRole("textbox", { name: "Ask about this recording" });
      fireEvent.change(ask(), { target: { value: "Only A?" } });
      fireEvent.keyDown(ask(), { key: "Enter" });
      rerender(
        voiceValue({
          captureState: {
            status: "recording",
            capture: { ...capture, id: "capture-2" },
          },
        }),
      );
      fireEvent.change(ask(), { target: { value: "Only B?" } });
      fireEvent.keyDown(ask(), { key: "Enter" });
      await waitFor(() =>
        expect(routes.askVoiceCaptureQuestion).toHaveBeenCalledTimes(2),
      );
      const answer = (question: string): TeamHubVoiceCaptureQuestion => ({
        id: question,
        kind: "answer",
        question,
        answer: "Recorded answer",
        answered: true,
        cutoff_offset_ms: 185_000,
        sources: [],
        created_at: capture.created_at,
      });
      await act(async () => {
        if (outcome === "success") old.resolve(answer("Only A?"));
        else old.reject(new Error("offline"));
      });
      expect(screen.getByText("Only B?")).toBeVisible();
      expect(screen.getByText("Answering…")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      await act(async () => current.resolve(answer("Only B?")));
      expect(screen.queryByText("Answering…")).toBeNull();
      expect(routes.askVoiceCaptureQuestion.mock.calls).toEqual([
        ["capture-1", "Only A?"],
        ["capture-2", "Only B?"],
      ]);
    },
  );

  it("keeps an unsent question draft inside its recording", async () => {
    const { routes, rerender } = renderWindow(voiceValue());
    fireEvent.change(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
      {
        target: { value: "Question draft A" },
      },
    );
    rerender(
      voiceValue({
        captureState: {
          status: "recording",
          capture: { ...capture, id: "capture-2" },
        },
      }),
    );
    expect(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
    ).toHaveValue("");
    expect(routes.askVoiceCaptureQuestion).not.toHaveBeenCalled();
  });

  it("keeps one microphone start when its new Capture identity arrives", async () => {
    openRecordingWindow({ autoStart: true });
    const start = pending<void>();
    const voice = voiceValue({
      captureState: { status: "idle" },
      startCapture: vi.fn(() => start.promise),
    });
    const { rerender } = renderWindow(voice);
    const collapse = screen.getByRole("button", { name: "Minimize recording" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("log")).toBeNull();
    await waitFor(() => expect(voice.startCapture).toHaveBeenCalledTimes(1));
    rerender({ ...voice, captureState: { status: "starting", capture } });
    await act(async () => start.resolve());
    rerender({ ...voice, captureState: { status: "recording", capture } });
    expect(screen.getByRole("button", { name: "Open recording" })).toBe(
      collapse,
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    fireEvent.click(collapse);
    expect(screen.getByRole("tab", { name: "Transcript" })).toBeVisible();
    expect(voice.startCapture).toHaveBeenCalledTimes(1);
    expect(voice.startNewCapture).not.toHaveBeenCalled();
    expect(voice.leavePage).not.toHaveBeenCalled();
    expect(voice.stopCapture).not.toHaveBeenCalled();
  });

  it("opens on the full transcript with the question box below", () => {
    renderWindow(voiceValue());
    // Notes are gone: only the transcript and Ask remain, and no full screen.
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Transcript",
      "Ask",
    ]);
    expect(screen.queryByRole("button", { name: /full screen/i })).toBeNull();
    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("log", { name: "Voice focus transcript" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
    ).toBeInTheDocument();
    // Tasks are sent from any chat while the window floats; it has no task button.
    expect(screen.queryByRole("button", { name: /task/i })).toBeNull();
  });

  it("answers a question from the meeting and shows it under Ask", async () => {
    const { routes } = renderWindow(voiceValue());
    const ask = screen.getByRole("textbox", {
      name: "Ask about this recording",
    });
    fireEvent.change(ask, { target: { value: "How was the budget settled?" } });
    fireEvent.keyDown(ask, { key: "Enter" });
    expect(screen.getByRole("tab", { name: "Ask" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const answers = screen.getByRole("list", {
      name: "Answers about this recording",
    });
    expect(await within(answers).findByText("Budget is 200k.")).toBeVisible();
    expect(routes.askVoiceCaptureQuestion).toHaveBeenCalledWith(
      "capture-1",
      "How was the budget settled?",
    );
    // Session offsets are shown from the start of this recording.
    expect(
      within(answers).getByText("Based on the recording up to 02:05"),
    ).toBeVisible();
    // Answers read cleanly, without source quotes.
    expect(within(answers).queryByText(/We settle on 200k/)).toBeNull();
  });

  // The request shows in its bubble and again as the Task card's goal.
  function requestRow(text: string) {
    return screen.getAllByText(text)[0]!.closest("li")!;
  }

  function node(row: HTMLElement) {
    return row.querySelector("[data-node]")!.getAttribute("data-node");
  }

  it("hands a recognized request to Another Me and turns its spinner into a check", async () => {
    const { routes } = renderWindow(voiceValue(), { tenantId: "tenant-1" });
    // Holds the server's reply until the spinner has been seen.
    const gate = pending<void>();
    const createTask =
      routes.sendVoiceCaptureQuestionTask.getMockImplementation()!;
    routes.sendVoiceCaptureQuestionTask.mockImplementationOnce(
      async (captureId, questionId) => {
        await gate.promise;
        return createTask(captureId, questionId);
      },
    );
    askInWindow("Help me write the prices into an email to Lena");
    await waitFor(() =>
      expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledWith(
        "capture-1",
        "q1",
      ),
    );
    const row = requestRow("Help me write the prices into an email to Lena");
    // No answer text: the request shows as being handed over.
    expect(node(row)).toBe("sending");
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Sending to Another Me…",
    );
    expect(within(row).queryByText(/Based on the recording/)).toBeNull();
    await act(async () => gate.resolve());
    expect(node(row)).toBe("sent");
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Sent to Another Me",
    );
    // Another Me decides on the Task; Ask shows no Task card or link.
    expect(within(row).queryByRole("article")).toBeNull();
    expect(within(row).queryByRole("link")).toBeNull();
    // It stays sent across tabs.
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    fireEvent.click(screen.getByRole("tab", { name: "Ask" }));
    expect(
      node(requestRow("Help me write the prices into an email to Lena")),
    ).toBe("sent");
    expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledOnce();
  });

  it("keeps the new recording task sending when the previous recording task fails late", async () => {
    const { routes, rerender } = renderWindow(voiceValue());
    const old = pending<void>();
    const current = pending<void>();
    const createTask =
      routes.sendVoiceCaptureQuestionTask.getMockImplementation()!;
    routes.sendVoiceCaptureQuestionTask
      .mockImplementationOnce(async () => {
        await old.promise;
        throw new Error("old request failed");
      })
      .mockImplementationOnce(async (captureId, questionId) => {
        await current.promise;
        return createTask(captureId, questionId);
      });
    askInWindow("Help me handle recording A's task");
    await waitFor(() =>
      expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledTimes(1),
    );
    rerender(
      voiceValue({
        captureState: {
          status: "recording",
          capture: { ...capture, id: "capture-2" },
        },
      }),
    );
    askInWindow("Help me handle recording B's task");
    await waitFor(() =>
      expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledTimes(2),
    );
    expect(node(requestRow("Help me handle recording B's task"))).toBe(
      "sending",
    );
    await act(async () => old.resolve());
    expect(node(requestRow("Help me handle recording B's task"))).toBe(
      "sending",
    );
    await act(async () => current.resolve());
    expect(node(requestRow("Help me handle recording B's task"))).toBe("sent");
  });

  it("shows a failed task on a red node and retries it", async () => {
    const { routes } = renderWindow(voiceValue());
    routes.sendVoiceCaptureQuestionTask.mockRejectedValueOnce(
      new Error("offline"),
    );
    askInWindow("Help me remind Kai to send the quote after the meeting");
    const row = await waitFor(() => {
      const found = requestRow(
        "Help me remind Kai to send the quote after the meeting",
      );
      expect(node(found)).toBe("failed");
      return found;
    });
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Not sent · Retry",
    );
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(node(row)).toBe("sent"));
    expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledTimes(2);
  });

  it("minimizes to its top row and keeps recording until Stop", async () => {
    const voice = voiceValue();
    renderWindow(voice);
    fireEvent.click(screen.getByRole("button", { name: "Minimize recording" }));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByLabelText("Recording duration")).toBeVisible();
    expect(voice.leavePage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open recording" }));
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    clickStop();
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    // Saving continues in the background; the sidebar shows its progress.
    expect(screen.getByTestId("window-state")).toHaveTextContent("closed");
  });

  it("keeps the Ask draft and transcript scroll while collapsed", () => {
    renderWindow(voiceValue());
    const transcript = screen.getByRole("region", {
      name: "Hardware voice focus",
    });
    const scroll = transcript.querySelector(".workspace-scrollbar")!;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    fireEvent.wheel(scroll, { deltaY: -80 });
    scroll.scrollTop = 80;
    fireEvent.scroll(scroll);
    const draft = screen.getByRole("textbox", {
      name: "Ask about this recording",
    });
    fireEvent.change(draft, { target: { value: "An unfinished question" } });
    fireEvent.click(screen.getByRole("button", { name: "Minimize recording" }));
    expect(draft.isConnected).toBe(true);
    expect(draft.closest("[inert]")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open recording" }));
    expect(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
    ).toBe(draft);
    expect(draft).toHaveValue("An unfinished question");
    expect(transcript.querySelector(".workspace-scrollbar")).toBe(scroll);
    expect(scroll.scrollTop).toBe(80);
  });

  it.each(["browser", "desktop"])(
    "asks inside the row of a minimized in-page window in %s",
    async (host) => {
      if (host === "desktop") {
        defineGlobalProperty(window, "lingerDesktop", {
          configurable: true,
          value: {},
        });
      }
      const voice = voiceValue();
      renderWindow(voice);
      fireEvent.click(
        screen.getByRole("button", { name: "Minimize recording" }),
      );
      expect(screen.queryByRole("tablist")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
      expect(
        screen.getByRole("alertdialog", { name: "Stop recording?" }),
      ).toBeVisible();
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(screen.getByTestId("window-state")).toHaveTextContent("minimized");
      // The row may sit at the bottom of the viewport, where a card hanging
      // below it would be off screen; the actions stay inside the row.
      expect(screen.getByText("Stop recording?")).toHaveClass("sr-only");
      expect(
        screen.getByRole("button", { name: "Stop & save" }).parentElement,
      ).not.toHaveClass("flex-col");
      expect(
        screen.getByRole("region", { name: "Hardware voice focus" }),
      ).toHaveClass("overflow-hidden");
      expect(screen.getByRole("button", { name: "Stop & save" })).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Keep recording" }),
      ).toHaveFocus();
      expectStopAsksInPlaceOfControls();
      fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(voice.leavePage).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Stop recording" }),
      ).toHaveFocus();

      // Escape keeps recording too.
      fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
      fireEvent.keyDown(
        screen.getByRole("button", { name: "Keep recording" }),
        {
          key: "Escape",
        },
      );
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Stop recording" }),
      ).toHaveFocus();
      expect(voice.leavePage).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
      fireEvent.click(screen.getByRole("button", { name: "Stop & save" }));
      await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    },
  );

  it("keeps the expanded Ask view while confirming Stop", () => {
    const voice = voiceValue();
    renderWindow(voice);
    fireEvent.click(screen.getByRole("tab", { name: "Ask" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(screen.getByRole("tab", { name: "Ask" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("window-state")).toHaveTextContent("open");
    // The open window has room for the full question card.
    expect(screen.getByText("Stop recording?")).not.toHaveClass("sr-only");
    expect(
      screen.getByRole("button", { name: "Stop & save" }).parentElement,
    ).toHaveClass("flex-col");
    // The card covers the open window; the row keeps its controls behind it.
    expect(
      screen.getByRole("alertdialog").closest("header"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pause recording" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Stop recording" }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
    expect(screen.getByRole("tab", { name: "Ask" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(voice.leavePage).not.toHaveBeenCalled();
  });

  it("opens a new Meeting at full size after stopping a minimized recording", async () => {
    const { frame, pipWindow, open } = stubDesktopVoiceWindow();
    const firstVoice = voiceValue();
    const first = renderWindow(firstVoice);
    await act(() => openVoicePip("recording"));
    const floating = within(frame.contentDocument!.body);
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    expect(pipWindow.innerHeight).toBe(104);
    fireEvent.click(floating.getByRole("button", { name: "Stop recording" }));
    fireEvent.click(floating.getByRole("button", { name: "Stop & save" }));
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
    first.unmount();

    const next = renderWindow(
      voiceValue({ captureState: { status: "idle" } }),
      { showEntry: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("open"),
    );
    next.rerender(
      voiceValue({
        captureState: {
          status: "recording",
          capture: { ...capture, id: "capture-2" },
        },
      }),
    );
    expect(floating.getByRole("tablist")).toBeInTheDocument();
    expect(pipWindow.innerHeight).toBe(720);
    expect(pipWindow.innerWidth).toBe(420);
  });

  it("uses horizontal confirmation without resizing a minimized desktop window", async () => {
    const { frame, pipWindow } = stubDesktopVoiceWindow();
    const voice = voiceValue();
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    const floating = within(frame.contentDocument!.body);
    pipWindow.resizeTo(560, 492);
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    expect(pipWindow.innerHeight).toBe(104);
    pipWindow.resizeTo.mockClear();

    fireEvent.click(floating.getByRole("button", { name: "Stop recording" }));
    expect(
      floating.getByRole("alertdialog", { name: "Stop recording?" }),
    ).toBeInTheDocument();
    expect(pipWindow.outerWidth).toBe(560);
    expect(pipWindow.innerHeight).toBe(104);
    expect(
      floating.getByRole("button", { name: "Stop & save" }).parentElement,
    ).not.toHaveClass("flex-col");
    expect(floating.getByText("Stop recording?")).toHaveClass("sr-only");
    expectStopAsksInPlaceOfControls(floating);
    expect(floating.queryByRole("tablist")).toBeNull();
    expect(screen.getByTestId("window-state")).toHaveTextContent("minimized");
    fireEvent.click(floating.getByRole("button", { name: "Keep recording" }));
    expect(pipWindow.innerHeight).toBe(104);
    expect(pipWindow.resizeTo).not.toHaveBeenCalled();
    expect(voice.leavePage).not.toHaveBeenCalled();
    fireEvent.click(floating.getByRole("button", { name: "Open recording" }));
    expect(pipWindow.outerHeight).toBe(492);
    fireEvent.click(floating.getByRole("button", { name: "Stop recording" }));
    expect(pipWindow.outerHeight).toBe(492);
    expect(floating.getByText("Stop recording?")).not.toHaveClass("sr-only");
    expect(
      floating.getByRole("button", { name: "Stop & save" }).parentElement,
    ).toHaveClass("flex-col");
    fireEvent.click(floating.getByRole("button", { name: "Keep recording" }));
    expect(pipWindow.outerHeight).toBe(492);
  });

  it("floats over other apps, and closing it minimized ends the recording", async () => {
    const { frame, pipWindow } = stubDesktopVoiceWindow();
    const voice = voiceValue();
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    const floating = within(frame.contentDocument!.body);
    expectInDocument(
      await floating.findByRole("region", { name: "Recording window" }),
      frame.contentDocument!,
    );
    // Minimizing from inside the floating window shrinks it to its top row.
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    expect(pipWindow.resizeTo).toHaveBeenCalledWith(420, 104);
    // The floating window is resized by the desktop, not by a grip.
    expect(
      floating.queryByRole("button", { name: "Resize recording window" }),
    ).toBeNull();

    act(() => pipWindow.close());
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
  });

  it("ends the recording when the open floating window is closed", async () => {
    const { frame, pipWindow } = stubDesktopVoiceWindow();
    const voice = voiceValue();
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    expectInDocument(
      within(frame.contentDocument!.body).getByRole("tab", { name: "Ask" }),
      frame.contentDocument!,
    );

    act(() => pipWindow.close());
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
  });

  it("opens only in its own desktop window, with no copy in the page", async () => {
    const desktop = stubDesktopVoiceWindow();
    const voice = voiceValue();
    renderWindow(voice);
    const floating = within(desktop.frame.contentDocument!.body);
    expectInDocument(
      await floating.findByRole("region", { name: "Recording window" }),
      desktop.frame.contentDocument!,
    );
    expect(desktop.open).toHaveBeenCalledOnce();
    expect(desktop.requestWindow).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
    // There is no way to move it back into the page.
    expect(
      floating.queryByRole("button", { name: "Float recording window" }),
    ).toBeNull();
    expect(
      floating.queryByRole("button", { name: "Return recording to Linger" }),
    ).toBeNull();
  });

  it("shows the Linger window by its own button and keeps recording in the floating window", async () => {
    const desktop = stubDesktopVoiceWindow();
    const voice = voiceValue();
    renderWindow(voice);
    const floating = within(desktop.frame.contentDocument!.body);
    await floating.findByRole("region", { name: "Recording window" });
    await act(async () => {
      fireEvent.click(
        floating.getByRole("button", { name: "Show Linger window" }),
      );
    });
    expect(desktop.showMain).toHaveBeenCalledOnce();
    expect(desktop.pipWindow.close).not.toHaveBeenCalled();
    expectInDocument(
      floating.getByRole("region", { name: "Recording window" }),
      desktop.frame.contentDocument!,
    );
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
    expect(voice.leavePage).not.toHaveBeenCalled();

    // Its close button still ends the recording as the main window comes
    // to the front.
    act(() => {
      desktop.pipWindow.close();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    expect(desktop.open).toHaveBeenCalledOnce();
  });

  it("stays in the page with a Float button when the desktop app refuses the window", async () => {
    const desktop = stubDesktopVoiceWindow();
    desktop.open.mockReturnValueOnce(
      null as unknown as typeof desktop.pipWindow,
    );
    const voice = voiceValue();
    renderWindow(voice);
    expect(
      await screen.findByRole("region", { name: "Recording window" }),
    ).toBeVisible();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Float recording window" }),
      );
    });
    expect(desktop.open).toHaveBeenCalledTimes(2);
    const floating = within(desktop.frame.contentDocument!.body);
    expectInDocument(
      await floating.findByRole("region", { name: "Recording window" }),
      desktop.frame.contentDocument!,
    );
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
    expect(voice.leavePage).not.toHaveBeenCalled();
  });

  it("cannot be dragged out of the page, and moves back in when it opens or the page narrows", () => {
    const observed: (() => void)[] = [];
    const resize = () => observed.forEach((callback) => callback());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    renderWindow(voiceValue());
    const frame = screen.getByRole("region", { name: "Recording window" });
    let height = 500;
    Object.defineProperties(frame, {
      offsetHeight: { get: () => height },
      offsetWidth: { get: () => 420 },
    });
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(500, 64, 420, height),
    );
    const titleBar = screen.getByRole("button", {
      name: "Minimize recording",
    }).parentElement!;
    fireEvent.pointerDown(titleBar, { button: 0, clientX: 700, clientY: 80 });
    fireEvent.pointerMove(window, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(window);
    expect(frame).toHaveStyle({
      left: `${window.innerWidth - 420}px`,
      top: `${window.innerHeight - 500}px`,
    });
    fireEvent.pointerDown(titleBar, { button: 0, clientX: 700, clientY: 80 });
    fireEvent.pointerMove(window, { clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(window);
    // It stays below the top of the page.
    expect(frame).toHaveStyle({ left: "0px", top: "36px" });

    // Minimized to its top row at the bottom of the page, then opened again.
    fireEvent.click(screen.getByRole("button", { name: "Minimize recording" }));
    height = 92;
    fireEvent.pointerDown(titleBar, { button: 0, clientX: 700, clientY: 80 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 5000 });
    fireEvent.pointerUp(window);
    expect(frame).toHaveStyle({ top: `${window.innerHeight - 92}px` });
    fireEvent.click(screen.getByRole("button", { name: "Open recording" }));
    height = 500;
    act(() => resize());
    expect(frame).toHaveStyle({ top: `${window.innerHeight - 500}px` });

    // A narrower page moves it left until all of it shows again.
    expect(frame).toHaveStyle({ left: "500px" });
    vi.stubGlobal("innerWidth", 800);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(frame).toHaveStyle({ left: `${800 - 420}px` });
  });

  it("resizes in the page by its edges and corners, and only in width while minimized", () => {
    renderWindow(voiceValue());
    const frame = screen.getByRole("region", { name: "Recording window" });
    const body = screen.getByRole("tablist").parentElement!;
    // Until it is resized the window is as tall as its content needs.
    expect(body.style.height).toBe("");
    const onScreen = vi
      .spyOn(frame, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(500, 64, 420, 500));
    const grip = screen.getByRole("button", {
      name: "Resize recording window",
    });
    fireEvent.pointerDown(grip, { button: 0, clientX: 920, clientY: 564 });
    fireEvent.pointerMove(grip, { clientX: 1000, clientY: 664 });
    fireEvent.pointerUp(grip);
    expect(frame).toHaveStyle({ left: "500px", top: "64px" });
    expect(frame).toHaveStyle({ width: "500px" });
    // The expanded body keeps the chosen height, less the two fixed bars.
    expect(body).toHaveStyle({ height: "508px" });

    // The top left corner stops at the minimum size and keeps the opposite
    // corner where it was.
    onScreen.mockReturnValue(new DOMRect(500, 64, 500, 600));
    const corner = frame.querySelector('[data-resize-edge="nw"]')!;
    fireEvent.pointerDown(corner, { button: 0, clientX: 500, clientY: 64 });
    fireEvent.pointerMove(corner, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(corner);
    expect(frame).toHaveStyle({ left: "720px", top: "384px" });
    expect(frame).toHaveStyle({ width: "280px" });
    expect(body).toHaveStyle({ height: "188px" });

    // Minimized to its top row, only the sides resize it.
    fireEvent.click(screen.getByRole("button", { name: "Minimize recording" }));
    expect(
      screen.queryByRole("button", { name: "Resize recording window" }),
    ).toBeNull();
    expect(frame.querySelector('[data-resize-edge="s"]')).toBeNull();
    expect(frame.style.height).toBe("");
    onScreen.mockReturnValue(new DOMRect(720, 384, 280, 92));
    const right = frame.querySelector('[data-resize-edge="e"]')!;
    fireEvent.pointerDown(right, { button: 0, clientX: 1000, clientY: 400 });
    fireEvent.pointerMove(right, { clientX: 5000, clientY: 400 });
    fireEvent.pointerUp(right);
    expect(frame).toHaveStyle({ width: `${window.innerWidth - 720}px` });
    expect(frame.style.height).toBe("");
    // Opening it again brings back the height it had.
    fireEvent.click(screen.getByRole("button", { name: "Open recording" }));
    expect(body).toHaveStyle({ height: "188px" });
  });

  it("ends at once when its window closes and does not open it again", async () => {
    const desktop = stubDesktopVoiceWindow();
    let finishStop = () => {};
    const voice = voiceValue({
      leavePage: vi.fn(
        () => new Promise<void>((resolve) => (finishStop = resolve)),
      ),
    });
    renderWindow(voice);
    await waitFor(() => expect(desktop.open).toHaveBeenCalledOnce());
    act(() => desktop.pipWindow.close());
    expect(voice.leavePage).toHaveBeenCalledOnce();
    await act(async () => finishStop());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
    expect(desktop.open).toHaveBeenCalledOnce();
  });

  it("restores the user's full window size across repeated minimize cycles", async () => {
    const { frame, pipWindow } = stubDesktopVoiceWindow();
    const voice = voiceValue();
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    const floating = within(frame.contentDocument!.body);
    pipWindow.resizeTo(560, 492);
    pipWindow.resizeTo.mockClear();

    for (let cycle = 0; cycle < 3; cycle++) {
      fireEvent.click(
        floating.getByRole("button", { name: "Minimize recording" }),
      );
      expect(pipWindow.outerWidth).toBe(560);
      expect(pipWindow.innerHeight).toBe(104);
      fireEvent.click(floating.getByRole("button", { name: "Open recording" }));
      expect(pipWindow.outerWidth).toBe(560);
      expect(pipWindow.outerHeight).toBe(492);
    }
    expect(voice.stopCapture).not.toHaveBeenCalled();
    expect(voice.leavePage).not.toHaveBeenCalled();
    expect(pipWindow.close).not.toHaveBeenCalled();

    pipWindow.resizeTo(620, 552);
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    fireEvent.click(floating.getByRole("button", { name: "Open recording" }));
    expect(pipWindow.outerWidth).toBe(620);
    expect(pipWindow.outerHeight).toBe(552);
  });

  it("restores width even when the desktop narrows the minimized window", async () => {
    const { frame, pipWindow } = stubDesktopVoiceWindow();
    renderWindow(voiceValue());
    await act(() => openVoicePip("recording"));
    const floating = within(frame.contentDocument!.body);
    pipWindow.resizeTo(580, 512);
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    pipWindow.resizeTo(360, 104);
    fireEvent.click(floating.getByRole("button", { name: "Open recording" }));
    expect(pipWindow.outerWidth).toBe(580);
    expect(pipWindow.outerHeight).toBe(512);
  });

  it("does not overwrite the expanded size while a resize is still pending", async () => {
    const { frame, pipWindow } = stubDesktopVoiceWindow();
    renderWindow(voiceValue());
    await act(() => openVoicePip("recording"));
    const floating = within(frame.contentDocument!.body);
    pipWindow.resizeTo(560, 492);
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    // Browsers can impose a minimum larger than the requested compact height.
    pipWindow.resizeTo(560, 180);
    // Native resize requests may return before the window metrics change.
    pipWindow.resizeTo.mockImplementation(() => undefined);
    fireEvent.click(floating.getByRole("button", { name: "Open recording" }));
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    fireEvent.click(floating.getByRole("button", { name: "Open recording" }));
    expect(pipWindow.resizeTo).toHaveBeenLastCalledWith(560, 492);
  });

  it("fits the saved size to the current screen after moving between displays", async () => {
    const { frame, pipWindow } = stubDesktopVoiceWindow();
    renderWindow(voiceValue());
    await act(() => openVoicePip("recording"));
    const floating = within(frame.contentDocument!.body);
    pipWindow.resizeTo(700, 752);
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    pipWindow.screen.availWidth = 640;
    pipWindow.screen.availHeight = 600;
    fireEvent.click(floating.getByRole("button", { name: "Open recording" }));
    expect(pipWindow.resizeTo).toHaveBeenLastCalledWith(640, 600);
  });

  it("keeps recording and its controls usable when native resize is refused", async () => {
    const { frame, pipWindow } = stubDesktopVoiceWindow();
    const voice = voiceValue();
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    const floating = within(frame.contentDocument!.body);
    pipWindow.resizeTo.mockImplementation(() => {
      throw new Error("Resize refused");
    });
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    expectInDocument(
      floating.getByRole("button", { name: "Open recording" }),
      frame.contentDocument!,
    );
    fireEvent.click(floating.getByRole("button", { name: "Open recording" }));
    expectInDocument(
      floating.getByRole("tab", { name: "Transcript" }),
      frame.contentDocument!,
    );
    expect(voice.stopCapture).not.toHaveBeenCalled();
    expect(voice.leavePage).not.toHaveBeenCalled();
  });

  it("does not show the window in the page while the closed one stops", async () => {
    const { pipWindow } = stubDesktopVoiceWindow();
    let finishStop = () => {};
    const voice = voiceValue({
      leavePage: vi.fn(
        () => new Promise<void>((resolve) => (finishStop = resolve)),
      ),
    });
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    act(() => pipWindow.close());
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Recording duration")).toBeNull();
    await act(async () => finishStop());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
  });

  it("spends autoStart once recording is underway", async () => {
    resetRecordingWindowForTest();
    openRecordingWindow({ autoStart: true });
    renderWindow(voiceValue());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("open"),
    );
    expect(screen.getByTestId("window-state")).not.toHaveTextContent(
      "autostart",
    );
  });

  it("hides the closed window while it stops", async () => {
    const { pipWindow } = stubDesktopVoiceWindow();
    let finishStop = () => {};
    const voice = voiceValue({
      leavePage: vi.fn(
        () => new Promise<void>((resolve) => (finishStop = resolve)),
      ),
    });
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    act(() => pipWindow.close());
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("ending"),
    );
    await act(async () => finishStop());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
  });

  it("opens its window again at its top row when stopping after the close fails", async () => {
    const { frame, open, pipWindow } = stubDesktopVoiceWindow();
    const voice = voiceValue({
      leavePage: vi.fn(async () => {
        throw new Error("stop failed");
      }),
    });
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    act(() => pipWindow.close());
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("minimized"),
    );
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(pipWindow.innerHeight).toBe(104));
    expectInDocument(
      within(frame.contentDocument!.body).getByRole("button", {
        name: "Open recording",
      }),
      frame.contentDocument!,
    );
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
  });
});

function expectInDocument(element: HTMLElement, target: Document) {
  // Adopted nodes retain their creation realm; containment works across windows.
  expect(target.body.contains(element)).toBe(true);
  expect(element.isConnected).toBe(true);
}

/** A frameless desktop window, with the browser API present but never used. */
function stubDesktopVoiceWindow() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const listeners: (() => void)[] = [];
  const pipWindow = {
    document: frame.contentDocument!,
    innerWidth: 420,
    innerHeight: 720,
    outerWidth: 420,
    outerHeight: 720,
    screen: { availWidth: 1440, availHeight: 900 },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "pagehide") listeners.push(listener);
    },
    close: vi.fn(() => listeners.splice(0).forEach((listener) => listener())),
    resizeTo: vi.fn((width: number, height: number) => {
      pipWindow.outerWidth = width;
      pipWindow.innerWidth = width;
      pipWindow.outerHeight = height;
      pipWindow.innerHeight = height;
    }),
    resizeBy: vi.fn((width: number, height: number) => {
      pipWindow.resizeTo(
        pipWindow.outerWidth + width,
        pipWindow.outerHeight + height,
      );
    }),
  };
  const requestWindow = vi.fn();
  defineGlobalProperty(window, "documentPictureInPicture", {
    configurable: true,
    value: { requestWindow },
  });
  const open = vi.fn((_url: string, _target: string, features: string) => {
    const width = Number(/width=(\d+)/.exec(features)?.[1]);
    const height = Number(/height=(\d+)/.exec(features)?.[1]);
    pipWindow.resizeTo(width, height);
    return pipWindow;
  });
  const showMain = vi.fn(async () => {});
  defineGlobalProperty(window, "open", { value: open });
  defineGlobalProperty(window, "lingerDesktop", {
    value: { voiceWindow: { showMainWindow: showMain } },
  });
  return { frame, pipWindow, requestWindow, open, showMain };
}

describe("Recording window placement", () => {
  it("stays at the top right of a pinch-zoomed view at its usual size", () => {
    // Zoomed 2×, looking at the part of the page from (300, 200).
    expect(
      pinchedPlacement({ left: 300, top: 200, width: 720, scale: 2 }),
    ).toMatchObject({
      left: 300 + 720 - (420 + 16) / 2,
      top: 200 + 64 / 2,
      transform: "scale(0.5)",
    });
  });
});

/** Stops the recording, confirming in the window when it asks first. */
function clickStop() {
  fireEvent.click(
    screen.getByRole("button", { name: /^(Stop|Close) recording$/ }),
  );
  const confirm = screen.queryByRole("button", { name: "Stop & save" });
  if (confirm) fireEvent.click(confirm);
}

/**
 * A minimized window asks in its row in place of Pause and Stop, beside the
 * timer, instead of drawing the question over them.
 */
function expectStopAsksInPlaceOfControls(
  view: Pick<
    typeof screen,
    "getByLabelText" | "getByRole" | "queryByRole"
  > = screen,
) {
  const row = view
    .getByRole("alertdialog", { name: "Stop recording?" })
    .closest("header");
  expect(row?.contains(view.getByLabelText("Recording duration"))).toBe(true);
  expect(view.queryByRole("button", { name: "Pause recording" })).toBeNull();
  expect(view.queryByRole("button", { name: "Stop recording" })).toBeNull();
}
