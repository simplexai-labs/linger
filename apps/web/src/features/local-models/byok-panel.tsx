import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { ByokCombobox } from "./byok-combobox";
import {
  byokContextLabel,
  formatByokFullUrl,
  normalizeByokFullUrl,
  parseByokFullUrl,
} from "./byok-endpoint";
import { byokFailureCopy, byokProtocolLabels } from "./local-models-copy";
import { localModelsMessages as m } from "./local-models.messages";
import { invalidateOfflineComputer } from "./local-models-queries";
import type { ModelSourceSwitcher } from "./model-source-panel";
import {
  type ByokEndpointInput,
  type ByokInput,
  type ByokTestRequest,
  listByokModels,
  type ModelSourceStatus,
  testByokEndpoint,
} from "./model-source-queries";

const byokInputClassName =
  "h-10 w-full rounded-xl border border-transparent bg-muted/50 px-3.5 text-sm text-foreground transition-[background-color,border-color,box-shadow] duration-150 placeholder:text-muted-foreground/55 hover:bg-muted/75 focus:border-foreground/15 focus:bg-card focus:shadow-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

const byokFieldButtonClassName =
  "inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-transparent bg-muted/55 text-sm font-medium text-foreground transition-[color,background-color,border-color,transform] duration-150 hover:bg-muted/85 active:scale-(--chat-press-scale) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none motion-reduce:active:scale-100";

function sameEndpointOrigin(
  savedUrl: string | undefined,
  nextOrigin: string | undefined,
) {
  const trimmedSaved = savedUrl?.trim();
  if (!trimmedSaved || !nextOrigin) return false;
  try {
    return new URL(trimmedSaved).origin === nextOrigin;
  } catch {
    return false;
  }
}

