import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  RotateClockwiseIcon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";

import { isDesktopShell } from "@/app/desktop-shell";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { useOptionalTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { shouldOpenUrlExternally } from "../url-preview-policy";
import { urlPreviewMessages as m } from "./url-preview.messages";

const previewSandbox = "allow-forms allow-scripts";

// The desktop app keeps the framing rules of a frame named with this prefix
// and reports a refusal through `window.lingerDesktop.preview`. It must match
// the desktop's PREVIEW_FRAME_PREFIX.
const PREVIEW_FRAME_PREFIX = "linger-url-preview:";

interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PreviewViewState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

type PreviewCommand = "back" | "forward" | "reload";

// The desktop app's native previews (see its PreviewViews).
interface DesktopPreviewView {
  open(id: string, url: string): Promise<void>;
  place(id: string, bounds: PreviewBounds): Promise<void>;
  hide(id: string): Promise<void>;
  command(id: string, command: PreviewCommand): Promise<void>;
  close(id: string): Promise<void>;
  onState(callback: (id: string, state: PreviewViewState) => void): () => void;
}

interface DesktopPreview {
  onFrameRefused(
    callback: (frameName: string, url: string) => void,
  ): () => void;
  // Missing in desktop apps that only frame sites.
  view?: DesktopPreviewView;
}

function desktopPreview() {
  return (window as { lingerDesktop?: { preview?: DesktopPreview } })
    .lingerDesktop?.preview;
}

interface RefusedFrame {
  frameKey: string;
  url: string;
}

// The development server proxies previews, so its frames share the app's
// origin and get no storage. The desktop app frames sites directly, even when
// it runs a development server on this computer.
function previewProxied() {
  return import.meta.env.DEV && !isDesktopShell();
}

function previewFrameSrc(url: string) {
  if (!previewProxied()) return url;
  return `/__panel_url_preview?url=${encodeURIComponent(url)}`;
}

function safePreviewUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    return normalizePreviewUrl(value);
  } catch {
    return undefined;
  }
}

function normalizePreviewUrl(value: string) {
  const input = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(input)
    ? input
    : `https://${input}`;
  const url = new URL(candidate);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Not an HTTP(S) URL without credentials.");
  }
  return url.href;
}

export function UrlPreviewPanel({
  hidden = false,
  url,
}: {
  hidden?: boolean;
  url?: string;
}) {
  const view = desktopPreview()?.view;
  // A desktop app that cannot open a view, such as one with every view in
  // use, still frames the site.
  const [nativeFailed, setNativeFailed] = useState(false);
  const key = safePreviewUrl(url) ?? "home";
  return view && !nativeFailed ? (
    <NativeUrlPreview
      hidden={hidden}
      key={key}
      onUnavailable={() => setNativeFailed(true)}
      url={url}
      view={view}
    />
  ) : (
    <FramedUrlPreview hidden={hidden} key={key} url={url} />
  );
}

