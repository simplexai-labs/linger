import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  BYOK_PROTOCOL_ENDPOINTS,
  DEFAULT_BYOK_PATH,
  byokProtocolFor,
  defaultByokEndpoint,
  normalizeByokBaseUrl,
  normalizeByokPath,
  validByokPath,
  type ByokRuntime,
} from "@linger/service-kit/byok-endpoint";
import type { components } from "@linger/wire-contracts/linger-installer/types";
import { request } from "./api.js";

type ByokProtocol = components["schemas"]["ByokProtocol"];
type ByokEndpoint = components["schemas"]["ByokEndpoint"];
type ByokCheckReport = components["schemas"]["ByokCheckReport"];
type ByokModelReport = components["schemas"]["ByokModelReport"];

/** What the person typed. A null endpoint follows the runtime's default. */
export interface ByokDraft {
  runtime: ByokRuntime;
  baseUrl: string;
  path: string;
  endpoint: string | null;
  apiKey: string;
  modelId: string;
}

const RUNTIME_LABELS: Record<ByokRuntime, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};
const FORMATS: Record<ByokProtocol, { ending: string; label: string }> = {
  "openai-chat": {
    ending: BYOK_PROTOCOL_ENDPOINTS["openai-chat"],
    label: "OpenAI Chat Completions",
  },
  "openai-responses": {
    ending: BYOK_PROTOCOL_ENDPOINTS["openai-responses"],
    label: "OpenAI Responses",
  },
  anthropic: {
    ending: BYOK_PROTOCOL_ENDPOINTS.anthropic,
    label: "Anthropic Messages",
  },
};
const PATH_OPTIONS: ComboItem[] = [
  { value: DEFAULT_BYOK_PATH, label: "Most providers", tag: "Default" },
  { value: "/api/paas/v4", label: "Zhipu GLM (base https://open.bigmodel.cn)" },
  { value: "/api/v3", label: "Volcano Engine Ark" },
  { value: "/v1beta/openai", label: "Gemini" },
  { value: "", label: "No path. The base URL already has it." },
];

export const emptyByokDraft: ByokDraft = {
  runtime: "claude",
  baseUrl: "",
  path: DEFAULT_BYOK_PATH,
  endpoint: null,
  apiKey: "",
  modelId: "",
};

function requestUrl(endpoint: ByokEndpoint): string {
  return endpoint.baseUrl + endpoint.path + endpoint.endpoint;
}
function modelsUrl(endpoint: ByokEndpoint): string {
  return `${endpoint.baseUrl}${endpoint.path}/models`;
}

/** The address and key the draft names, as the installer API takes them. */
export function byokEndpoint(draft: ByokDraft): ByokEndpoint {
  const baseUrl = normalizeByokBaseUrl(draft.baseUrl);
  const path = normalizeByokPath(draft.path);
  const endpoint = normalizeByokPath(
    draft.endpoint ?? defaultByokEndpoint(draft.runtime),
  );
  const apiKey = draft.apiKey.trim();
  return {
    baseUrl,
    path,
    endpoint,
    protocol: byokProtocolFor(baseUrl + path + endpoint, draft.runtime)
      .protocol,
    ...(apiKey ? { apiKey } : {}),
  };
}

/** Why the draft's address cannot be sent, if it cannot. */
export function byokAddressProblem(
  draft: ByokDraft,
): { field: "base" | "path" | "endpoint"; message: string } | undefined {
  const endpoint = byokEndpoint(draft);
  if (!validByokPath(endpoint.path))
    return {
      field: "path",
      message: "Path must be empty or a path such as /v1.",
    };
  if (!validByokPath(endpoint.endpoint))
    return {
      field: "endpoint",
      message: "Endpoint must be empty or a path such as /chat/completions.",
    };
  if (!/^https?:\/\/[^/]/i.test(endpoint.baseUrl))
    return {
      field: "base",
      message: "Enter a base URL that starts with https:// or http://.",
    };
}

function contextLabel(tokens: number): string {
  return tokens >= 1_048_576
    ? `${Math.round((tokens / 1_048_576) * 10) / 10}M`
    : `${Math.round(tokens / 1024)}k`;
}
function failure(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Could not reach the BYOK endpoint.";
}

type Listing =
  | { state: "loading" }
  | { state: "ok"; report: ByokModelReport }
  | { state: "failed"; message: string };
type Check =
  | { state: "checking" }
  | { state: "ok"; report: ByokCheckReport }
  | { state: "failed"; message: string };
type Menu = "path" | "endpoint" | "model";

