import {
  ArrowDown01Icon,
  Mic01Icon,
  MicOff01Icon,
  RotateLeft01Icon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AutoHeight } from "@/components/ui/auto-height";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMatch, useNavigate } from "react-router";

import { cn } from "@/lib/cn";
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
import {
  voiceModeStatusLabel,
  voiceWindowStatus,
} from "./voice-mode-presentation";
import styles from "./voice-mode.module.css";
import { registerVoiceWindow, type VoiceWindowAction } from "./voice-ui-bridge";
import { onVoicePipClosedByHuman, useVoicePip } from "./voice-pip";
import {
  containedVoiceWindowPosition,
  useKeptInViewport,
  VoiceWindowResizeHandles,
  type VoiceWindowBounds,
} from "./voice-window-resize";
import { FadingText } from "./fading-text";
import { showVoiceNotice, useVoiceNotice } from "./voice-notice";
import { voiceWindowMessages as m } from "./voice-window.messages";
import {
  useOptionalVoiceModeSession,
  useVoiceModeLevel,
  type VoiceModeSession,
} from "./voice-mode-session";

/** About the island's width with all its controls out. */
const islandWidth = 360;
/** The island bar's height; the conversation opens below it. */
const islandHeight = 48;
/** A floated window's height with its conversation open. */
const floatedConversationHeight = 480;
/**
 * The handset laid down, as phones draw hanging up: level and symmetric.
 * The icon set's handsets only lie askew when turned, so this one is drawn
 * here in its format.
 */
const hangUpIcon: IconSvgElement = [
  [
    "path",
    {
      d: "M2.9 15.8V11.6C2.9 9.6 7 8 12 8C17 8 21.1 9.6 21.1 11.6V15.8Q21.1 16.6 20.3 16.6H16.2Q15.4 16.6 15.4 15.8V12.9C14.3 12.5 13.2 12.3 12 12.3C10.8 12.3 9.7 12.5 8.6 12.9V15.8Q8.6 16.6 7.8 16.6H3.7Q2.9 16.6 2.9 15.8Z",
      stroke: "currentColor",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "0",
    },
  ],
];
/** A status line under the conversation (a notice, pending selections). */
const statusRowHeight = 29;
// The height of the conversation below the island: never more than leaves
// the whole window 16px inside the page.
const conversationHeight = "min(480px,70dvh,100dvh - 80px)";
/** Still shows the island's controls and a few lines of the conversation. */
const minWindowSize = { height: 200, width: islandWidth };
const windowGap = 16;
const positionKey = "linger:voice-mode-window";
/** Above this level the Human is speaking, not just breathing near the mic. */
const speakingLevel = 0.08;

interface Position {
  left: number;
  top: number;
}