/** The panel's navigation bar, shared by framed and native previews. */
function PreviewToolbar({
  address,
  canGoBack,
  canGoForward,
  canReload,
  currentUrl,
  invalidAddress,
  onAddressChange,
  onBack,
  onForward,
  onReload,
  onSubmit,
}: {
  address: string;
  canGoBack: boolean;
  canGoForward: boolean;
  canReload: boolean;
  currentUrl: string | undefined;
  invalidAddress: boolean;
  onAddressChange: (value: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onSubmit: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border bg-card px-2">
        <button
          aria-label={t(commonMessages.back)}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={!canGoBack}
          onClick={onBack}
          type="button"
        >
          <Icon icon={ArrowLeft01Icon} size={16} />
        </button>
        <button
          aria-label={t(m.forward)}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={!canGoForward}
          onClick={onForward}
          type="button"
        >
          <Icon icon={ArrowRight01Icon} size={16} />
        </button>
        <button
          aria-label={t(m.reload)}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          disabled={!canReload}
          onClick={onReload}
          type="button"
        >
          <Icon icon={RotateClockwiseIcon} size={14} />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label className="sr-only" htmlFor="panel-url-address">
            {t(m.urlAddress)}
          </label>
          <div>
            <input
              aria-invalid={invalidAddress}
              className="h-8 w-full rounded-lg border border-transparent bg-transparent px-2 text-center text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/50 focus:border-input focus:bg-card focus:text-foreground"
              id="panel-url-address"
              onChange={(event) => onAddressChange(event.target.value)}
              placeholder={t(m.enterUrl)}
              spellCheck={false}
              value={address}
            />
          </div>
        </form>
        {currentUrl ? (
          <a
            aria-label={t(m.openInNewTab)}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            href={currentUrl}
            rel="noopener noreferrer"
            target="_blank"
            title={t(m.openInNewTab)}
          >
            <Icon icon={ArrowUpRight01Icon} size={16} />
          </a>
        ) : null}
      </div>
      {invalidAddress ? (
        <p
          className="border-b border-(--app-status-danger-border) bg-(--app-status-danger-surface) px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {t(m.invalidUrl)}
        </p>
      ) : null}
    </>
  );
}

/** What the panel shows for a site that refuses to be framed. */
function RefusedPage({ url }: { url: string }) {
  const t = useT();
  return (
    <div className="flex flex-col items-start gap-2 p-4 text-sm">
      <p className="font-medium text-foreground">{t(m.openSiteInNewTab)}</p>
      <p className="text-muted-foreground">
        {t(m.siteRefusesFrame, { host: new URL(url).host })}
      </p>
      <a
        className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        href={url}
        rel="noopener noreferrer"
        target="_blank"
      >
        {t(m.openInNewTab)}
        <Icon icon={ArrowUpRight01Icon} size={14} />
      </a>
    </div>
  );
}

/**
 * The page in a browser view the desktop app lays over the panel. A top-level
 * page is not subject to framing rules, so every site shows, signed in with
 * the app's own preview session.
 */
function NativeUrlPreview({
  hidden,
  onUnavailable,
  url,
  view,
}: {
  hidden: boolean;
  onUnavailable: () => void;
  url?: string;
  view: DesktopPreviewView;
}) {
  const t = useT();
  const id = useId();
  const initialUrl = safePreviewUrl(url);
  // Each request loads, even of the URL already shown.
  const [request, setRequest] = useState(
    initialUrl ? { url: initialUrl, seq: 0 } : null,
  );
  const [state, setState] = useState<PreviewViewState | null>(null);
  const [address, setAddress] = useState(initialUrl ?? "");
  const [invalidAddress, setInvalidAddress] = useState(false);
  const shownUrl = useRef(initialUrl);
  const unavailable = useEffectEvent(onUnavailable);
  const currentUrl = state?.url || request?.url;

  useEffect(
    () =>
      view.onState((viewId, next) => {
        if (viewId !== id) return;
        setState(next);
        // The address follows the page, without overwriting typing between
        // reports about the same page.
        if (next.url && next.url !== shownUrl.current) {
          shownUrl.current = next.url;
          setAddress(next.url);
          setInvalidAddress(false);
        }
      }),
    [id, view],
  );

  useEffect(() => {
    if (!request) return;
    view.open(id, request.url).catch(() => unavailable());
  }, [id, request, view]);

  useEffect(
    () => () => {
      void view.close(id).catch(() => undefined);
    },
    [id, view],
  );

  function submit() {
    try {
      const next = normalizePreviewUrl(address);
      shownUrl.current = next;
      setAddress(next);
      setInvalidAddress(false);
      setRequest((previous) => ({ url: next, seq: (previous?.seq ?? 0) + 1 }));
    } catch {
      setInvalidAddress(true);
    }
  }

  function command(name: PreviewCommand) {
    void view.command(id, name).catch(() => undefined);
  }

  return (
    <section
      className={hidden ? "hidden" : "flex h-full min-h-0 flex-col bg-card"}
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <PreviewToolbar
        address={address}
        canGoBack={state?.canGoBack ?? false}
        canGoForward={state?.canGoForward ?? false}
        canReload={Boolean(request)}
        currentUrl={currentUrl}
        invalidAddress={invalidAddress}
        onAddressChange={setAddress}
        onBack={() => command("back")}
        onForward={() => command("forward")}
        onReload={() => command("reload")}
        onSubmit={submit}
      />
      <div className="min-h-0 flex-1 bg-card">
        {!request ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t(m.enterUrlToPreview)}
          </p>
        ) : (
          <NativeViewSurface hidden={hidden} id={id} view={view} />
        )}
      </div>
    </section>
  );
}

// Points inset from the edges, where handles such as the panel's resize
// grip overlap the surface by a few pixels without covering the page.
const SAMPLES = [0.08, 0.3, 0.5, 0.7, 0.92];
// How often an idle panel is checked for moves and covering layers. For a
// moment after input, a transition or a resize, which open menus and move
// the panel, it is checked every frame.
const IDLE_CHECK_MS = 100;
const ACTIVE_WATCH_MS = 400;

function intersects(rect: DOMRect, bounds: PreviewBounds) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left < bounds.x + bounds.width &&
    rect.right > bounds.x &&
    rect.top < bounds.y + bounds.height &&
    rect.bottom > bounds.y
  );
}