export function ByokPanel({
  draft,
  onDraftChange,
}: {
  draft: ByokDraft;
  onDraftChange: Dispatch<SetStateAction<ByokDraft>>;
}) {
  const [listing, setListing] = useState<Listing>();
  const [check, setCheck] = useState<Check>();
  const [toast, setToast] = useState<{ leaving: boolean }>();
  const [menu, setMenu] = useState<Menu>();
  const [baseTouched, setBaseTouched] = useState(false);
  const checkRun = useRef(0);
  const listRun = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const endpoint = byokEndpoint(draft);
  const url = requestUrl(endpoint);
  const format = byokProtocolFor(url, draft.runtime);
  const problem = byokAddressProblem(draft);
  const hasBase = endpoint.baseUrl !== "";
  const hasModel = draft.modelId.trim() !== "";

  const hideToast = useCallback(() => {
    clearTimeout(toastTimer.current);
    setToast((current) => (current ? { leaving: true } : current));
    toastTimer.current = setTimeout(() => setToast(undefined), 200);
  }, []);
  // A success fades on its own; a failure stays until dismissed or the input changes.
  const showToast = useCallback(
    (fades: boolean) => {
      clearTimeout(toastTimer.current);
      setToast({ leaving: false });
      if (fades) toastTimer.current = setTimeout(hideToast, 3500);
    },
    [hideToast],
  );
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => {
    if (!toast && !menu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (toast && !target?.closest(".byok-toast, .byok-test")) hideToast();
      if (menu && !target?.closest(`[data-combo="${menu}"]`))
        setMenu(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [toast, menu, hideToast]);

  // A changed address or key makes an earlier listing stale; any change makes the test stale.
  function change(scope: "address" | "check", next: SetStateAction<ByokDraft>) {
    onDraftChange(next);
    checkRun.current += 1;
    setCheck(undefined);
    clearTimeout(toastTimer.current);
    setToast(undefined);
    if (scope === "address") {
      listRun.current += 1;
      setListing(undefined);
    }
  }

  async function runCheck() {
    const run = ++checkRun.current;
    if (problem) {
      setCheck({ state: "failed", message: problem.message });
      showToast(false);
      return;
    }
    setToast(undefined);
    setCheck({ state: "checking" });
    try {
      const report = await request<ByokCheckReport>("/byok/check", {
        ...endpoint,
        modelId: draft.modelId.trim(),
      });
      if (run !== checkRun.current) return;
      setCheck({ state: "ok", report });
      showToast(true);
    } catch (error) {
      if (run !== checkRun.current) return;
      setCheck({ state: "failed", message: failure(error) });
      showToast(false);
    }
  }
  async function listModels() {
    const run = ++listRun.current;
    setMenu(undefined);
    if (problem) {
      setListing({ state: "failed", message: problem.message });
      return;
    }
    setListing({ state: "loading" });
    try {
      const report = await request<ByokModelReport>("/byok/models", endpoint);
      if (run !== listRun.current) return;
      setListing({ state: "ok", report });
      setMenu("model");
    } catch (error) {
      if (run !== listRun.current) return;
      setListing({ state: "failed", message: failure(error) });
    }
  }

  const checking = check?.state === "checking";
  const listingNow = listing?.state === "loading";
  const runtimeDefault = defaultByokEndpoint(draft.runtime);
  const sends = (
    <>
      {"Sends "}
      {FORMATS[format.protocol].label}
      {format.fromUrl ? "" : ` (the ${RUNTIME_LABELS[draft.runtime]} format)`}
      {" requests to "}
      <span className="url">{url}</span>
    </>
  );
  // Path and endpoint problems show at once; a base URL problem waits until the box is left.
  const shownProblem =
    problem && (baseTouched || problem.field !== "base")
      ? problem.message
      : undefined;
  const status: { tone?: "err"; text: ReactNode } =
    listing?.state === "failed"
      ? { tone: "err", text: listing.message }
      : listingNow
        ? {
            text: (
              <>
                {"Listing models from "}
                <span className="url">{modelsUrl(endpoint)}</span>…
              </>
            ),
          }
        : hasBase && shownProblem
          ? { tone: "err", text: shownProblem }
          : hasBase
            ? { text: sends }
            : {
                text: "Grey values are defaults. Path and endpoint are optional.",
              };

  const models = listing?.state === "ok" ? listing.report.models : [];
  const modelNote: { tone?: "err"; text: ReactNode } =
    listing?.state === "ok"
      ? {
          text: (
            <>
              {models.length} {models.length === 1 ? "model" : "models"}
              {" from "}
              <span className="url">{listing.report.url}</span>
            </>
          ),
        }
      : listing?.state === "failed"
        ? { tone: "err", text: listing.message }
        : listingNow
          ? { text: "Listing models…" }
          : {
              text: "Use the refresh button to list the endpoint's models, or type an ID.",
            };

  return (
    <div className="byok-panel">
      <div className="byok-runtime">
        <span id="byok-runtime-label">{"AI runtime"}</span>
        <div
          className="byok-segments"
          role="radiogroup"
          aria-labelledby="byok-runtime-label"
        >
          {(Object.keys(RUNTIME_LABELS) as ByokRuntime[]).map((runtime) => (
            <label key={runtime}>
              <input
                type="radio"
                name="byok-runtime"
                value={runtime}
                checked={draft.runtime === runtime}
                onChange={() =>
                  change("check", (current) => ({ ...current, runtime }))
                }
              />
              <span>{RUNTIME_LABELS[runtime]}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="byok-address">
        <span className="byok-base">
          <input
            type="url"
            aria-label="Base URL"
            placeholder="Base URL (https://…)"
            autoComplete="off"
            spellCheck={false}
            maxLength={2048}
            value={draft.baseUrl}
            onChange={(event) => {
              const baseUrl = event.target.value;
              change("address", (current) => ({ ...current, baseUrl }));
            }}
            onBlur={() => {
              setBaseTouched(true);
              onDraftChange((current) => ({
                ...current,
                baseUrl: normalizeByokBaseUrl(current.baseUrl),
              }));
            }}
          />
        </span>
        <Combobox
          kind="path"
          label="Path"
          fit
          heading="Path · optional"
          value={draft.path}
          isDefault={draft.path === DEFAULT_BYOK_PATH}
          items={PATH_OPTIONS}
          open={menu === "path"}
          onOpenChange={(open) => setMenu(open ? "path" : undefined)}
          onInput={(path) =>
            change("address", (current) => ({ ...current, path }))
          }
          onCommit={() =>
            onDraftChange((current) => ({
              ...current,
              path: normalizeByokPath(current.path),
            }))
          }
        />
        <Combobox
          kind="endpoint"
          label="Endpoint"
          fit
          heading="Endpoint · optional"
          value={draft.endpoint ?? runtimeDefault}
          isDefault={draft.endpoint === null}
          items={[
            ...Object.values(FORMATS).map(({ ending, label }) => ({
              value: ending,
              label,
              ...(ending === runtimeDefault
                ? { tag: `${RUNTIME_LABELS[draft.runtime]} default` }
                : {}),
            })),
            {
              value: "",
              label: "No endpoint. The base URL is the full address.",
            },
          ]}
          open={menu === "endpoint"}
          onOpenChange={(open) => setMenu(open ? "endpoint" : undefined)}
          onInput={(value) =>
            change("check", (current) => ({
              ...current,
              endpoint:
                value === defaultByokEndpoint(current.runtime) ? null : value,
            }))
          }
          onCommit={() =>
            onDraftChange((current) => {
              if (current.endpoint === null) return current;
              const value = normalizeByokPath(current.endpoint);
              return {
                ...current,
                endpoint:
                  value === defaultByokEndpoint(current.runtime) ? null : value,
              };
            })
          }
        />
      </div>
      <input
        className="byok-key"
        type="password"
        aria-label="API key"
        placeholder="API key (stored privately on this computer)"
        autoComplete="off"
        spellCheck={false}
        maxLength={4096}
        value={draft.apiKey}
        onChange={(event) => {
          const apiKey = event.target.value;
          change("address", (current) => ({ ...current, apiKey }));
        }}
      />
      <div className="byok-model-row">
        <Combobox
          kind="model"
          label="Model"
          placeholder="Model ID (e.g. gpt-5.4 or claude-sonnet-4-6)"
          value={draft.modelId}
          items={models.map((model) => ({
            value: model.id,
            label: [
              model.name && model.name !== model.id ? model.name : "",
              model.contextWindow
                ? `${contextLabel(model.contextWindow)} context`
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
          }))}
          note={modelNote}
          open={menu === "model"}
          onOpenChange={(open) => setMenu(open ? "model" : undefined)}
          onInput={(modelId) =>
            change("check", (current) => ({ ...current, modelId }))
          }
          onCommit={() =>
            onDraftChange((current) => ({
              ...current,
              modelId: current.modelId.trim(),
            }))
          }
        />
        <button
          type="button"
          className="byok-icon-button"
          aria-label={listingNow ? "Listing models" : "List models"}
          title="List models"
          data-busy={listingNow}
          disabled={!hasBase || listingNow}
          onClick={() => void listModels()}
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="byok-test"
          disabled={checking || !hasBase || !hasModel}
          onClick={() => void runCheck()}
        >
          {checking ? "Testing…" : "Test"}
        </button>
        <div className="byok-toast-region" role="status" aria-live="polite">
          {toast && check && check.state !== "checking" && (
            <TestToast
              check={check}
              leaving={toast.leaving}
              onDismiss={hideToast}
              onHold={(held) => {
                clearTimeout(toastTimer.current);
                // Hovering keeps a success on screen; leaving lets it fade.
                if (!held && check.state === "ok")
                  toastTimer.current = setTimeout(hideToast, 1500);
              }}
            />
          )}
        </div>
      </div>
      <p className="byok-status" data-tone={status.tone}>
        {status.text}
      </p>
    </div>
  );
}

function TestToast({
  check,
  leaving,
  onDismiss,
  onHold,
}: {
  check: Exclude<Check, { state: "checking" }>;
  leaving: boolean;
  onDismiss: () => void;
  onHold: (held: boolean) => void;
}) {
  const ok = check.state === "ok";
  return (
    <div
      className="byok-toast"
      data-tone={ok ? "ok" : "err"}
      data-leaving={leaving}
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
    >
      <span className="byok-toast-icon">{ok ? <OkIcon /> : <ErrorIcon />}</span>
      <div>
        <strong>{ok ? "Connected" : "Couldn't connect"}</strong>
        {ok ? (
          <p>
            {check.report.modelId} · {contextLabel(check.report.contextWindow)}{" "}
            context · {FORMATS[check.report.protocol].label}
            <br />
            <span className="url">{check.report.url}</span>
          </p>
        ) : (
          <p>{check.message}</p>
        )}
      </div>
      <button
        type="button"
        className="byok-toast-close"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

interface ComboItem {
  value: string;
  label?: string;
  tag?: string;
}

/** Free text plus a list of suggestions; an empty value shows as "-". */
function Combobox({
  kind,
  label,
  heading,
  placeholder = "-",
  value,
  isDefault = false,
  fit = false,
  items,
  note,
  open,
  onOpenChange,
  onInput,
  onCommit,
}: {
  kind: Menu;
  label: string;
  heading?: string;
  placeholder?: string;
  value: string;
  isDefault?: boolean;
  /** Size the box to its value, for the short path and endpoint boxes. */
  fit?: boolean;
  items: ComboItem[];
  note?: { tone?: "err"; text: ReactNode };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInput: (value: string) => void;
  onCommit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOption = useRef(false);
  const menuId = `byok-${kind}-menu`;
  useEffect(() => {
    if (!open || !focusOption.current) return;
    focusOption.current = false;
    const menu = menuRef.current;
    (
      menu?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      menu?.querySelector<HTMLElement>("[role=option]")
    )?.focus();
  }, [open]);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      onOpenChange(false);
      inputRef.current?.focus();
      return;
    }
    if (event.target === inputRef.current) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusOption.current = true;
        onOpenChange(true);
      } else if (event.key === "Enter") {
        // Enter while an input method is composing picks a candidate;
        // browsers report it either as isComposing or as the 229 key code,
        // and committing then would keep a half-composed value.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        onCommit();
        onOpenChange(false);
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>("[role=option]") ??
        []),
    ];
    const at = options.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[(at + step + options.length) % options.length]?.focus();
  }
  return (
    <div
      className={fit ? "byok-combo fit" : "byok-combo"}
      data-combo={kind}
      data-default={isDefault}
      data-open={open}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        role="combobox"
        aria-label={label}
        aria-autocomplete="none"
        aria-expanded={open}
        aria-controls={menuId}
        autoComplete="off"
        spellCheck={false}
        maxLength={256}
        {...(fit ? { size: Math.max((value || placeholder).length, 2) } : {})}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onInput(event.target.value);
          onOpenChange(false);
        }}
        onBlur={onCommit}
      />
      <button
        type="button"
        className="byok-caret"
        tabIndex={-1}
        aria-label={`Show ${label} suggestions`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onOpenChange(!open);
          inputRef.current?.focus();
        }}
      >
        <ChevronIcon />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="byok-menu"
          role="listbox"
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
        >
          {heading && <div className="byok-menu-head">{heading}</div>}
          {note && (
            <div className="byok-menu-note" data-tone={note.tone}>
              {note.text}
            </div>
          )}
          {items.map((item) => (
            <button
              type="button"
              role="option"
              key={item.value || "-"}
              aria-selected={item.value === value}
              onClick={() => {
                onInput(item.value);
                onOpenChange(false);
                inputRef.current?.focus();
              }}
            >
              <span className="byok-option-value">{item.value || "-"}</span>
              {(item.label || item.tag) && (
                <span className="byok-option-label">
                  {item.label}
                  {item.tag && <em>{item.tag}</em>}
                </span>
              )}
              <CheckIcon />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.2 6.4A5.3 5.3 0 0 0 3.4 4.6M2.8 9.6a5.3 5.3 0 0 0 9.8 1.8M3.2 2.2v2.6h2.6M12.8 13.8v-2.6h-2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M2.5 3.8 5 6.3l2.5-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg
      className="byok-option-check"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="m3.5 8.5 3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function OkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="m5.2 8.2 1.9 1.9 3.7-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ErrorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M8 4.6v4.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.2" r="0.9" fill="currentColor" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="m2 2 6 6M8 2 2 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