/**
 * The running Voice Mode session as an island: it follows the Human across
 * Rooms, folds this session's turns and the Room's replies under it, and in
 * the page can be dragged anywhere on screen and resized by its edges and
 * corners. In the desktop app it lives in that app's always-on-top window
 * instead, so it stays over other apps; browsers keep it in the page.
 * Hanging up, or closing the desktop's window, ends Voice Mode: the window
 * leaves at once while the session drains its last words in the background,
 * and the Room composer shows that finishing state.
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
  const { roomId, tenantId } = session.target;
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
  // Only the desktop app floats Voice Mode, in a window with no back to tab
  // button: closing that window ends the call. Once it has floated, losing
  // the window shows nothing in the page, so no window flashes up before
  // Voice Mode ends.
  const exitRef = useRef(onExit);
  useLayoutEffect(() => {
    exitRef.current = onExit;
  });
  const [floated, setFloated] = useState(false);
  if (pip && !floated) setFloated(true);
  const leavingPip = floated && !pip;
  useEffect(
    () => onVoicePipClosedByHuman("voice-mode", () => exitRef.current()),
    [],
  );

  // Every session opens as the island alone. Its arrow opens the
  // conversation below; dragging an edge or corner of the open window gives
  // it any other size, which it keeps as the conversation closes (the width)
  // and opens again (the height). A floated window grows and shrinks with it,
  // inside the click that asked, keeping the size the Human gave it too.
  const [open, setOpen] = useState(false);
  const [resized, setResized] = useState<{ height: number; width: number }>();
  const showConversation = open;
  const floatedOpenSize = useRef<{ height: number; width: number }>(undefined);
  // A floated window's conversation is as tall as the window leaves it.
  const [floatedBody, setFloatedBody] = useState<number>();
  const openConversation = (next: boolean) => {
    if (!pip) return setOpen(next);
    const target = floatedTarget(pip, next, floatedOpenSize.current);
    floatedOpenSize.current = target.openSize;
    if (next) {
      setFloatedBody(target.body);
      setOpen(true);
      animateFloated(pip, target.height);
    }
    // The window shuts over the conversation, which goes once it is hidden.
    else animateFloated(pip, target.height, () => setOpen(false));
  };
  // A floated window the Human resizes gives its conversation the new height;
  // the window's own open and close animation already sets it.
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    if (!pip) return;
    const fit = () => {
      if (!floatedFrame && openRef.current)
        setFloatedBody(pip.innerHeight - islandHeight);
    };
    pip.addEventListener("resize", fit);
    return () => pip.removeEventListener("resize", fit);
  }, [pip]);
  const frameRef = useRef<HTMLElement>(null);
  const { consumeDrag, dragHandlers, moveTo, place, position, remember } =
    useDraggablePosition(
      resized?.width ?? islandWidth,
      frameRef,
      !pip && !leavingPip,
    );
  const windowControl = useRef<(action: VoiceWindowAction) => void>(() => {});
  useLayoutEffect(() => {
    windowControl.current = (action) => {
      if (action === "mute" || action === "unmute")
        void onMute(action === "mute");
      // Spoken expand and shrink fold the conversation as the arrow does,
      // floated or not; the desktop places its window, so only a drag moves it.
      else if (action === "expand" || action === "shrink")
        openConversation(action === "expand");
      else if (pip) showVoiceNotice(translate(m.dragHint));
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
  }, [pip, showConversation]);

  const state = session.state;
  const muted = session.muted;
  // A live call wakes up until the live model itself is connected, even once
  // the microphone is heard; dictation wakes up until it listens.
  const waking =
    state.status === "connecting" ||
    state.status === "idle" ||
    Boolean(session.live?.waking);
  const listening = Boolean(state.microphoneActive) && !muted && !waking;
  // Another Me leans in once each time the call wakes up.
  const [cheer, setCheer] = useState(0);
  const [wasWaking, setWasWaking] = useState(waking);
  if (waking !== wasWaking) {
    setWasWaking(waking);
    if (!waking) setCheer(cheer + 1);
  }
  const status = t(
    voiceWindowStatus(
      { ...state, entered: session.entered },
      { muted, waking: session.live?.waking },
    ),
  );
  // The conversation is as tall as its words up to a preset; a dragged or
  // floated window gives it whatever its own height leaves below the island.
  const footerHeight =
    (notice ? statusRowHeight : 0) + (pendingMaterials ? statusRowHeight : 0);
  const conversationSize: CSSProperties = pip
    ? {
        height:
          (floatedBody ?? floatedConversationHeight - islandHeight) -
          footerHeight,
      }
    : resized
      ? { height: resized.height - islandHeight - footerHeight }
      : { maxHeight: `calc(${conversationHeight})` };
  if (leavingPip) return null;
  const conversationLog = (
    <div
      aria-label={t(m.conversation)}
      aria-live="polite"
      className="workspace-scrollbar min-h-24 overflow-y-auto border-t border-app-border px-3 py-3"
      onScroll={(event) => {
        const element = event.currentTarget;
        const top = element.scrollTop;
        const atBottom = element.scrollHeight - top - element.clientHeight < 24;
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
      style={conversationSize}
    >
      <div className="space-y-2" ref={contentRef}>
        {(transcript ? transcript.length : turns.length || replying.length) ||
        live ? null : (
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
              <Bubble author={t(commonMessages.you)} own pending text={heard} />
            ) : null}
          </>
        )}
        {saying ? (
          <Bubble author={t(commonMessages.you)} own pending text={saying} />
        ) : null}
      </div>
    </div>
  );
  return createPortal(
    <section
      aria-label={t(m.window)}
      className={
        pip
          ? cn(
              // The island stays at the top, so the window can grow and
              // shrink under it without the island moving.
              "flex h-dvh w-full flex-col bg-app-voice-island",
            )
          : // One width open or not, so nothing on the island moves; the
            // island alone is 48px tall, so 24px corners make it a pill.
            "voice-mode-window app-floating-enter fixed z-[90] flex max-h-[calc(100dvh-32px)] max-w-[calc(100vw-32px)] flex-col rounded-3xl bg-app-voice-island shadow-xl"
      }
      data-pip={pip ? true : undefined}
      data-size={
        resized ? "custom" : showConversation ? "conversation" : "island"
      }
      // Voice Mode finds its own window by this, whatever the language.
      data-voice-window=""
      ref={frameRef}
      style={
        pip
          ? undefined
          : resized
            ? showConversation
              ? { ...position, ...resized }
              : { ...position, width: resized.width }
            : { ...position, width: islandWidth }
      }
    >
      {/* Clips the content to the window's corners; the resize handles sit
          outside it, on the border. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        {/* The island is the window's draggable bar: Another Me, what the
            call is doing, the voice, and the call's controls. */}
        <header
          className={cn(
            "flex shrink-0 select-none items-center gap-2 bg-app-voice-island py-1.5 pl-2 pr-1.5 text-app-voice-island-ink",
            pip ? "" : "cursor-grab touch-none active:cursor-grabbing",
          )}
          style={{ height: islandHeight }}
          {...(pip ? {} : dragHandlers)}
        >
          <VoiceAvatarBeat listening={listening} waking={waking}>
            <ActorAvatar
              actorId={anotherMeActorId}
              cheer={cheer}
              kind="agent"
              name="Another Me"
              size="xs"
            />
          </VoiceAvatarBeat>
          <button
            className="min-w-[72px] truncate rounded text-left text-[14px] font-semibold leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
            onClick={() => {
              if (!consumeDrag())
                void navigate(`/t/${tenantId}/rooms/${roomId}/chat`);
            }}
            title={t(m.openConversation)}
            type="button"
          >
            {status}
          </button>
          <span className="sr-only" role="status">
            {voiceModeStatusLabel({ ...state, entered: session.entered }, t)}
          </span>
          <IslandWave active={listening} />
          <span
            className="ml-auto flex shrink-0 items-center gap-1.5"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span className="flex items-center gap-1.5">
              {state.canRetry ? (
                <IslandButton
                  // Names differ from the Room composer's controls so both
                  // can be on screen without two identically named buttons.
                  aria-label={t(m.retry)}
                  disabled={state.sending}
                  onClick={onRetry}
                >
                  <Icon icon={RotateLeft01Icon} size={16} />
                </IslandButton>
              ) : null}
              <IslandButton
                aria-label={t(muted ? m.unmute : m.mute)}
                aria-pressed={muted}
                disabled={!state.microphoneActive}
                onClick={() => void onMute(!muted)}
              >
                <Icon icon={muted ? MicOff01Icon : Mic01Icon} size={16} />
              </IslandButton>
              {soundOff === undefined ? null : (
                <IslandButton
                  aria-label={t(soundOff ? m.replySoundOn : m.replySoundOff)}
                  aria-pressed={soundOff}
                  onClick={() => onSoundOff(!soundOff)}
                >
                  <Icon
                    icon={soundOff ? VolumeOffIcon : VolumeHighIcon}
                    size={16}
                  />
                </IslandButton>
              )}
              <IslandButton
                aria-expanded={open}
                // Closing the conversation is how Voice Mode closes it.
                data-voice-close={open ? "" : undefined}
                aria-label={t(open ? m.hideConversation : m.showConversation)}
                onClick={() => openConversation(!open)}
              >
                <Icon
                  className={cn(
                    "transition-transform duration-300 motion-reduce:transition-none",
                    open && "rotate-180",
                  )}
                  icon={ArrowDown01Icon}
                  size={16}
                />
              </IslandButton>
            </span>
            {/* Not marked risky: ending Voice Mode from its window is never
                confirmed, as its English name never was. */}
            <button
              aria-label={t(m.end)}
              className="grid size-9 place-items-center rounded-full bg-app-voice-end text-white transition-[background-color,transform] hover:bg-app-voice-end-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus active:scale-90"
              onClick={onExit}
              type="button"
            >
              <Icon icon={hangUpIcon} size={20} />
            </button>
          </span>
        </header>
        {/* In the page the conversation slides open and shut under the
            island with the chat's own resize timing; a floated window moves
            itself, with the same timing, over a conversation that holds
            still. */}
        {pip ? (
          showConversation ? (
            <div className="bg-app-canvas">{conversationLog}</div>
          ) : null
        ) : (
          <AutoHeight className="bg-app-canvas" open={showConversation}>
            {conversationLog}
          </AutoHeight>
        )}
        {notice ? (
          <p
            className="h-[29px] shrink-0 truncate border-t border-app-border bg-app-canvas px-3 py-1.5 text-[12px] leading-4 text-app-muted"
            role="status"
          >
            {notice}
          </p>
        ) : null}
        {pendingMaterials ? (
          <p className="h-[29px] shrink-0 truncate border-t border-app-border bg-app-canvas px-3 py-1.5 text-[12px] leading-4 text-app-muted">
            {t(m.pendingSelections, { count: pendingMaterials })}
          </p>
        ) : null}
      </div>
      {pip || !showConversation ? null : (
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
  { height = 0, width = islandWidth }: { height?: number; width?: number } = {},
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

/**
 * The height a floated window takes for the island alone or the open
 * conversation, the open size to come back to, and the conversation's own
 * height in it. The width stays the Human's.
 */
function floatedTarget(
  view: Window,
  open: boolean,
  openSize: { height: number; width: number } | undefined,
) {
  const chromeHeight = view.outerHeight - view.innerHeight;
  const opened = openSize?.height ?? floatedConversationHeight + chromeHeight;
  return {
    body: opened - chromeHeight - islandHeight,
    height: open ? opened : islandHeight + chromeHeight,
    openSize: open
      ? openSize
      : { height: view.outerHeight, width: view.outerWidth },
  };
}

let floatedFrame: { view: Window; id: number } | undefined;

/**
 * Moves a floated window's height with the in-page conversation's timing
 * (`--chat-resize-duration`, `--app-out-quint`), one frame at a time, so
 * opening and closing read the same in the page and floated.
 */
function animateFloated(view: Window, height: number, done?: () => void) {
  if (floatedFrame) floatedFrame.view.cancelAnimationFrame(floatedFrame.id);
  floatedFrame = undefined;
  const to = Math.min(height, view.screen.availHeight || height);
  const width = view.outerWidth;
  const resize = (next: number) => {
    try {
      view.resizeTo(width, Math.round(next));
    } catch {
      // The Human can still drag the window to size.
    }
  };
  const duration =
    Number.parseFloat(
      view
        .getComputedStyle?.(view.document.documentElement)
        .getPropertyValue("--chat-resize-duration") ?? "",
    ) * 1000 || 280;
  const still =
    !view.requestAnimationFrame ||
    view.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (still) {
    resize(to);
    return done?.();
  }
  const from = view.outerHeight;
  const start = view.performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / duration);
    resize(from + (to - from) * outQuint(progress));
    if (progress < 1)
      floatedFrame = { view, id: view.requestAnimationFrame(step) };
    else {
      floatedFrame = undefined;
      done?.();
    }
  };
  floatedFrame = { view, id: view.requestAnimationFrame(step) };
}