// Layers drawn over the app: portals beside its root, open dialogs and
// popovers.
function overlayLayers(element: HTMLElement): Element[] {
  const root = document.getElementById("root");
  const layers = [...document.body.children].filter(
    (child) =>
      child !== root &&
      !child.contains(element) &&
      !(child instanceof HTMLScriptElement),
  );
  try {
    layers.push(...document.querySelectorAll("dialog[open], :popover-open"));
  } catch {
    // Browsers without popovers have none open.
    layers.push(...document.querySelectorAll("dialog[open]"));
  }
  return layers;
}

// Whether anything of the page, such as a menu, dialog, tooltip or toast,
// lies over the surface: the native view would hide it.
function covered(element: HTMLElement, bounds: PreviewBounds) {
  if (
    overlayLayers(element).some((layer) =>
      intersects(layer.getBoundingClientRect(), bounds),
    )
  )
    return true;
  if (typeof document.elementFromPoint !== "function") return false;
  for (const fx of SAMPLES) {
    for (const fy of SAMPLES) {
      const hit = document.elementFromPoint(
        bounds.x + bounds.width * fx,
        bounds.y + bounds.height * fy,
      );
      if (hit && !element.contains(hit)) return true;
    }
  }
  return false;
}

// The part of the surface on screen, or null when the view must hide: the
// surface is hidden, inert or off screen, or the panel is being resized,
// whose pointer the view would take over.
function visibleBounds(element: HTMLElement): PreviewBounds | null {
  if (
    !element.isConnected ||
    document.visibilityState === "hidden" ||
    element.closest("[inert], [data-dragging]")
  )
    return null;
  const rect = element.getBoundingClientRect();
  const x = Math.max(rect.left, 0);
  const y = Math.max(rect.top, 0);
  const width = Math.min(rect.right, window.innerWidth) - x;
  const height = Math.min(rect.bottom, window.innerHeight) - y;
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}

/**
 * Keeps the native view over this element: every frame while the page is
 * active, ten times a second while it is idle. While something of the page
 * covers it, the view hides and the panel shows empty; the page never sees
 * the view's content.
 */
function NativeViewSurface({
  hidden,
  id,
  view,
}: {
  hidden: boolean;
  id: string;
  view: DesktopPreviewView;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hidden) return;
    let frame = 0;
    // The bounds the view was last placed at; null while it is hidden.
    let placed: string | null = null;
    let activeUntil = 0;
    const check = () => {
      const element = ref.current;
      const bounds = element ? visibleBounds(element) : null;
      if (element && bounds && !covered(element, bounds)) {
        const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
        if (key === placed) return;
        placed = key;
        void view.place(id, bounds).catch(() => undefined);
      } else if (placed !== null) {
        placed = null;
        void view.hide(id).catch(() => undefined);
      }
    };
    const everyFrame = () => {
      check();
      frame =
        performance.now() < activeUntil ? requestAnimationFrame(everyFrame) : 0;
    };
    const watch = () => {
      activeUntil = performance.now() + ACTIVE_WATCH_MS;
      if (!frame) frame = requestAnimationFrame(everyFrame);
    };
    const timer = window.setInterval(check, IDLE_CHECK_MS);
    const resized =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(watch);
    if (ref.current) resized?.observe(ref.current);
    window.addEventListener("pointerdown", watch, true);
    window.addEventListener("keydown", watch, true);
    window.addEventListener("focusin", watch, true);
    window.addEventListener("transitionrun", watch, true);
    window.addEventListener("animationstart", watch, true);
    window.addEventListener("resize", watch);
    window.addEventListener("scroll", watch, true);
    watch();
    return () => {
      window.clearInterval(timer);
      cancelAnimationFrame(frame);
      resized?.disconnect();
      window.removeEventListener("pointerdown", watch, true);
      window.removeEventListener("keydown", watch, true);
      window.removeEventListener("focusin", watch, true);
      window.removeEventListener("transitionrun", watch, true);
      window.removeEventListener("animationstart", watch, true);
      window.removeEventListener("resize", watch);
      window.removeEventListener("scroll", watch, true);
      if (placed !== null) void view.hide(id).catch(() => undefined);
    };
  }, [hidden, id, view]);

  return <div className="h-full w-full bg-white" ref={ref} />;
}

/**
 * The page in a sandboxed frame: in browsers, and in desktop apps without
 * native previews. Sites that refuse frames get a link to a new tab instead.
 */
