import {
  Cancel01Icon,
  Maximize01Icon,
  Mic01Icon,
  MicOff01Icon,
  Minimize01Icon,
  PictureInPictureExitIcon,
  PictureInPictureOnIcon,
  RotateLeft01Icon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Icon } from "@/components/ui/icon";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMatch, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { commonMessages } from "@/i18n/common.messages";
import { translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { isRunWorking } from "@/features/teamhub/run-status";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import {
  readRoomComposerDraft,
  subscribeRoomComposerDrafts,
} from "../../room-drafts";
import { roomMessagesInfiniteQueryOptions } from "../../room-queries";
import { useRoomRunStatusCollection } from "../../runtime-status/use-room-run-statuses";
import { ActorAvatar } from "../../members/actor-avatar";
import { voiceModeStatusLabel } from "./voice-mode-presentation";
import styles from "./voice-mode.module.css";
import { registerVoiceWindow, type VoiceWindowAction } from "./voice-ui-bridge";
import {
  onVoicePipClosedByHuman,
  openVoicePip,
  returnedToOpener,
  returnVoicePipToPage,
  useVoicePip,
  voicePipSupported,
} from "./voice-pip";
import {
  containedVoiceWindowPosition,
  useKeptInViewport,
  VoiceWindowResizeHandles,
  type VoiceWindowBounds,
} from "./voice-window-resize";
import { showVoiceNotice, useVoiceNotice } from "./voice-notice";
import { voiceWindowMessages as m } from "./voice-window.messages";
import {
  useOptionalVoiceModeSession,
  useVoiceModeLevel,
  type VoiceModeSession,
} from "./voice-mode-session";

// The height of the conversation below the 36px title bar: never more than
// leaves the whole window 16px inside the page.
const windowSizes = {
  compact: { height: "min(480px,70dvh,100dvh - 68px)", width: 320 },
  expanded: { height: "min(760px,86dvh,100dvh - 68px)", width: 560 },
} as const;
/** Still shows the header's controls and a few lines of the conversation. */
const minWindowSize = { height: 200, width: 260 };
const windowGap = 16;
const positionKey = "linger:voice-mode-window";
/** Above this level the Human is speaking, not just breathing near the mic. */
const speakingLevel = 0.08;

interface Position {
  left: number;
  top: number;
}
type WindowSize = keyof typeof windowSizes;

/**
 * Floating window for the running Voice Mode session. It follows the Human
 * across Rooms, shows this session's turns and the Room's replies, and can be
 * dragged anywhere on screen and resized by its edges and corners. Where the
 * browser or the desktop app supports it, the window lives in an
 * always-on-top window of its own instead, so it stays over other tabs and
 * apps. Closing it, from its own button or the desktop's, ends Voice Mode:
 * the window leaves at once while the session drains its last words in the
 * background, and the Room composer shows that finishing state. The floating
 * window's return button, like the browser's back to tab button, only returns
 * to the conversation.
 */
export default function VoiceModeMiniWindow({
  anotherMeActorId,
  currentActorId,
}: {
  anotherMeActorId?: string;
  currentActorId?: string;
}) {
  const voice = useOptionalVoiceModeSession();
  const session = voice?.session;
  if (!voice || !session || session.closing) return null;
  return (
    <MiniWindow
      anotherMeActorId={anotherMeActorId}
      currentActorId={currentActorId}
      onExit={voice.exit}
      onMute={voice.setMuted}
      onRetry={voice.retry}
      onSoundOff={voice.setSoundOff}
      session={session}
    />
  );
}

function MiniWindow({
  anotherMeActorId,
  currentActorId,
  onExit,
  onMute,
  onRetry,
  onSoundOff,
  session,
}: {
  anotherMeActorId?: string;
  currentActorId?: string;
  onExit: () => void;
  onMute: (muted: boolean) => Promise<void>;
  onRetry: () => void;
  onSoundOff: (soundOff: boolean) => void;
  session: VoiceModeSession;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const navigate = useNavigate();
  const { roomId, roomName, tenantId } = session.target;
  const routeRoom = useMatch("/t/:tenantId/rooms/:roomId/*");
  const inVoiceRoom = routeRoom?.params.roomId === roomId;
  // The Room's own Chat keeps its caches live; elsewhere this window does,
  // which also lets live Voice Mode hear the Agent's replies.
  const messages = useInfiniteQuery({
    ...roomMessagesInfiniteQueryOptions(client, tenantId, roomId),
    refetchInterval: inVoiceRoom ? false : 3_000,
  });
  // Live Voice Mode shows its own transcript instead of who is replying.
  const runStatuses = useRoomRunStatusCollection({
    enabled: !inVoiceRoom && !session.live,
    roomId,
    tenantId,
  });
  const turns = sessionMessages(
    messages.data?.pages.flatMap((page) => page.items) ?? [],
    session.startedAt,
  );
  // A Run status carries no reply text, so the window shows which Agents are
  // still working; their words arrive as Messages.
  const replying = runStatuses.items.filter(isRunWorking);
  // Words already said come before the reply to them; words being said now
  // come after it.
  const heard = session.entered
    ? (session.state.heardText ?? session.state.text).trim()
    : "";
  const saying = session.entered
    ? (session.state.speakingText ?? "").trim()
    : "";
  const live = [heard, saying].filter(Boolean).join("\n");
  // Live Voice Mode shows the call as it was said, so a reply saved late or
  // an Agent answer arriving between turns never reorders it.
  const transcript = session.live?.transcript;
  const soundOff = session.live?.soundOff;
  const pendingMaterials = useSyncExternalStore(
    subscribeRoomComposerDrafts,
    () =>
      readRoomComposerDraft({
        accountId: session.target.accountId,
        roomId,
        tenantId,
      }).voiceMaterials?.length ?? 0,
  );
  const notice = useVoiceNotice();
  const pip = useVoicePip("voice-mode");
  // One window: the desktop's close button on the floating one ends Voice Mode
  // too. Its back to tab or return button instead returns to this conversation
  // and keeps the call, which goes on in the window inside the page.
  const exitRef = useRef(onExit);
  const openRoomRef = useRef(() => {});
  useLayoutEffect(() => {
    exitRef.current = onExit;
    openRoomRef.current = () =>
      void navigate(`/t/${tenantId}/rooms/${roomId}/chat`);
  });
  // Once the call has floated, losing that window shows nothing in the page
  // while TeamHub tells a close from back to tab, so no window flashes up
  // before Voice Mode ends. Back to tab brings the window into the page.
  const [floated, setFloated] = useState(false);
  const [backInPage, setBackInPage] = useState(false);
  if (pip && !floated) setFloated(true);
  if (pip && backInPage) setBackInPage(false);
  const leavingPip = floated && !pip && !backInPage;
  useEffect(
    () =>
      onVoicePipClosedByHuman("voice-mode", () => {
        void returnedToOpener().then((returned) => {
          if (!returned) return exitRef.current();
          setBackInPage(true);
          openRoomRef.current();
        });
      }),
    [],
  );

  // Every session opens compact. The expand button switches between the two
  // preset sizes; dragging an edge or corner gives the window any other size,
  // which lasts until a preset is chosen again or the session ends.
  const [size, setSize] = useState<WindowSize>("compact");
  const [resized, setResized] = useState<{ height: number; width: number }>();
  const { width, height } = windowSizes[size];
  const large = resized
    ? resized.width >= windowSizes.expanded.width
    : size === "expanded";
  const choosePreset = (next: WindowSize) => {
    setResized(undefined);
    setSize(next);
  };
  const frameRef = useRef<HTMLElement>(null);
  const { consumeDrag, dragHandlers, moveTo, place, position, remember } =
    useDraggablePosition(
      resized?.width ?? width,
      frameRef,
      !pip && !leavingPip,
    );
  const windowControl = useRef<(action: VoiceWindowAction) => void>(() => {});
  useLayoutEffect(() => {
    windowControl.current = (action) => {
      if (action === "mute" || action === "unmute")
        void onMute(action === "mute");
      // The desktop places a picture-in-picture window; only a drag moves it.
      else if (pip) showVoiceNotice(translate(m.dragHint));
      else if (action === "expand" || action === "shrink")
        choosePreset(action === "expand" ? "expanded" : "compact");
      else place(action === "move_left" ? "left" : "right");
    };
  });
  useEffect(
    () => registerVoiceWindow((action) => windowControl.current(action)),
    [],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  /** A follow scroll is gliding down to the newest words. */
  const glidingRef = useRef(false);
  const lastTopRef = useRef(0);
  // Follows the conversation as it grows, gliding down to new lines instead
  // of snapping on every packet. A Human who scrolled up stays where they are.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    const view = scroller?.ownerDocument.defaultView;
    if (!scroller || !content || !view || !("ResizeObserver" in view)) return;
    const pin = (glide: boolean) => {
      if (!followRef.current) return;
      const top = scroller.scrollHeight - scroller.clientHeight;
      if (top - scroller.scrollTop < 1) return;
      glidingRef.current =
        glide &&
        typeof scroller.scrollTo === "function" &&
        !view.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (glidingRef.current) scroller.scrollTo({ top, behavior: "smooth" });
      else scroller.scrollTop = top;
    };
    // Opening the window, or moving it into or out of picture-in-picture,
    // shows the newest words at once; only words added afterwards glide.
    pin(false);
    const observer = new view.ResizeObserver(() => pin(true));
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [pip]);

  const state = session.state;
  const muted = session.muted;
  const listening = Boolean(state.microphoneActive) && !muted;
  if (leavingPip) return null;
  return createPortal(
    <section
      aria-label={t(m.window)}
      className={
        pip
          ? "flex h-dvh w-full flex-col bg-app-canvas"
          : `voice-mode-window app-floating-enter fixed z-[90] flex max-w-[calc(100vw-32px)] flex-col rounded-xl bg-app-canvas shadow-xl ${
              // A dragged edge is followed at once; only a preset eases in.
              resized
                ? "max-h-[calc(100dvh-32px)]"
                : "transition-[width,max-height] duration-200 ease-out motion-reduce:transition-none"
            }`
      }
      data-pip={pip ? true : undefined}
      data-size={resized ? "custom" : size}
      // Voice Mode finds its own window by this, whatever the language.
      data-voice-window=""
      ref={frameRef}
      style={
        pip
          ? undefined
          : resized
            ? { ...position, ...resized }
            : { ...position, maxHeight: `calc(${height} + 36px)`, width }
      }
    >
      {/* Clips the content to the window's corners; the resize handles sit
          outside it, on the border. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        {pip ? null : (
          <div
            className="voice-window-title flex h-9 shrink-0 cursor-grab touch-none select-none items-center px-3 active:cursor-grabbing"
            {...dragHandlers}
          >
            {t(m.title)}
          </div>
        )}
        <header
          className={`flex shrink-0 select-none items-center gap-2 border-b border-app-border px-3 py-2 ${
            pip ? "" : "cursor-grab touch-none active:cursor-grabbing"
          }`}
          {...(pip ? {} : dragHandlers)}
        >
          <VoiceAvatarBeat listening={listening}>
            <span className={styles.avatarSpin}>
              <ActorAvatar
                actorId={anotherMeActorId}
                kind="agent"
                name="Another Me"
                size="xs"
              />
            </span>
          </VoiceAvatarBeat>
          <button
            className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
            onClick={() => {
              if (!consumeDrag())
                void navigate(`/t/${tenantId}/rooms/${roomId}/chat`);
            }}
            title={t(m.openConversation)}
            type="button"
          >
            <span className="block truncate text-[14px] font-medium leading-5 text-app-ink">
              {roomName || t(m.title)}
            </span>
            <span className="block truncate text-[12px] leading-4 text-app-muted">
              {voiceModeStatusLabel({ ...state, entered: session.entered }, t)}
            </span>
          </button>
          <span
            className="flex shrink-0 items-center"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {state.canRetry ? (
              <Button
                // Names differ from the Room composer's controls so both can
                // be on screen without two identically named buttons.
                aria-label={t(m.retry)}
                disabled={state.sending}
                onClick={onRetry}
                size="compactIcon"
                tone="ghost"
              >
                <Icon icon={RotateLeft01Icon} size={16} />
              </Button>
            ) : null}
            <Button
              aria-label={t(muted ? m.unmute : m.mute)}
              aria-pressed={muted}
              disabled={!state.microphoneActive}
              onClick={() => void onMute(!muted)}
              size="compactIcon"
              tone="ghost"
            >
              {muted ? (
                <Icon icon={MicOff01Icon} size={16} />
              ) : (
                <Icon icon={Mic01Icon} size={16} />
              )}
            </Button>
            {soundOff === undefined ? null : (
              <Button
                aria-label={t(soundOff ? m.replySoundOn : m.replySoundOff)}
                aria-pressed={soundOff}
                onClick={() => onSoundOff(!soundOff)}
                size="compactIcon"
                tone="ghost"
              >
                {soundOff ? (
                  <Icon icon={VolumeOffIcon} size={16} />
                ) : (
                  <Icon icon={VolumeHighIcon} size={16} />
                )}
              </Button>
            )}
            {/* Brings the call back into the conversation it started in, in
              the desktop app's main window or this browser tab. */}
            {pip ? (
              <Button
                aria-label={t(m.returnToLinger)}
                onClick={() => returnVoicePipToPage("voice-mode")}
                size="compactIcon"
                title={t(m.returnHint)}
                tone="ghost"
              >
                <Icon icon={PictureInPictureExitIcon} size={16} />
              </Button>
            ) : null}
            {/* Back in the page, one click floats the call again; the browser
              opens that window only from a click in the page. */}
            {pip || !voicePipSupported() ? null : (
              <Button
                aria-label={t(m.float)}
                onClick={() => void openVoicePip("voice-mode")}
                size="compactIcon"
                title={t(m.floatHint)}
                tone="ghost"
              >
                <Icon icon={PictureInPictureOnIcon} size={16} />
              </Button>
            )}
            {pip ? null : (
              <Button
                aria-label={t(large ? m.shrink : m.expand)}
                onClick={() => choosePreset(large ? "compact" : "expanded")}
                size="compactIcon"
                tone="ghost"
              >
                {large ? (
                  <Icon icon={Minimize01Icon} size={14} />
                ) : (
                  <Icon icon={Maximize01Icon} size={14} />
                )}
              </Button>
            )}
            {/* The floating window's own close button ends Voice Mode there. */}
            {pip ? null : (
              // Not marked risky: ending Voice Mode from its window is never
              // confirmed, as its English name never was.
              <Button
                aria-label={t(m.end)}
                onClick={onExit}
                size="compactIcon"
                tone="ghost"
              >
                <Icon icon={Cancel01Icon} size={16} />
              </Button>
            )}
          </span>
        </header>
        <div
          aria-label={t(m.conversation)}
          aria-live="polite"
          className="workspace-scrollbar min-h-24 flex-1 overflow-y-auto px-3 py-3"
          onScroll={(event) => {
            const element = event.currentTarget;
            const top = element.scrollTop;
            const atBottom =
              element.scrollHeight - top - element.clientHeight < 24;
            // A follow glide passes through positions short of the bottom
            // on its way down; only moving up leaves the newest words.
            if (atBottom) {
              followRef.current = true;
              glidingRef.current = false;
            } else if (!glidingRef.current || top < lastTopRef.current) {
              followRef.current = false;
              glidingRef.current = false;
            }
            lastTopRef.current = top;
          }}
          ref={scrollRef}
          role="log"
        >
          <div className="space-y-2" ref={contentRef}>
            {(transcript
              ? transcript.length
              : turns.length || replying.length) || live ? null : (
              <p className="py-4 text-center text-xs text-app-muted">
                {t(m.empty)}
              </p>
            )}
            {transcript ? (
              transcript.map((line) => (
                <Bubble
                  agent={line.speaker !== "you"}
                  author={
                    line.speaker === "you"
                      ? t(commonMessages.you)
                      : session.target.recipient?.display_name || t(m.reply)
                  }
                  key={line.id}
                  own={line.speaker === "you"}
                  pending={line.pending}
                  text={line.text}
                />
              ))
            ) : (
              <>
                {turns.map((message) => (
                  <Bubble
                    agent={message.author.kind === "agent"}
                    author={message.author.display_name}
                    key={message.id}
                    own={
                      currentActorId
                        ? message.author.id === currentActorId
                        : message.author.kind === "human"
                    }
                    text={message.raw_message}
                  />
                ))}
                {replying.map((run) => (
                  <Bubble
                    agent
                    author={run.agent.display_name}
                    key={run.id}
                    own={false}
                    pending
                    text={t(m.working)}
                  />
                ))}
                {heard ? (
                  <Bubble
                    author={t(commonMessages.you)}
                    own
                    pending
                    text={heard}
                  />
                ) : null}
              </>
            )}
            {saying ? (
              <Bubble
                author={t(commonMessages.you)}
                own
                pending
                text={saying}
              />
            ) : null}
          </div>
        </div>
        {notice ? (
          <p
            className="shrink-0 truncate border-t border-app-border px-3 py-1.5 text-[12px] text-app-muted"
            role="status"
          >
            {notice}
          </p>
        ) : null}
        {pendingMaterials ? (
          <p className="shrink-0 truncate border-t border-app-border px-3 py-1.5 text-[12px] text-app-muted">
            {t(m.pendingSelections, { count: pendingMaterials })}
          </p>
        ) : null}
      </div>
      {pip ? null : (
        <VoiceWindowResizeHandles
          bounds={viewportBounds}
          label={t(m.resize)}
          min={minWindowSize}
          onResize={({ left, top, ...next }) => {
            setResized(next);
            moveTo({ left, top });
          }}
          onResizeEnd={remember}
          rect={() => frameRef.current?.getBoundingClientRect()}
        />
      )}
    </section>,
    pip?.document.body ?? document.body,
  );
}

// Each line renders again only when its own words change, not on every
// packet of the line being said.
const Bubble = memo(function Bubble({
  agent = false,
  author,
  own,
  pending = false,
  text,
}: {
  agent?: boolean;
  author: string;
  own: boolean;
  pending?: boolean;
  text: string;
}) {
  // A line still being said when it first shows fades in; lines already
  // said when the window opens show at once.
  const [entering] = useState(pending);
  return (
    <div
      className={`flex flex-col ${own ? "items-end" : "items-start"} ${
        entering ? "voice-live-fade-in" : ""
      }`}
    >
      {own ? null : (
        <span className="mb-0.5 px-1 text-[12px] text-app-muted">{author}</span>
      )}
      <p
        className={`max-w-[85%] whitespace-pre-wrap break-words text-[14px] leading-5 ${
          own
            ? "rounded-2xl bg-primary px-3 py-1.5 text-primary-foreground"
            : agent
              ? "px-1 text-foreground"
              : "rounded-2xl bg-muted px-3 py-1.5 text-foreground"
        } ${pending ? "opacity-70" : ""}`}
      >
        <FadingText text={text} />
      </p>
    </div>
  );
});

interface TextPiece {
  id: number;
  text: string;
  fade: boolean;
}

/**
 * A line's words as they arrive: each newly arrived phrase shows whole and
 * fades in, while the words before it stay as they were.
 */
function FadingText({ text }: { text: string }) {
  const [pieces, setPieces] = useState<TextPiece[]>(() => [
    { id: 0, text, fade: false },
  ]);
  const [seen, setSeen] = useState(text);
  if (text !== seen) {
    setSeen(text);
    setPieces(nextTextPieces(pieces, seen, text));
  }
  return pieces.map((piece) =>
    piece.fade ? (
      <span className="voice-live-fade-in" key={piece.id}>
        {piece.text}
      </span>
    ) : (
      <Fragment key={piece.id}>{piece.text}</Fragment>
    ),
  );
}

/**
 * Keeps the pieces the new text still starts with and adds what changed as
 * one fading piece. A transcription that revised earlier words fades in from
 * the first word it changed.
 */
function nextTextPieces(
  pieces: readonly TextPiece[],
  before: string,
  after: string,
): TextPiece[] {
  let common = 0;
  const limit = Math.min(before.length, after.length);
  while (common < limit && before[common] === after[common]) common++;
  // Never split a character made of two UTF-16 units.
  const previous = after.charCodeAt(common - 1);
  if (common > 0 && previous >= 0xd800 && previous <= 0xdbff) common--;
  const kept: TextPiece[] = [];
  let offset = 0;
  for (const piece of pieces) {
    if (offset >= common) break;
    const take = Math.min(piece.text.length, common - offset);
    kept.push(
      take === piece.text.length
        ? piece
        : { ...piece, text: piece.text.slice(0, take) },
    );
    offset += piece.text.length;
  }
  const added = after.slice(common);
  if (!added) return kept;
  const id = pieces.reduce((largest, piece) => Math.max(largest, piece.id), 0);
  return [...kept, { id: id + 1, text: added, fade: true }];
}

/** Conversation Messages sent since this session started, oldest first. */
export function sessionMessages(
  messages: readonly TeamHubMessage[],
  startedAt: string,
) {
  const since = Date.parse(startedAt);
  return messages
    .filter(
      (message) =>
        message.message_kind === "conversation" &&
        Date.parse(message.created_at) >= since &&
        message.raw_message.trim(),
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

/** Where the window is: header drag, kept whole inside the viewport and
 *  remembered per browser. `width` is the width the window is going to, which
 *  a preset eases into; its height follows its content, so it is measured. */
function useDraggablePosition(
  width: number,
  frame: RefObject<HTMLElement | null>,
  inPage: boolean,
) {
  const [position, setPosition] = useState<Position>(() =>
    clampPosition(readPosition() ?? defaultPosition(width), { width }),
  );
  const latest = useRef(position);
  useLayoutEffect(() => {
    latest.current = position;
  });
  const contained = (next: Position) =>
    clampPosition(next, { height: frame.current?.offsetHeight, width });
  // Growing the window or shrinking the viewport keeps all of it on screen.
  // A floated window is not in the page, so its size says nothing here.
  useKeptInViewport(
    frame,
    position,
    setPosition,
    viewportBounds,
    inPage,
    width,
  );
  /** Stores where the window is now for the next session. */
  const remember = () => writePosition(latest.current);
  // Window listeners follow the pointer even when it leaves the header, and a
  // small threshold keeps a plain click on the title a click.
  const dragged = useRef(false);
  const dragHandlers = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0) return;
      const start = { x: event.clientX, y: event.clientY };
      const offset = {
        dx: event.clientX - latest.current.left,
        dy: event.clientY - latest.current.top,
      };
      dragged.current = false;
      const move = (next: PointerEvent) => {
        if (
          !dragged.current &&
          Math.hypot(next.clientX - start.x, next.clientY - start.y) < 4
        )
          return;
        dragged.current = true;
        next.preventDefault();
        setPosition(
          contained({
            left: next.clientX - offset.dx,
            top: next.clientY - offset.dy,
          }),
        );
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (dragged.current) remember();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
  };
  /** True right after a drag, so the title does not also navigate. */
  const consumeDrag = () => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  };
  /** Moves the window to one side at its current height, as a drag would. */
  const place = (side: "left" | "right") => {
    const next = contained({
      left: side === "left" ? windowGap : window.innerWidth,
      top: latest.current.top,
    });
    setPosition(next);
    writePosition(next);
  };
  return {
    consumeDrag,
    dragHandlers,
    moveTo: setPosition,
    place,
    position,
    remember,
  };
}

function defaultPosition(width: number): Position {
  return { left: window.innerWidth - width - windowGap, top: 72 };
}

/** The position moved no further than keeps the whole window 16px inside the
 *  viewport. Its height is known once it is in the page. */
export function clampPosition(
  position: Position,
  {
    height = 0,
    width = windowSizes.compact.width,
  }: { height?: number; width?: number } = {},
): Position {
  return containedVoiceWindowPosition(
    position,
    { height, width },
    viewportBounds(),
  );
}

/** The part of the viewport the in-page window may cover. */
function viewportBounds(): VoiceWindowBounds {
  return {
    bottom: window.innerHeight - windowGap,
    left: windowGap,
    right: window.innerWidth - windowGap,
    top: windowGap,
  };
}

function readPosition(): Position | undefined {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(positionKey) ?? "null",
    );
    if (
      value &&
      typeof value === "object" &&
      typeof (value as Position).left === "number" &&
      typeof (value as Position).top === "number"
    )
      return value as Position;
  } catch {
    // A private window or blocked storage keeps the default corner.
  }
  return undefined;
}

function writePosition(position: Position) {
  try {
    window.localStorage.setItem(positionKey, JSON.stringify(position));
  } catch {
    // Remembering the spot is a convenience only.
  }
}

/** Only this beat follows the microphone level, so the window stays still. */
function VoiceAvatarBeat({
  children,
  listening,
}: {
  children: ReactNode;
  listening: boolean;
}) {
  const level = useVoiceModeLevel();
  return (
    <span
      aria-hidden="true"
      className={styles.avatarBeat}
      data-listening={listening || undefined}
      data-speaking={(listening && level > speakingLevel) || undefined}
      data-voice-avatar
      style={{ "--voice-level": listening ? level : 0 } as CSSProperties}
    >
      {children}
    </span>
  );
}