/** `--app-out-quint`, cubic-bezier(0, 0, 0.2, 1), at `progress` in [0, 1]. */
function outQuint(progress: number) {
  let s = progress;
  for (let i = 0; i < 8; i++) {
    const x = 0.6 * (1 - s) * s * s + s * s * s;
    const slope = 0.6 * (2 * s - 3 * s * s) + 3 * s * s;
    if (Math.abs(slope) < 1e-6) break;
    s = Math.min(1, Math.max(0, s - (x - progress) / slope));
  }
  return 3 * (1 - s) * s * s + s * s * s;
}

/** Only the avatar follows the microphone level, so the window stays still. */
function VoiceAvatarBeat({
  children,
  listening,
  waking,
}: {
  children: ReactNode;
  listening: boolean;
  waking: boolean;
}) {
  const level = useVoiceModeLevel();
  return (
    <span
      aria-hidden="true"
      className={styles.avatarBeat}
      data-listening={listening || undefined}
      data-speaking={(listening && level > speakingLevel) || undefined}
      data-voice-avatar
      data-waking={waking || undefined}
      style={{ "--voice-level": listening ? level : 0 } as CSSProperties}
    >
      {children}
    </span>
  );
}

function IslandButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-full bg-app-voice-island-control text-app-voice-island-ink transition-colors hover:bg-app-voice-island-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus disabled:opacity-40 aria-pressed:bg-app-voice-island-ink aria-pressed:text-app-voice-island",
        className,
      )}
      type="button"
      {...props}
    />
  );
}

