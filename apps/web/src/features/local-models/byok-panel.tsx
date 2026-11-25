import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import {
  byokProtocolFor,
  DEFAULT_BYOK_PATH,
  defaultByokEndpoint,
  normalizeByokBaseUrl,
  normalizeByokPath,
  validByokPath,
} from "@linger/service-kit/byok-endpoint";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { fieldControlClassName } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { SecretInput } from "@/components/ui/secret-field";
import { Select, SelectItem } from "@/components/ui/select";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { ByokCombobox } from "./byok-combobox";
import {
  byokContextLabel,
  byokEndpointSuggestions,
  byokPathSuggestions,
} from "./byok-endpoint";
import {
  byokFailureCopy,
  byokProtocolLabels,
  modelSourceRuntimeLabels,
} from "./local-models-copy";
import { localModelsMessages as m } from "./local-models.messages";
import { invalidateOfflineComputer } from "./local-models-queries";
import type { ModelSourceSwitcher } from "./model-source-panel";
import {
  type ByokEndpointInput,
  type ByokInput,
  type ByokTestRequest,
  listByokModels,
  type ModelSourceRuntime,
  type ModelSourceStatus,
  testByokEndpoint,
} from "./model-source-queries";

const byokRuntimes: readonly ModelSourceRuntime[] = ["claude", "codex", "pi"];

type ByokMenu = "endpoint" | "model" | "path";

function sameEndpointOrigin(savedUrl: string | undefined, nextUrl: string) {
  const trimmedSaved = savedUrl?.trim();
  const trimmedNext = nextUrl.trim();
  if (!trimmedSaved || !trimmedNext) return false;
  if (trimmedSaved === trimmedNext) return true;
  try {
    return new URL(trimmedSaved).origin === new URL(trimmedNext).origin;
  } catch {
    return false;
  }
}

/** A path or endpoint box sized to its value, at full width when stacked. */
function fittedWidth(value: string): CSSProperties {
  return {
    "--byok-fit": `${Math.max(value.length, 1) + 1}ch`,
  } as CSSProperties;
}

const failureCopy = (error: unknown, t: Translate) =>
  error instanceof TeamHubError
    ? byokFailureCopy(error.code, error.message, t)
    : byokFailureCopy(undefined, "", t);

function abortController(ref: { current: AbortController | null }) {
  ref.current?.abort();
  ref.current = null;
}

export interface ByokDraft {
  apiKey: string;
  baseUrl: string;
  endpoint: string | null;
  modelId: string;
  path: string;
  runtime: ModelSourceRuntime;
}

export function initialByokDraft(status: ModelSourceStatus): ByokDraft {
  const saved = status.byok;
  const savedRuntime = status.mode === "byok" ? status.runtime : "claude";
  const savedEndpoint = saved.configured ? (saved.endpoint ?? "") : null;
  return {
    apiKey: "",
    baseUrl: saved.base_url ?? "",
    endpoint:
      savedEndpoint === defaultByokEndpoint(savedRuntime)
        ? null
        : savedEndpoint,
    modelId: saved.model_id ?? "",
    path: saved.configured ? (saved.path ?? "") : DEFAULT_BYOK_PATH,
    runtime: savedRuntime,
  };
}

export function isByokDraftDirty(
  draft: ByokDraft,
  status: ModelSourceStatus,
): boolean {
  const baseline = initialByokDraft(status);
  return (
    draft.runtime !== baseline.runtime ||
    draft.baseUrl !== baseline.baseUrl ||
    draft.path !== baseline.path ||
    draft.endpoint !== baseline.endpoint ||
    draft.apiKey !== baseline.apiKey ||
    draft.modelId !== baseline.modelId
  );
}

/**
 * The person's own endpoint, addressed as base URL + path + endpoint. The API
 * key goes to the Computer, which keeps it private; Linger never shows it
 * again.
 */