function endpointHostLabel(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

const failureCopy = (error: unknown, t: Translate) =>
  error instanceof TeamHubError
    ? byokFailureCopy(error.code, error.message, t)
    : byokFailureCopy(undefined, "", t);

function abortController(ref: { current: AbortController | null }) {
  ref.current?.abort();
  ref.current = null;
}

interface ByokDraftState {
  apiKey: string;
  editing: boolean;
  modelId: string;
  replacingKey: boolean;
  urlValue: string;
}

type ByokDraftAction =
  | { type: "cancel"; initial: ByokDraftState }
  | { type: "keepSavedKey" }
  | { type: "normalizeUrl" }
  | { type: "replaceKey" }
  | { type: "setApiKey"; value: string }
  | { type: "setModelId"; value: string }
  | { type: "setUrl"; value: string }
  | { type: "startEditing" }
  | { type: "trimModelId" };

function byokDraftReducer(
  state: ByokDraftState,
  action: ByokDraftAction,
): ByokDraftState {
  switch (action.type) {
    case "startEditing":
      return { ...state, editing: true };
    case "cancel":
      return action.initial;
    case "setUrl":
      return { ...state, urlValue: action.value };
    case "normalizeUrl":
      return { ...state, urlValue: normalizeByokFullUrl(state.urlValue) };
    case "setApiKey":
      return { ...state, apiKey: action.value };
    case "replaceKey":
      return { ...state, replacingKey: true };
    case "keepSavedKey":
      return { ...state, apiKey: "", replacingKey: false };
    case "setModelId":
      return { ...state, modelId: action.value };
    case "trimModelId":
      return { ...state, modelId: state.modelId.trim() };
  }
}

/**
 * The person's own endpoint, shown as a clean summary card once configured
 * and editable via one full URL, an API key, and a model ID. The API key goes
 * to the Computer, which keeps it private; Linger never shows it again.
 */
export function ByokPanel({
  computerId,
  disabled,
  status,
  switcher,
  tenantId,
}: {
  computerId: string;
  disabled: boolean;
  status: ModelSourceStatus;
  switcher: ModelSourceSwitcher;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const saved = status.byok;
  const initialUrl = formatByokFullUrl(saved);
  const initialModelId = saved.model_id ?? "";
  const hasSavedConfig = Boolean(
    saved.configured && initialUrl && initialModelId,
  );
  const initialDraft: ByokDraftState = {
    apiKey: "",
    editing: !hasSavedConfig,
    modelId: initialModelId,
    replacingKey: !saved.key_saved,
    urlValue: initialUrl,
  };
  const [draft, dispatchDraft] = useReducer(byokDraftReducer, initialDraft);
  const { apiKey, editing, modelId, replacingKey, urlValue } = draft;
  const [menuOpen, setMenuOpen] = useState(false);
  const [toastShown, setToastShown] = useState(false);
  const ids = useId();
  const keyInputRef = useRef<HTMLInputElement>(null);

  const parsedUrl = parseByokFullUrl(urlValue, {
    preserveEmptyEndpointForUrl:
      saved.configured && !saved.endpoint ? initialUrl : undefined,
    preserveRuntime: status.mode === "byok" ? status.runtime : undefined,
    preserveRuntimeForUrl: status.mode === "byok" ? initialUrl : undefined,
  });
  const urlInvalid = urlValue.trim() !== "" && !parsedUrl;
  // Never reuse a saved key when the owner points BYOK at a different host.
  const canReuseSavedKey =
    saved.key_saved &&
    (!saved.base_url || sameEndpointOrigin(saved.base_url, parsedUrl?.origin));
  const showMaskedSavedKey = canReuseSavedKey && !replacingKey && !apiKey;

  const address: ByokEndpointInput | null = parsedUrl
    ? {
        base_url: parsedUrl.baseUrl,
        endpoint: parsedUrl.endpoint,
        path: parsedUrl.path,
        protocol: parsedUrl.protocol,
        ...(apiKey
          ? { api_key: apiKey }
          : canReuseSavedKey
            ? { reuse_saved_key: true }
            : {}),
      }
    : null;
  const trimmedModelId = modelId.trim();
  const input: ByokInput | null = address
    ? { ...address, model_id: trimmedModelId }
    : null;
  // The Computer decides whether the endpoint needs a key: one on this
  // computer or the local network may have none.
  const complete = Boolean(input && trimmedModelId !== "");
  const active = status.mode === "byok";

  const modelsAbortRef = useRef<AbortController | null>(null);
  const testAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortController(modelsAbortRef);
      abortController(testAbortRef);
    },
    [],
  );

  function syncOfflineIfNeeded(error: unknown) {
    if (
      error instanceof TeamHubError &&
      error.code === "LOCAL_COMPUTER_OFFLINE"
    ) {
      void invalidateOfflineComputer(queryClient, tenantId, computerId);
    }
  }

  const models = useMutation({
    mutationFn: async (body: ByokEndpointInput) => {
      abortController(modelsAbortRef);
      const controller = new AbortController();
      modelsAbortRef.current = controller;
      try {
        return await listByokModels(
          client,
          tenantId,
          computerId,
          body,
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) syncOfflineIfNeeded(error);
        throw error;
      } finally {
        if (modelsAbortRef.current === controller) {
          modelsAbortRef.current = null;
        }
      }
    },
  });
  const test = useMutation({
    mutationFn: async (body: ByokTestRequest) => {
      abortController(testAbortRef);
      const controller = new AbortController();
      testAbortRef.current = controller;
      try {
        return await testByokEndpoint(
          client,
          tenantId,
          computerId,
          body,
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) syncOfflineIfNeeded(error);
        throw error;
      } finally {
        if (testAbortRef.current === controller) {
          testAbortRef.current = null;
        }
      }
    },
  });
  const listed = models.data?.models ?? [];
  const modelOptions = listed.map((model) => ({
    detail:
      [
        model.name,
        model.context_window
          ? byokContextLabel(model.context_window, t)
          : undefined,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
    value: model.id,
  }));

  function resetTest() {
    abortController(testAbortRef);
    test.reset();
    setToastShown(false);
  }
  function resetAll() {
    abortController(modelsAbortRef);
    models.reset();
    setMenuOpen(false);
    resetTest();
  }

  function submitByok() {
    if (!input || !parsedUrl) return;
    abortController(modelsAbortRef);
    if (models.isPending) models.reset();
    abortController(testAbortRef);
    if (test.isPending) test.reset();
    switcher.request({ byok: input, mode: "byok", runtime: parsedUrl.runtime });
  }

  function save(event: FormEvent) {
    event.preventDefault();
    submitByok();
  }

  function runTest() {
    if (!input) return;
    setToastShown(false);
    test.mutate({ byok: input }, { onSettled: () => setToastShown(true) });
  }

  function cancelEditing() {
    dispatchDraft({ initial: initialDraft, type: "cancel" });
    resetAll();
  }

  const testToastNode =
    toastShown && test.isSuccess ? (
      <TestToast
        onDismiss={() => setToastShown(false)}
        title={t(m.byokConnected)}
        tone="success"
      >
        {test.data.model_id} · {byokContextLabel(test.data.context_window, t)} ·{" "}
        {byokProtocolLabels[test.data.protocol]}
        <br />
        <span className="font-mono text-xs [overflow-wrap:anywhere]">
          {test.data.url}
        </span>
      </TestToast>
    ) : toastShown && test.isError ? (
      <TestToast
        onDismiss={() => setToastShown(false)}
        title={t(m.byokCouldNotConnect)}
        tone="danger"
      >
        {failureCopy(test.error, t)}
      </TestToast>
    ) : null;

  if (hasSavedConfig && !editing) {
    const host = endpointHostLabel(initialUrl);
    const protocolLabel = parsedUrl
      ? byokProtocolLabels[parsedUrl.protocol]
      : undefined;

    return (
      <section
        aria-label={t(m.modeByok)}
        className="mt-5 rounded-2xl bg-card shadow-sm"
      >
        <div className="px-6 py-5">
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate font-mono text-[15px] font-semibold tracking-[-0.015em] text-foreground">
                  {initialModelId}
                </h2>
                {active ? (
                  <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-[var(--app-status-success-surface)] px-2 text-[11px] font-medium text-app-success">
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full bg-app-success"
                    />
                    {t(m.selectedModel)}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {[host, protocolLabel].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                disabled={disabled || !complete}
                loading={test.isPending}
                onClick={runTest}
                size="compact"
                tone="subtle"
              >
                {t(m.byokTest)}
              </Button>
              <Button
                disabled={disabled}
                onClick={() => {
                  resetTest();
                  dispatchDraft({ type: "startEditing" });
                }}
                size="compact"
                tone="subtle"
              >
                {t(m.byokEdit)}
              </Button>
              {!active ? (
                <Button
                  disabled={disabled || !complete}
                  loading={switcher.pending?.mode === "byok"}
                  onClick={submitByok}
                  size="compact"
                  tone="primary"
                >
                  {t(m.switchModel)}
                </Button>
              ) : null}
            </div>
            {testToastNode}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 rounded-b-2xl border-t border-border/40 bg-muted/20 px-6 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <span className="block text-[11px] font-medium text-muted-foreground">
              {t(m.byokUrl)}
            </span>
            <span
              className="mt-0.5 block truncate font-mono text-xs text-foreground/85"
              title={initialUrl}
            >
              {initialUrl}
            </span>
          </div>
          <div className="shrink-0">
            <span className="block text-[11px] font-medium text-muted-foreground">
              {t(m.apiKey)}
            </span>
            {saved.key_saved ? (
              <span className="mt-0.5 flex items-center gap-2">
                <span
                  aria-hidden
                  className="font-mono text-xs tracking-widest text-foreground/65"
                >
                  ••••••••••••
                </span>
                <span className="inline-flex h-5 items-center rounded-full bg-[var(--app-status-success-surface)] px-2 text-[11px] font-medium text-app-success">
                  {t(m.byokKeySavedBadge)}
                </span>
              </span>
            ) : (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t(m.byokKeyNotSet)}
              </span>
            )}
          </div>
        </div>
      </section>
    );
  }

  const urlHintId = `${ids}-url-hint`;
  const modelHintId = `${ids}-model-hint`;

  return (
    <form
      aria-label={t(m.modeByok)}
      className="mt-5 rounded-2xl bg-card shadow-sm"
      onSubmit={save}
    >
      <div className="space-y-5 p-6">
        <div>
          <label
            className="mb-2 block text-[13px] font-medium tracking-[-0.01em] text-foreground"
            htmlFor={`${ids}-url`}
          >
            {t(m.byokUrl)}
          </label>
          <input
            aria-describedby={urlInvalid ? urlHintId : undefined}
            aria-invalid={urlInvalid || undefined}
            autoComplete="off"
            className={cn(
              byokInputClassName,
              "font-mono text-[13px]",
              urlInvalid && "border-destructive/40 focus:border-destructive/60",
            )}
            disabled={disabled}
            id={`${ids}-url`}
            inputMode="url"
            onBlur={() => dispatchDraft({ type: "normalizeUrl" })}
            onChange={(event) => {
              dispatchDraft({ type: "setUrl", value: event.target.value });
              resetAll();
            }}
            placeholder="https://api.openai.com/v1/chat/completions"
            spellCheck={false}
            value={urlValue}
          />
          {urlInvalid ? (
            <p className="mt-1.5 text-xs text-destructive" id={urlHintId}>
              {t(m.byokUrlInvalid)}
            </p>
          ) : null}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            {showMaskedSavedKey ? (
              <span className="block text-[13px] font-medium tracking-[-0.01em] text-foreground">
                {t(m.apiKey)}
              </span>
            ) : (
              <label
                className="block text-[13px] font-medium tracking-[-0.01em] text-foreground"
                htmlFor={`${ids}-key`}
              >
                {t(m.apiKey)}
              </label>
            )}
            {canReuseSavedKey && replacingKey ? (
              <button
                className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={disabled}
                onClick={() => {
                  dispatchDraft({ type: "keepSavedKey" });
                  resetAll();
                }}
                type="button"
              >
                {t(m.byokKeepSavedKey)}
              </button>
            ) : null}
          </div>
          {showMaskedSavedKey ? (
            <div className="flex h-10 items-center justify-between gap-3 rounded-xl bg-muted/50 px-3.5">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="font-mono text-xs tracking-widest text-foreground/65"
                >
                  ••••••••••••
                </span>
                <span className="inline-flex h-5 items-center rounded-full bg-[var(--app-status-success-surface)] px-2 text-[11px] font-medium text-app-success">
                  {t(m.byokKeySavedBadge)}
                </span>
              </span>
              <button
                className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={disabled}
                onClick={() => {
                  dispatchDraft({ type: "replaceKey" });
                  requestAnimationFrame(() => keyInputRef.current?.focus());
                }}
                type="button"
              >
                {t(m.byokChangeKey)}
              </button>
            </div>
          ) : (
            <input
              autoComplete="new-password"
              className={byokInputClassName}
              disabled={disabled}
              id={`${ids}-key`}
              onChange={(event) => {
                dispatchDraft({ type: "setApiKey", value: event.target.value });
                resetAll();
              }}
              placeholder={canReuseSavedKey ? t(m.keySavedHint) : undefined}
              ref={keyInputRef}
              type="password"
              value={apiKey}
            />
          )}
        </div>

        <div>
          <label
            className="mb-2 block text-[13px] font-medium tracking-[-0.01em] text-foreground"
            htmlFor={`${ids}-model`}
          >
            {t(m.model)}
          </label>
          <div className="relative flex items-center gap-2">
            <ByokCombobox
              aria-describedby={models.isError ? modelHintId : undefined}
              className="min-w-0 flex-1"
              disabled={disabled}
              id={`${ids}-model`}
              label={t(m.model)}
              onCommit={() => dispatchDraft({ type: "trimModelId" })}
              onOpenChange={setMenuOpen}
              onValueChange={(value) => {
                dispatchDraft({ type: "setModelId", value });
                resetTest();
              }}
              open={menuOpen}
              options={modelOptions}
              placeholder="provider/model-name"
              value={modelId}
            />
            <button
              aria-busy={models.isPending || undefined}
              aria-label={t(m.listModels)}
              className={cn(
                byokFieldButtonClassName,
                "w-10 text-muted-foreground hover:text-foreground",
              )}
              disabled={disabled || !address || models.isPending}
              onClick={() => {
                if (!address) return;
                models.mutate(address, { onSuccess: () => setMenuOpen(true) });
              }}
              title={t(m.listModels)}
              type="button"
            >
              {models.isPending ? (
                <Spinner size={16} />
              ) : (
                <Icon icon={RefreshIcon} size={16} />
              )}
            </button>
            <button
              aria-busy={test.isPending || undefined}
              className={cn(byokFieldButtonClassName, "gap-2 px-4")}
              disabled={disabled || !complete || test.isPending}
              onClick={runTest}
              type="button"
            >
              {test.isPending ? <Spinner size={16} /> : null}
              {t(m.byokTest)}
            </button>
            {testToastNode}
          </div>
          {models.isError ? (
            <p
              className="mt-1.5 text-xs text-destructive [overflow-wrap:anywhere]"
              id={modelHintId}
            >
              {failureCopy(models.error, t)}
            </p>
          ) : null}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t border-border/40 bg-muted/20 px-6 py-3.5">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {parsedUrl ? (
            <>
              {byokProtocolLabels[parsedUrl.protocol]}
              {!parsedUrl.explicitEndpoint ? (
                <span className="ml-1.5 font-mono text-[11px] text-muted-foreground/75">
                  · {parsedUrl.endpoint}
                </span>
              ) : null}
            </>
          ) : null}
        </span>
        <div className="flex items-center gap-2">
          {hasSavedConfig ? (
            <Button
              disabled={disabled}
              onClick={cancelEditing}
              size="default"
              tone="ghost"
            >
              {t(commonMessages.cancel)}
            </Button>
          ) : null}
          <Button
            className="rounded-xl px-4"
            disabled={disabled || !complete}
            loading={switcher.pending?.mode === "byok"}
            size="default"
            tone="primary"
            type="submit"
          >
            {t(active ? commonMessages.save : m.saveAndSwitch)}
          </Button>
        </div>
      </footer>
    </form>
  );
}

/**
 * A test result floating above the Test button so it never obscures the form
 * footer action below. A success fades on its own unless the pointer rests on
 * it; a failure stays until dismissed, a click elsewhere, or a changed input.
 */
function TestToast({
  children,
  onDismiss,
  title,
  tone,
}: {
  children: ReactNode;
  onDismiss: () => void;
  title: string;
  tone: "danger" | "success";
}) {
  const t = useT();
  const toastRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [fadeAfter, setFadeAfter] = useState(3500);
  const dismiss = useEffectEvent(onDismiss);

  useEffect(() => {
    if (leaving) {
      const timer = setTimeout(dismiss, 200);
      return () => clearTimeout(timer);
    }
    if (tone !== "success" || hovered) return undefined;
    const timer = setTimeout(() => setLeaving(true), fadeAfter);
    return () => clearTimeout(timer);
  }, [fadeAfter, hovered, leaving, tone]);

  useEffect(() => {
    const leaveOnOutsideClick = (event: PointerEvent) => {
      if (!toastRef.current?.contains(event.target as Node)) setLeaving(true);
    };
    document.addEventListener("pointerdown", leaveOnOutsideClick);
    return () =>
      document.removeEventListener("pointerdown", leaveOnOutsideClick);
  }, []);

  return (
    <div
      className={cn(
        "absolute right-0 bottom-full z-40 mb-2 grid w-[min(22rem,100%)] grid-cols-[16px_minmax(0,1fr)_20px] items-start gap-2 rounded-xl bg-primary py-2.5 pr-2 pl-3 text-left text-xs text-primary-foreground/80 shadow-lg before:absolute before:right-6 before:-bottom-1 before:size-2.5 before:rotate-45 before:bg-primary before:content-[''] motion-reduce:animate-none",
        leaving
          ? "animate-[town-dropdown-out_200ms_ease_both]"
          : "animate-[town-dropdown-in_var(--app-floating-duration)_ease_both]",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setFadeAfter(1500);
      }}
      ref={toastRef}
      role={tone === "success" ? "status" : "alert"}
    >
      <Icon
        className={cn(
          "mt-px",
          tone === "success" ? "text-app-success" : "text-destructive",
        )}
        icon={tone === "success" ? CheckmarkCircle02Icon : AlertCircleIcon}
        size={16}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary-foreground">{title}</p>
        <p className="mt-0.5 [overflow-wrap:anywhere]">{children}</p>
      </div>
      <button
        aria-label={t(m.byokDismiss)}
        className="grid size-5 place-items-center rounded-sm text-primary-foreground/60 transition-colors hover:bg-primary-foreground/10 hover:text-primary-foreground"
        data-voice-close
        onClick={() => setLeaving(true)}
        type="button"
      >
        <Icon icon={Cancel01Icon} size={14} />
      </button>
    </div>
  );
}
