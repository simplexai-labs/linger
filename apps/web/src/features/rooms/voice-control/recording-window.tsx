import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n/use-translation";

import {
  closeVoicePip,
  onVoicePipClosedByHuman,
  openVoicePip,
  returnedToOpener,
  returnVoicePipToPage,
  useVoicePip,
  voicePipSupported,
} from "../chat/voice-mode/voice-pip";
import {
  containedVoiceWindowPosition,
  useKeptInViewport,
  VoiceWindowResizeHandles,
  type VoiceWindowBounds,
} from "../chat/voice-mode/voice-window-resize";
import {
  RecordingAnswers,
  RecordingAskBox,
  useRecordingQuestions,
} from "./recording-questions";
import {
  closeRecordingWindow,
  consumeRecordingAutoStart,
  endRecordingWindow,
  expandRecordingWindow,
  minimizeRecordingWindow,
  useRecordingWindow,
} from "./recording-window-store";
import { recordingMessages as m } from "./recording.messages";
import {
  useOptionalVoiceControl,
  type VoiceControlContextValue,
} from "./voice-control-context";
import { VoiceFocusSurface, type RecordingView } from "./voice-focus-surface";

// Inner height that keeps the docked title bar and recording controls visible.
const collapsedPipHeight = 104;
interface ExpandedPipSize {
  window: Window;
  width: number;
  height: number;
  collapsedWidth?: number;
  collapsedHeight?: number;
}
// Where the window sits in the page: 16px from the right, 64px from the top.
const pageInset = { right: 16, top: 64, width: 420 };
/** Still shows the recording controls, the tabs and the Ask box. */
const minPageSize = { height: 280, width: 280 };
// The in-page window stays below the top of the page.
const pageTop = 36;

/**
 * The one place a recording is watched and controlled from, whatever page is
 * behind it. In the desktop app the window floats over other apps;
 * in a browser it stays in the page, where
 * its edges and corners resize it. Minimizing it leaves only its top row and
 * keeps recording; Stop, or closing the open floating window, ends the
 * recording. The desktop window's return button keeps recording in the page.
 */