export function ByokPanel({
  computerId,
  disabled,
  draft,
  onDraftChange,
  status,
  switcher,
  tenantId,
}: {
  computerId: string;
  disabled: boolean;
  /** Preserved form state across Local model ↔ BYOK tab switches on one Computer. */
  draft?: ByokDraft;
  onDraftChange?: (draft: ByokDraft) => void;
  status: ModelSourceStatus;
  switcher: ModelSourceSwitcher;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const saved = status.byok;
  const [localDraft, setLocalDraft] = useState<ByokDraft>(
    () => draft ?? initialByokDraft(status),
  );
  const currentDraft = draft ?? localDraft;
  const { apiKey, baseUrl, endpoint, modelId, path, runtime } = currentDraft;

  function updateDraft(patch: Partial<ByokDraft>) {
    const next = { ...currentDraft, ...patch };
    setLocalDraft(next);
    onDraftChange?.(next);
  }
  const [menu, setMenu] = useState<ByokMenu | null>(null);
  const [toastShown, setToastShown] = useState(false);
  const ids = useId();

  const base = normalizeByokBaseUrl(baseUrl);
  const pathValue = normalizeByokPath(path);
  const runtimeEndpoint = defaultByokEndpoint(runtime);
  const endpointValue = normalizeByokPath(endpoint ?? runtimeEndpoint);
  const requestUrl = `${base}${pathValue}${endpointValue}`;
  const format = byokProtocolFor(requestUrl, runtime);
  const addressValid = validByokPath(pathValue) && validByokPath(endpointValue);
  // Never reuse a saved key when the owner points BYOK at a different host.
  const canReuseSavedKey =
    saved.key_saved &&
    (!saved.base_url || sameEndpointOrigin(saved.base_url, base));
  const address: ByokEndpointInput = {
    base_url: base,
    endpoint: endpointValue,
    path: pathValue,
    protocol: format.protocol,
    ...(apiKey
      ? { api_key: apiKey }
      : canReuseSavedKey
        ? { reuse_saved_key: true }
        : {}),
  };
  const input: ByokInput = { ...address, model_id: modelId.trim() };
  // The Computer decides whether the endpoint needs a key: one on this
  // computer or the local network may have none.
  const complete = base !== "" && input.model_id !== "" && addressValid;
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

  // Changing the address or key makes listed models and a test result stale;
  // changing only the endpoint, model or Runtime keeps the listed models.
  function resetTest() {
    abortController(testAbortRef);
    test.reset();
    setToastShown(false);
  }
  function resetAll() {
    abortController(modelsAbortRef);
    models.reset();
    resetTest();
  }

  function save(event: FormEvent) {
    event.preventDefault();
    abortController(modelsAbortRef);
    if (models.isPending) models.reset();
    abortController(testAbortRef);
    if (test.isPending) test.reset();
    switcher.request({ byok: input, mode: "byok", runtime });
  }

  const addressHintId = `${ids}-address-hint`;
  const modelHintId = `${ids}-model-hint`;

  return (
    <form
      aria-label={t(m.modeByok)}
      className="mt-5 rounded-xl border border-border bg-card"
      onSubmit={save}
    >
      <div className="grid grid-cols-1 gap-5 px-5 py-5">
        <div>
          <p className="mb-1.5 text-sm font-medium text-foreground">
            {t(m.aiRuntime)}
          </p>
          <Select
            aria-label={t(m.aiRuntime)}
            className="w-full"
            disabled={disabled}
            onValueChange={(value) => {
              updateDraft({ runtime: value as ModelSourceRuntime });
              resetTest();
            }}
            value={runtime}
          >
            {byokRuntimes.map((item) => (
              <SelectItem key={item} value={item}>
                {modelSourceRuntimeLabels[item]}
              </SelectItem>
            ))}
          </Select>
        </div>
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-sm font-medium text-foreground">
            {t(m.byokApiAddress)}
          </legend>
          <div className="grid grid-cols-[minmax(5.5rem,2fr)_minmax(0,3fr)] gap-x-2 gap-y-2.5 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <AddressLabel htmlFor={`${ids}-base`}>
                {t(m.baseUrl)}
              </AddressLabel>
              <input
                aria-describedby={addressHintId}
                autoComplete="off"
                className={fieldControlClassName}
                disabled={disabled}
                id={`${ids}-base`}
                onBlur={() =>
                  updateDraft({ baseUrl: normalizeByokBaseUrl(baseUrl) })
                }
                onChange={(event) => {
                  updateDraft({ baseUrl: event.target.value });
                  resetAll();
                }}
                placeholder="https://api.example.com"
                inputMode="url"
                spellCheck={false}
                value={baseUrl}
              />
            </div>
            <div className="min-w-0">
              <AddressLabel htmlFor={`${ids}-path`}>
                {t(m.byokPath)}
              </AddressLabel>
              <ByokCombobox
                aria-describedby={addressHintId}
                aria-invalid={!validByokPath(pathValue)}
                className="sm:w-max"
                disabled={disabled}
                filled={path === DEFAULT_BYOK_PATH}
                heading={t(m.byokPathHeading)}
                menuClassName="-left-px sm:left-auto sm:-right-px"
                id={`${ids}-path`}
                inputClassName="font-mono text-xs sm:w-(--byok-fit) sm:flex-none"
                inputStyle={fittedWidth(path)}
                label={t(m.byokPath)}
                onCommit={() => updateDraft({ path: normalizeByokPath(path) })}
                onOpenChange={(open) => setMenu(open ? "path" : null)}
                onValueChange={(value) => {
                  updateDraft({ path: value });
                  resetAll();
                }}
                open={menu === "path"}
                options={byokPathSuggestions(t).map((option) => ({
                  detail:
                    option.value === DEFAULT_BYOK_PATH
                      ? t(m.byokDefaultOption, { label: option.label })
                      : option.label,
                  value: option.value,
                }))}
                placeholder="-"
                value={path}
              />
            </div>
            <div className="min-w-0">
              <AddressLabel htmlFor={`${ids}-endpoint`}>
                {t(m.byokEndpoint)}
              </AddressLabel>
              <ByokCombobox
                aria-describedby={addressHintId}
                aria-invalid={!validByokPath(endpointValue)}
                className="sm:w-max"
                disabled={disabled}
                filled={endpoint === null}
                heading={t(m.byokEndpointHeading)}
                menuClassName="-right-px"
                id={`${ids}-endpoint`}
                inputClassName="font-mono text-xs sm:w-(--byok-fit) sm:flex-none"
                inputStyle={fittedWidth(endpoint ?? runtimeEndpoint)}
                label={t(m.byokEndpoint)}
                onCommit={() => {
                  if (endpoint === null) return;
                  const value = normalizeByokPath(endpoint);
                  updateDraft({
                    endpoint: value === runtimeEndpoint ? null : value,
                  });
                }}
                onOpenChange={(open) => setMenu(open ? "endpoint" : null)}
                onValueChange={(value) => {
                  updateDraft({
                    endpoint: value === runtimeEndpoint ? null : value,
                  });
                  resetTest();
                }}
                open={menu === "endpoint"}
                options={byokEndpointSuggestions.map((option) => ({
                  detail: option.protocol
                    ? option.value === runtimeEndpoint
                      ? t(m.byokEndpointRuntimeDefault, {
                          protocol: byokProtocolLabels[option.protocol],
                          runtime: modelSourceRuntimeLabels[runtime],
                        })
                      : byokProtocolLabels[option.protocol]
                    : t(m.byokEndpointNone),
                  value: option.value,
                }))}
                placeholder="-"
                value={endpoint ?? runtimeEndpoint}
              />
            </div>
          </div>
          <div
            className="mt-2 grid gap-1 text-xs text-muted-foreground"
            id={addressHintId}
          >
            {!addressValid ? (
              <p className="text-destructive">{t(m.byokAddressInvalid)}</p>
            ) : null}
          </div>
        </fieldset>
        <div>
          <label
            className="mb-1.5 block text-sm font-medium text-foreground"
            htmlFor={`${ids}-key`}
          >
            {t(m.apiKey)}
          </label>
          <SecretInput
            autoComplete="new-password"
            disabled={disabled}
            id={`${ids}-key`}
            onChange={(event) => {
              updateDraft({ apiKey: event.target.value });
              resetAll();
            }}
            placeholder={canReuseSavedKey ? t(m.keySavedHint) : undefined}
            value={apiKey}
          />
        </div>
        <div>
          <label
            className="mb-1.5 block text-sm font-medium text-foreground"
            htmlFor={`${ids}-model`}
          >
            {t(m.model)}
          </label>
          <div className="relative flex gap-2">
            <ByokCombobox
              aria-describedby={models.isError ? modelHintId : undefined}
              className="min-w-0 flex-1"
              disabled={disabled}
              id={`${ids}-model`}
              label={t(m.model)}
              onCommit={() => updateDraft({ modelId: modelId.trim() })}
              onOpenChange={(open) => setMenu(open ? "model" : null)}
              onValueChange={(value) => {
                updateDraft({ modelId: value });
                resetTest();
              }}
              open={menu === "model"}
              options={modelOptions}
              placeholder="provider/model-name"
              value={modelId}
            />
            <Button
              aria-label={t(m.listModels)}
              disabled={disabled || base === "" || !addressValid}
              loading={models.isPending}
              onClick={() =>
                models.mutate(address, { onSuccess: () => setMenu("model") })
              }
              size="large"
              title={t(m.listModels)}
            >
              {models.isPending ? null : <Icon icon={RefreshIcon} size={16} />}
            </Button>
            <Button
              disabled={disabled || !complete}
              loading={test.isPending}
              onClick={() => {
                setToastShown(false);
                test.mutate(
                  { byok: input },
                  { onSettled: () => setToastShown(true) },
                );
              }}
              size="large"
            >
              {t(m.byokTest)}
            </Button>
            {toastShown && test.isSuccess ? (
              <TestToast
                onDismiss={() => setToastShown(false)}
                title={t(m.byokConnected)}
                tone="success"
              >
                {test.data.model_id} ·{" "}
                {byokContextLabel(test.data.context_window, t)} ·{" "}
                {byokProtocolLabels[test.data.protocol]}
                <br />
                <Url>{test.data.url}</Url>
              </TestToast>
            ) : null}
            {toastShown && test.isError ? (
              <TestToast
                onDismiss={() => setToastShown(false)}
                title={t(m.byokCouldNotConnect)}
                tone="danger"
              >
                {failureCopy(test.error, t)}
              </TestToast>
            ) : null}
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
      <footer className="flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-border bg-muted/35 px-5 py-3">
        <Button
          disabled={disabled || !complete}
          loading={switcher.pending?.mode === "byok"}
          size="large"
          tone="primary"
          type="submit"
        >
          {t(active ? commonMessages.save : m.saveAndSwitch)}
        </Button>
      </footer>
    </form>
  );
}

function AddressLabel({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <label
      className="mb-1 block text-xs font-medium text-muted-foreground"
      htmlFor={htmlFor}
    >
      {children}
    </label>
  );
}

function Url({ children, chip = false }: { children: string; chip?: boolean }) {
  const baseClassName = "font-mono text-xs [overflow-wrap:anywhere]";
  if (chip) {
    return (
      <code
        className={cn(
          baseClassName,
          "rounded-sm bg-muted px-1.5 py-0.5 text-foreground",
        )}
      >
        {children}
      </code>
    );
  }
  return <span className={baseClassName}>{children}</span>;
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
        "absolute right-0 bottom-full z-40 mb-2 grid w-[min(22rem,100%)] grid-cols-[16px_minmax(0,1fr)_20px] items-start gap-2 rounded-lg bg-primary py-2.5 pr-2 pl-3 text-left text-xs text-primary-foreground/80 shadow-lg before:absolute before:right-6 before:-bottom-1 before:size-2.5 before:rotate-45 before:bg-primary before:content-[''] motion-reduce:animate-none",
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
        data-voice-close
        aria-label={t(m.byokDismiss)}
        className="grid size-5 place-items-center rounded-sm text-primary-foreground/60 transition-colors hover:bg-primary-foreground/10 hover:text-primary-foreground"
        onClick={() => setLeaving(true)}
        type="button"
      >
        <Icon icon={Cancel01Icon} size={14} />
      </button>
    </div>
  );
}