function FramedUrlPreview({
  hidden = false,
  url,
}: {
  hidden?: boolean;
  url?: string;
}) {
  const t = useT();
  const initialUrl = safePreviewUrl(url);
  const [history, setHistory] = useState<string[]>(
    initialUrl ? [initialUrl] : [],
  );
  const [index, setIndex] = useState(initialUrl ? 0 : -1);
  const [address, setAddress] = useState(initialUrl ?? "");
  const [invalidAddress, setInvalidAddress] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameName = PREVIEW_FRAME_PREFIX + useId();
  const [refusedFrame, setRefusedFrame] = useState<RefusedFrame | null>(null);
  const currentUrl = history[index];
  const frameKey = `${currentUrl}:${reloadKey}`;
  const refused = refusedFrame?.frameKey === frameKey ? refusedFrame : null;
  const externalOnly = currentUrl
    ? shouldOpenUrlExternally(new URL(currentUrl))
    : false;

  useEffect(
    () =>
      desktopPreview()?.onFrameRefused((name, url) => {
        if (name === frameName) setRefusedFrame({ frameKey, url });
      }),
    [frameKey, frameName],
  );

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type !== "linger-preview-navigate" || !data.url) return;
      navigate(data.url, false);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  function navigate(value: string, fromUser = true) {
    try {
      const url = normalizePreviewUrl(value);
      if (fromUser && shouldOpenUrlExternally(new URL(url))) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      const next = [...history.slice(0, index + 1), url];
      setHistory(next);
      setIndex(next.length - 1);
      setAddress(url);
      setInvalidAddress(false);
    } catch {
      setInvalidAddress(true);
    }
  }

  function move(nextIndex: number) {
    const url = history[nextIndex];
    if (!url) return;
    setIndex(nextIndex);
    setAddress(url);
    setInvalidAddress(false);
  }

  return (
    <section
      className={hidden ? "hidden" : "flex h-full min-h-0 flex-col bg-card"}
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <PreviewToolbar
        address={address}
        canGoBack={index > 0}
        canGoForward={index >= 0 && index < history.length - 1}
        canReload={Boolean(currentUrl) && !externalOnly}
        currentUrl={currentUrl}
        invalidAddress={invalidAddress}
        onAddressChange={setAddress}
        onBack={() => move(index - 1)}
        onForward={() => move(index + 1)}
        onReload={() => setReloadKey((value) => value + 1)}
        onSubmit={() => navigate(address)}
      />
      <div className="min-h-0 flex-1 bg-card">
        {!currentUrl ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t(m.enterUrlToPreview)}
          </p>
        ) : externalOnly ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t(m.openInBrowserTab)}
          </p>
        ) : refused ? (
          <RefusedPage url={refused.url} />
        ) : (
          <FramingCheck url={currentUrl}>
            <iframe
              className="h-full w-full border-0 bg-white"
              key={frameKey}
              name={frameName}
              ref={frameRef}
              sandbox={
                previewProxied()
                  ? previewSandbox
                  : `${previewSandbox} allow-same-origin`
              }
              src={previewFrameSrc(currentUrl)}
              title={t(m.previewTitle, { url: currentUrl })}
            />
          </FramingCheck>
        )}
      </div>
    </section>
  );
}

/**
 * In a browser, which cannot read a cross-origin frame's response headers,
 * TeamHub reads the site's framing rules before the frame shows. The desktop
 * app reports refusals itself, and the development server's proxy frames
 * every site.
 */
function FramingCheck({ children, url }: { children: ReactNode; url: string }) {
  const runtime = useOptionalTeamHubRuntime();
  if (!runtime || isDesktopShell() || previewProxied()) return children;
  return (
    <ProbedFrame client={runtime.client} url={url}>
      {children}
    </ProbedFrame>
  );
}

// The scheme of this page, against which TeamHub matches frame-ancestors.
function pageScheme() {
  const scheme = window.location.protocol.slice(0, -1);
  return scheme === "http" || scheme === "https" ? scheme : undefined;
}

/**
 * Loads the frame, out of sight, while TeamHub reads the site's rules, and
 * replaces it with a link to a new tab when the site refuses frames.
 */
function ProbedFrame({
  children,
  client,
  url,
}: {
  children: ReactNode;
  client: TeamHubClient;
  url: string;
}) {
  const t = useT();
  const framing = useQuery({
    queryKey: ["teamhub", "url-preview-framing", url],
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/url-preview/framing", {
          params: { query: { url, page_scheme: pageScheme() } },
        }),
      ),
    retry: false,
    staleTime: 5 * 60_000,
  });
  // The original address, not where a cookieless request was redirected,
  // so a signed-in person lands on the page they opened.
  if (framing.data?.framing === "refused") return <RefusedPage url={url} />;
  // A TeamHub without the check, or one that failed, leaves it to the frame.
  return (
    <div className="relative h-full">
      {framing.isPending ? (
        <div
          aria-label={t(m.checkingSite)}
          className="absolute inset-0 flex items-center justify-center bg-card text-muted-foreground"
          role="status"
        >
          <Spinner size={18} />
        </div>
      ) : null}
      <div className={framing.isPending ? "invisible h-full" : "h-full"}>
        {children}
      </div>
    </div>
  );
}