const islandBars = [0, 1, 2, 3];

/**
 * Four pill bars that rise from their middle with the voice. The level is
 * eased (a fast rise, a slow fall) so the bars never jitter, each bar sways
 * a little out of step so they read as speech, and in silence they rest as
 * dots that bob gently. Frames come from the window the bars are drawn in,
 * so a floated call keeps moving while its tab is hidden.
 */
function IslandWave({ active }: { active: boolean }) {
  const level = useVoiceModeLevel();
  const target = useRef(0);
  useLayoutEffect(() => {
    target.current = active ? Math.sqrt(Math.min(1, Math.max(0, level))) : 0;
  });
  const waveRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const wave = waveRef.current;
    const view = wave?.ownerDocument.defaultView;
    if (!wave || !view?.requestAnimationFrame) return;
    const bars = [...wave.children] as HTMLElement[];
    const still = view.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let eased = 0;
    let frame = 0;
    const draw = (now: number) => {
      const goal = target.current;
      eased = still
        ? goal
        : eased + (goal - eased) * (goal > eased ? 0.35 : 0.08);
      const time = now / 1000;
      bars.forEach((bar, index) => {
        const inner = index === 1 || index === 2 ? 1 : 0.7;
        const lift =
          eased < 0.04
            ? still
              ? 0
              : 0.04 + 0.04 * Math.sin(time * 3 + index * 0.9)
            : Math.min(
                1,
                eased *
                  inner *
                  (still ? 1 : 0.6 + 0.4 * Math.sin(time * 9 + index * 1.7)) *
                  1.15,
              );
        bar.style.height = `${4 + lift * 20}px`;
      });
      frame = view.requestAnimationFrame(draw);
    };
    frame = view.requestAnimationFrame(draw);
    return () => view.cancelAnimationFrame(frame);
  }, []);
  return (
    <span aria-hidden="true" className={styles.islandWave} ref={waveRef}>
      {islandBars.map((bar) => (
        <i key={bar} />
      ))}
    </span>
  );
}