export default function RecordingWindow() {
  const t = useT();
  const windowState = useRecordingWindow();
  const livekit = useOptionalVoiceControl();
  const voice = livekit;
  const pip = useVoicePip("recording");
  const expandedPipSize = useRef<ExpandedPipSize | undefined>(undefined);
  const status = voice?.captureState?.status;
  const [lastView, setLastView] = useState<RecordingView>("transcript");
  const view = windowState.minimized ? undefined : lastView;

  // Hide the surface while the desktop window closes. Only its explicit
  // return button keeps recording in the page.
  const [floated, setFloated] = useState(false);
  const [backInPage, setBackInPage] = useState(false);
  if (pip && !floated) setFloated(true);
  if (pip && backInPage) setBackInPage(false);
  const pipClosed = floated && !pip && !backInPage;

  // Moving one portal host preserves pause timing, Ask drafts and transcript
  // scroll state; changing the portal target would remount the recording UI.
  const [portalHost] = useState(() => document.createElement("div"));
  const portalParent =
    voice && !windowState.ending && !pipClosed
      ? (pip?.document.body ?? document.body)
      : undefined;
  useLayoutEffect(() => {
    if (!portalParent) return;
    portalParent.append(portalHost);
    return () => portalHost.remove();
  }, [portalHost, portalParent]);

  // The desktop's close button on the floating window ends the recording the
  // way Stop does, whether the window was open or minimized to its top row.
  const voiceRef = useRef(voice);
  const pipRef = useRef(pip);
  const endingRef = useRef(false);
  const closedByHumanRef = useRef(() => {});
  useLayoutEffect(() => {
    voiceRef.current = voice;
    pipRef.current = pip;
    closedByHumanRef.current = () => {
      if (endingRef.current) return;
      endingRef.current = true;
      if (!voice) {
        closeRecordingWindow();
        return;
      }
      endRecordingWindow();
      void endRecording(voice).then(closeRecordingWindow, () => {
        endingRef.current = false;
        // Only a recording that is still running stays, kept controllable.
        const latest = voiceRef.current?.captureState?.status;
        if (latest === "recording" || latest === "starting") {
          setFloated(false);
          minimizeRecordingWindow();
        } else closeRecordingWindow();
      });
    };
  });
  useEffect(() => {
    let mounted = true;
    const unsubscribe = onVoicePipClosedByHuman("recording", () => {
      void returnedToOpener().then((returned) => {
        if (!mounted || pipRef.current) return;
        if (returned) setBackInPage(true);
        else closedByHumanRef.current();
      });
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  // Spend auto start once, so re-opening this window cannot start a second
  // recording when this one stops.
  useEffect(() => {
    if (status === "recording" || status === "starting")
      consumeRecordingAutoStart();
  }, [status]);
  // A recording that finished saving is reviewed in Another Me's chat.
  const previousStatus = useRef(status);
  useEffect(() => {
    if (
      status === "completed" &&
      previousStatus.current !== "completed" &&
      !windowState.autoStart
    ) {
      closeVoicePip("recording");
      closeRecordingWindow();
    }
    previousStatus.current = status;
  }, [status, windowState.autoStart]);

  const changeView = (next: RecordingView | undefined) => {
    if (next) {
      setLastView(next);
      expandRecordingWindow();
    } else minimizeRecordingWindow();
    // Keep native resize inside the click so it retains user activation.
    if (pip && Boolean(next) !== Boolean(view)) {
      const chromeHeight = Math.max(0, pip.outerHeight - pip.innerHeight);
      const collapsedHeight = collapsedPipHeight + chromeHeight;
      let expanded = expandedPipSize.current;
      if (expanded?.window !== pip) expanded = undefined;
      // A rapid second click can precede the native expansion. Do not save
      // the still-collapsed metrics as the user's expanded window size.
      if (
        !next &&
        (!expanded ||
          pip.outerWidth !== expanded.collapsedWidth ||
          pip.outerHeight !== expanded.collapsedHeight)
      ) {
        expanded = {
          window: pip,
          width: pip.outerWidth,
          height: pip.outerHeight,
        };
        expandedPipSize.current = expanded;
      }
      if (next && expanded) {
        expanded.collapsedWidth = pip.outerWidth;
        expanded.collapsedHeight = pip.outerHeight;
      }
      const width = next && expanded ? expanded.width : pip.outerWidth;
      const height = next
        ? (expanded?.height ?? pip.outerHeight)
        : collapsedHeight;
      try {
        // Restore both outer dimensions: a desktop-clamped width must not
        // become the starting point for another relative shrink/expand cycle.
        pip.resizeTo(
          Math.min(width, pip.screen.availWidth || width),
          Math.min(height, pip.screen.availHeight || height),
        );
      } catch {
        // The Human can still drag the window to size.
      }
    }
  };

  const pinched = usePinchZoom();
  const [moved, setMoved] = useState<{ left: number; top: number }>();
  // The size the Human dragged the in-page window to, for as long as it is
  // open; until then it is 420px wide and as tall as its content needs. A
  // window resized while minimized has no height of its own yet.
  const [sized, setSized] = useState<{ height?: number; width: number }>();
  const frameRef = useRef<HTMLDivElement>(null);
  // A moved window stays whole inside the page when the viewport shrinks or
  // the window grows, as it does when it opens from its top row.
  useKeptInViewport(
    frameRef,
    moved,
    setMoved,
    pageBounds,
    Boolean(voice) && !pip && Boolean(moved),
  );
  // Keep the whole window inside the viewport when dragging its title bar.
  const startMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button"))
      return;
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const size = { height: frame.offsetHeight, width: frame.offsetWidth };
    const move = (next: globalThis.PointerEvent) =>
      setMoved(
        keptInPage(
          { left: next.clientX - offsetX, top: next.clientY - offsetY },
          size,
        ),
      );
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  if (!voice) return null;
  return createPortal(
    <div
      aria-label={t(m.window)}
      className={
        pip
          ? "flex h-dvh w-full flex-col bg-app-canvas"
          : "recording-window-frame app-floating-enter fixed top-16 right-4 z-[85] flex max-h-[calc(100dvh-36px)] w-[420px] max-w-[calc(100vw-32px)] flex-col"
      }
      ref={frameRef}
      role="region"
      style={
        pip
          ? undefined
          : moved
            ? {
                left: moved.left,
                right: "auto",
                top: moved.top,
                width: sized?.width,
              }
            : pinched
              ? pinchedPlacement(pinched)
              : undefined
      }
    >
      <RecordingPanel
        autoStart={windowState.autoStart}
        height={sized?.height}
        floating={pip ? "pip" : "page"}
        onFloat={
          !pip && voicePipSupported()
            ? () => {
                void openVoicePip("recording");
              }
            : undefined
        }
        onMoveStart={startMove}
        onReturn={pip ? () => returnVoicePipToPage("recording") : undefined}
        onViewChange={changeView}
        view={view}
      />
      {/* A pinch-zoomed page places the window itself. */}
      {pip || (pinched && !moved) ? null : (
        <VoiceWindowResizeHandles
          bounds={pageBounds}
          edges={view ? undefined : ["e", "w"]}
          label={t(m.resizeWindow)}
          min={minPageSize}
          onResize={({ height, left, top, width }) => {
            // Resizing places the window by its own corner from then on.
            setMoved({ left, top });
            setSized((current) => ({
              height: view ? height : current?.height,
              width,
            }));
          }}
          rect={() => frameRef.current?.getBoundingClientRect()}
        />
      )}
    </div>,
    portalHost,
  );
}

/** The part of the page the in-page window may cover. */
function pageBounds(): VoiceWindowBounds {
  return {
    bottom: window.innerHeight,
    left: 0,
    right: window.innerWidth,
    top: pageTop,
  };
}

/** The in-page window's corner, moved no further than keeps the whole window
 *  in the page. */
function keptInPage(
  position: { left: number; top: number },
  size: { height: number; width: number },
) {
  return containedVoiceWindowPosition(position, size, pageBounds());
}

/** Ends the recording and releases the microphone, as the Stop button does. */
async function endRecording(voice: VoiceControlContextValue) {
  if (voice.leavePage) {
    await voice.leavePage();
    return;
  }
  const status = voice.captureState.status;
  if (status === "recording" || status === "starting")
    await voice.stopCapture();
}

interface PinchZoom {
  left: number;
  top: number;
  width: number;
  scale: number;
}

/**
 * The part of the page in view while pinch-zoomed, or undefined otherwise. A
 * fixed window stays put on the unzoomed page, so without following the
 * zoomed view it ends up out of sight.
 */
function usePinchZoom() {
  const read = (): PinchZoom | undefined => {
    const visual = window.visualViewport;
    if (!visual || visual.scale <= 1.01) return undefined;
    return {
      left: visual.offsetLeft,
      top: visual.offsetTop,
      width: visual.width,
      scale: visual.scale,
    };
  };
  const [pinched, setPinched] = useState(read);
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const update = () => setPinched(read());
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, []);
  return pinched;
}

/** Keeps the window at the top right of the zoomed view, at its usual size. */
export function pinchedPlacement(view: PinchZoom) {
  return {
    left:
      view.left + view.width - (pageInset.width + pageInset.right) / view.scale,
    top: view.top + pageInset.top / view.scale,
    right: "auto",
    transform: `scale(${1 / view.scale})`,
    transformOrigin: "top left",
  } as const;
}

function RecordingPanel({
  autoStart,
  height,
  floating,
  onFloat,
  onMoveStart,
  onReturn,
  onViewChange,
  view,
}: {
  autoStart: boolean;
  height?: number;
  floating: "page" | "pip";
  onFloat?: () => void;
  onMoveStart: (event: PointerEvent<HTMLDivElement>) => void;
  onReturn?: () => void;
  onViewChange: (view: RecordingView | undefined) => void;
  view?: RecordingView;
}) {
  const livekit = useOptionalVoiceControl();
  const capture =
    livekit && "capture" in livekit.captureState
      ? livekit.captureState.capture
      : undefined;
  // Ask belongs to a started LiveKit recording.
  const recording =
    capture && livekit?.captureState.status !== "failed" ? capture : undefined;
  const recordingStartMs = recording?.requested_start_offset_ms ?? 0;
  const questions = useRecordingQuestions(recording?.id);
  return (
    <VoiceFocusSurface
      autoStart={autoStart}
      height={height}
      floating={floating}
      onFloat={onFloat}
      onMoveStart={onMoveStart}
      onReturn={onReturn}
      onExit={() => {
        // Saving finishes in the background; the sidebar's Recording tool
        // shows its progress and reopens this window on request.
        closeVoicePip("recording");
        closeRecordingWindow();
      }}
      onViewChange={onViewChange}
      panels={
        recording
          ? {
              ask: (
                <RecordingAnswers
                  items={questions.items}
                  onRetry={questions.retry}
                  onRetryTask={questions.retryTask}
                  pending={questions.pending}
                  recordingStartMs={recordingStartMs}
                  taskState={questions.taskState}
                />
              ),
              askComposer: (
                <RecordingAskBox
                  key={`ask:${recording.id}`}
                  busy={Boolean(questions.pending && !questions.pending.failed)}
                  onAsk={(question) => {
                    onViewChange("ask");
                    questions.ask(question);
                  }}
                />
              ),
            }
          : undefined
      }
      view={view}
    />
  );
}
