import {
  Alert02Icon,
  InformationCircleIcon,
  Layers01Icon,
} from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { RichMessage, useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import {
  ActiveDownloadCard,
  GatedTokenCard,
  IncompatibleRepoCard,
  InstalledCustomModelCard,
  OmniboxInput,
  PreflightPanel,
  SearchResultsList,
} from "./custom-model-blocks";
import {
  activeCustomDownload,
  customModelBadge,
  deriveCustomHostHeadroom,
  installedCustomModels,
  isCustomUnsupportedError,
  parseOmniboxInput,
  selectSweetSpotQuant,
} from "./custom-model-rules";
import { customModelsMessages as cm } from "./custom-models.messages";
import {
  type CustomModelDownloadInput,
  type CustomModelHub,
  type CustomModelProbeRequest,
  type CustomModelProbeResponse,
  type CustomModelQuantVariant,
  type CustomModelSearchFormat,
  type CustomModelSearchHub,
  type CustomModelSearchResultItem,
  customModelSearchQueryOptions,
  downloadLocalComputerCustomModel,
  probeLocalComputerCustomModel,
} from "./custom-models-queries";
import {
  MakeRoomDialog,
  RemoveModelDialog,
  UnloadModelDialog,
} from "./local-model-dialogs";
import { actionErrorCopy } from "./local-models-copy";
import {
  actOnLocalComputerModel,
  invalidateOfflineComputer,
  localModelsQueryKey,
  type LocalModelAction,
  type LocalModelActionInput,
  type LocalModelsView,
  type LocalModelView,
} from "./local-models-queries";
import {
  formatGigabytes,
  loadCheck,
  modelStatus,
  poolFreeBytes,
  poolOf,
  type ModelEntry,
} from "./local-models-rules";
import type { ModelSourceStatus } from "./model-source-queries";

interface ActiveProbe {
  matchedFileName?: string;
  response: CustomModelProbeResponse;
  selectedQuantId: string;
  target: string;
  tokenError?: string;
}

type CustomDialog =
  | { kind: "makeRoom"; modelId: string }
  | { kind: "remove"; modelId: string }
  | { kind: "unload"; modelId: string };

export interface CustomModelHubTabProps {
  offline: boolean;
  onRefresh: () => void;
  onUseForAgents: (modelId: string) => void;
  rechecking: boolean;
  status: ModelSourceStatus | undefined;
  switching: boolean;
  switchingModelId: string | undefined;
  tenantId: string;
  view: LocalModelsView;
}

export function CustomModelHubTab({
  offline,
  onRefresh,
  onUseForAgents,
  rechecking,
  status,
  switching,
  switchingModelId,
  tenantId,
  view,
}: CustomModelHubTabProps) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const computerId = view.computer.computer_id;
  const readOnly = !view.viewer_is_owner;
  const canManage = !offline && !readOnly;

  const [hubFilter, setHubFilter] = useState<CustomModelSearchHub>("all");
  const [formatFilter, setFormatFilter] =
    useState<CustomModelSearchFormat>("compatible");
  const [omniboxHub, setOmniboxHub] = useState<CustomModelHub>("huggingface");
  const [omniboxInput, setOmniboxInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeProbe, setActiveProbe] = useState<ActiveProbe | null>(null);
  // Transient read-only hub token kept strictly in React state; never persisted.
  const [transientToken, setTransientToken] = useState<{
    repoKey: string;
    token: string;
  } | null>(null);
  const [cancelNotice, setCancelNotice] = useState<{
    cleanedBytes?: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [customUnsupported, setCustomUnsupported] = useState(false);
  const [dialog, setDialog] = useState<CustomDialog | null>(null);
  const [pendingByModel, setPendingByModel] = useState<
    Record<string, LocalModelAction>
  >({});

  // Clear transient token on unmount so it never outlives this tab.
  useEffect(() => {
    return () => {
      setTransientToken(null);
    };
  }, []);

  const baseHost = useMemo(() => deriveCustomHostHeadroom(view), [view]);
  const probeHost = useMemo(
    () => deriveCustomHostHeadroom(view, activeProbe?.response.host),
    [activeProbe?.response.host, view],
  );

  const effectiveFormatFilter: CustomModelSearchFormat =
    !baseHost.supportsMlx && formatFilter === "mlx" ? "gguf" : formatFilter;

  const search = useQuery({
    ...customModelSearchQueryOptions(client, tenantId, computerId, {
      format: effectiveFormatFilter,
      hub: hubFilter,
      limit: 20,
      query: searchQuery,
    }),
    enabled: view.available && canManage && !customUnsupported,
  });

  const searchUnsupported = isCustomUnsupportedError(search.error);
  const isUnsupported = customUnsupported || searchUnsupported;

  const activeDownload = useMemo(() => activeCustomDownload(view), [view]);
  const installed = useMemo(() => installedCustomModels(view), [view]);

  const lastDownloadBytesRef = useRef<number>(0);
  useEffect(() => {
    if (activeDownload) {
      lastDownloadBytesRef.current =
        activeDownload.model.download?.done_bytes ?? 0;
    }
  }, [activeDownload]);

  function handleMutationError(error: unknown) {
    if (isCustomUnsupportedError(error)) {
      setCustomUnsupported(true);
      setActionError(null);
      return;
    }
    if (
      error instanceof TeamHubError &&
      error.code === "LOCAL_COMPUTER_OFFLINE"
    ) {
      void invalidateOfflineComputer(queryClient, tenantId, computerId);
    }
    setActionError(
      actionErrorCopy(
        error instanceof TeamHubError ? error.code : undefined,
        t,
      ),
    );
  }

  const probeMutation = useMutation({
    mutationFn: (request: {
      matchedFileName?: string;
      payload: CustomModelProbeRequest;
      repoKey?: string;
      tokenUsed?: string;
    }) =>
      probeLocalComputerCustomModel(
        client,
        tenantId,
        computerId,
        request.payload,
      ),
    onError: (error) => {
      handleMutationError(error);
    },
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: (response, request) => {
      const nextHost = deriveCustomHostHeadroom(view, response.host);
      const variants = response.quant_variants ?? [];
      const chosen = selectSweetSpotQuant(variants, nextHost, {
        matchedFileName: request.matchedFileName,
        recommendedVariantId: response.recommended_variant_id,
        selectedQuantId: response.selected_quant_id,
      });

      const resolvedRepoKey = response.repo
        ? `${response.repo.hub}:${response.repo.repo_id}`
        : request.repoKey;

      if (
        response.outcome === "ready" &&
        request.tokenUsed &&
        resolvedRepoKey
      ) {
        setTransientToken({
          repoKey: resolvedRepoKey,
          token: request.tokenUsed,
        });
      } else if (
        resolvedRepoKey &&
        transientToken &&
        transientToken.repoKey !== resolvedRepoKey
      ) {
        setTransientToken(null);
      }

      const tokenError =
        response.outcome === "gated" && request.tokenUsed
          ? t(cm.tokenRejectedError, {
              status: response.hub_http_status ?? 401,
            })
          : undefined;

      setActiveProbe({
        matchedFileName: request.matchedFileName,
        response,
        selectedQuantId: chosen?.id ?? variants[0]?.id ?? "",
        target: request.payload.target,
        tokenError,
      });
    },
  });

  const downloadMutation = useMutation({
    mutationFn: (input: CustomModelDownloadInput) =>
      downloadLocalComputerCustomModel(client, tenantId, computerId, input),
    onError: (error) => {
      handleMutationError(error);
    },
    onMutate: () => {
      setActionError(null);
      setCancelNotice(null);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: localModelsQueryKey(tenantId, computerId),
      });
    },
  });

  const actionMutation = useMutation({
    mutationFn: (input: LocalModelActionInput) =>
      actOnLocalComputerModel(client, tenantId, computerId, input),
    onError: (error) => {
      handleMutationError(error);
    },
    onMutate: (input) => {
      setActionError(null);
      setPendingByModel((current) => ({
        ...current,
        [input.modelId]: input.action,
      }));
    },
    onSettled: (_data, _error, input) => {
      setPendingByModel((current) => {
        const next = { ...current };
        delete next[input.modelId];
        return next;
      });
      void queryClient.invalidateQueries({
        queryKey: localModelsQueryKey(tenantId, computerId),
      });
    },
    onSuccess: (_data, input) => {
      if (input.action === "cancel") {
        const cleanedBytes =
          lastDownloadBytesRef.current > 0
            ? lastDownloadBytesRef.current
            : undefined;
        setCancelNotice({ cleanedBytes });
      }
    },
  });

  function runProbe(input: {
    fileName?: string;
    hub?: CustomModelHub | "auto";
    revision?: string;
    target: string;
    token?: string;
  }) {
    const repoKey =
      input.hub && input.hub !== "auto"
        ? `${input.hub}:${input.target}`
        : undefined;
    if (!input.token) {
      setTransientToken(null);
    }
    probeMutation.mutate({
      matchedFileName: input.fileName,
      payload: {
        ...(input.fileName ? { file_name: input.fileName } : {}),
        ...(input.hub ? { hub: input.hub } : {}),
        ...(input.revision ? { revision: input.revision } : {}),
        target: input.target,
        ...(input.token ? { token: input.token } : {}),
      },
      repoKey,
      tokenUsed: input.token,
    });
  }

  function handleOmniboxSubmit() {
    const parsed = parseOmniboxInput(omniboxInput, omniboxHub);
    setCancelNotice(null);
    if (parsed.mode === "empty") {
      setSearchQuery("");
      return;
    }
    if (parsed.mode === "repo" && parsed.repoId) {
      const nextHub = parsed.hub ?? omniboxHub;
      setOmniboxHub(nextHub);
      runProbe({
        fileName: parsed.fileName,
        hub: nextHub,
        revision: parsed.revision,
        target: parsed.repoId,
      });
      return;
    }
    setSearchQuery(parsed.query);
  }

  function handleSelectRepo(item: CustomModelSearchResultItem) {
    setOmniboxHub(item.hub);
    setOmniboxInput(item.url || item.repo_id);
    setCancelNotice(null);
    runProbe({
      hub: item.hub,
      target: item.repo_id,
    });
  }

  function handleSearchGguf(query: string) {
    setOmniboxInput(query);
    setHubFilter("all");
    setFormatFilter("gguf");
    setSearchQuery(query);
  }

  function handleStartDownload(
    variant: CustomModelQuantVariant,
    acceptedRisk: boolean,
  ) {
    const repo = activeProbe?.response.repo;
    if (!repo) return;
    const repoKey = `${repo.hub}:${repo.repo_id}`;
    const token =
      transientToken?.repoKey === repoKey ? transientToken.token : undefined;
    downloadMutation.mutate({
      files: variant.files.map((file) => file.path),
      force_memory: acceptedRisk,
      hub: repo.hub,
      ...(variant.mmproj_file ? { mmproj: variant.mmproj_file } : {}),
      repo_id: repo.repo_id,
      ...(repo.revision ? { revision: repo.revision } : {}),
      ...(token ? { token } : {}),
      variant_id: variant.id,
    });
  }

  function handleRedownload(entry: LocalModelView) {
    const custom = entry.model.custom;
    if (!custom) return;
    downloadMutation.mutate({
      force_memory: Boolean(custom.accepted_risk),
      hub: custom.hub,
      ...(custom.mmproj_file ? { mmproj: custom.mmproj_file } : {}),
      replace: true,
      repo_id: custom.repo_id,
      ...(custom.revision ? { revision: custom.revision } : {}),
      variant_id: custom.variant_id,
    });
  }

  function toModelEntry(item: LocalModelView): ModelEntry {
    return { ...item, status: modelStatus(item.model) };
  }

  function handleLoadCustom(entry: LocalModelView) {
    const check = loadCheck(view, entry.model);
    if (check) {
      setDialog({ kind: "makeRoom", modelId: entry.model.id });
      return;
    }
    actionMutation.mutate({
      action: "load",
      contextTokens: entry.model.verification?.context_tokens,
      force: Boolean(entry.model.custom?.accepted_risk),
      modelId: entry.model.id,
    });
  }

  function handleUnloadCustom(entry: LocalModelView) {
    if (entry.used_by.length > 0) {
      setDialog({ kind: "unload", modelId: entry.model.id });
      return;
    }
    actionMutation.mutate({ action: "unload", modelId: entry.model.id });
  }

  function handleDeleteCustom(entry: LocalModelView) {
    if (entry.used_by.length > 0) {
      setDialog({ kind: "remove", modelId: entry.model.id });
      return;
    }
    actionMutation.mutate({ action: "remove", modelId: entry.model.id });
  }

  const selectedRepoKey = activeProbe?.response.repo
    ? `${activeProbe.response.repo.hub}:${activeProbe.response.repo.repo_id}`
    : undefined;

  const latestAttentionModel = installed.find((entry) => {
    const badge = customModelBadge(entry.model);
    return (
      badge === "untested" ||
      badge === "failed" ||
      entry.model.verification?.status === "running"
    );
  });

  const dialogTarget = dialog
    ? installed.find((entry) => entry.model.id === dialog.modelId)
    : undefined;
  const dialogEntry = dialogTarget ? toModelEntry(dialogTarget) : undefined;
  const dialogPool = dialogEntry
    ? poolOf(view, dialogEntry.model.pool)
    : undefined;
  const makeRoomCheck =
    dialog?.kind === "makeRoom" && dialogEntry
      ? (loadCheck(view, dialogEntry.model) ??
        (dialogPool
          ? {
              freeBytes: poolFreeBytes(dialogPool),
              kept: [],
              loaded: [],
              needBytes: dialogEntry.model.memory_bytes,
              pool: dialogPool,
            }
          : null))
      : null;

  const formatSummary = baseHost.supportsMlx
    ? t(cm.formatGgufAndMlx)
    : t(cm.formatGgufOnly);

  if (isUnsupported) {
    return (
      <div className="mt-5 rounded-xl border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-card text-app-warning shadow-outline">
            <Icon icon={Alert02Icon} size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">
              {t(cm.customUnsupportedTitle)}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(cm.customUnsupportedBody, {
                computer: view.computer.display_name,
              })}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const searchErrorCopy =
    search.isError && !searchUnsupported
      ? actionErrorCopy(
          search.error instanceof TeamHubError ? search.error.code : undefined,
          t,
        )
      : null;

  return (
    <div className="mt-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p className="min-w-0 flex-1">{t(cm.customTabDescription)}</p>
        <span className="shrink-0 rounded-md border border-border bg-card px-2.5 py-1 font-medium tabular-nums text-foreground">
          {t(cm.hostHeadroomChip, {
            free: formatGigabytes(baseHost.diskFreeBytes, t),
            host: baseHost.shortLabel,
          })}
        </span>
      </div>

      {readOnly && !offline ? (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          <Icon
            className="mt-0.5 shrink-0 text-muted-foreground"
            icon={InformationCircleIcon}
            size={16}
          />
          <p className="min-w-0 flex-1">
            {t(cm.readOnlyCustomNotice, { name: view.computer.display_name })}
          </p>
        </div>
      ) : null}

      {actionError ? (
        <FormFeedback tone="danger">{actionError}</FormFeedback>
      ) : null}

      {/* Asymmetric 2-column Variant C Custom Hub workspace */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* LEFT: Sticky Omnibox + Filters + Community Catalog + Installed Custom Models */}
        <div className="min-w-0 space-y-5">
          <div className="rounded-2xl border border-border bg-card p-4 shadow-outline lg:sticky lg:top-3 lg:z-10">
            <OmniboxInput
              disabled={!canManage}
              host={baseHost}
              hub={omniboxHub}
              inputValue={omniboxInput}
              loading={probeMutation.isPending}
              onChangeHub={(nextHub) => {
                setOmniboxHub(nextHub);
                setHubFilter(nextHub);
              }}
              onChangeInput={setOmniboxInput}
              onSubmit={handleOmniboxSubmit}
            />

            {/* Hub & Platform-aware Format filters */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    { id: "all", label: t(cm.hubAll) },
                    { id: "huggingface", label: t(cm.hubHuggingFace) },
                    { id: "modelscope", label: t(cm.hubModelScope) },
                  ] as const
                ).map((item) => (
                  <button
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50",
                      hubFilter === item.id
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground hover:text-foreground",
                    )}
                    disabled={!canManage}
                    key={item.id}
                    onClick={() => setHubFilter(item.id)}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-1">
                <Icon
                  className="text-muted-foreground"
                  icon={Layers01Icon}
                  size={13}
                />
                {(
                  [
                    {
                      id: "compatible",
                      label: t(cm.formatAuto, { formats: formatSummary }),
                    },
                    { id: "gguf", label: t(cm.formatGguf) },
                    ...(baseHost.supportsMlx
                      ? ([{ id: "mlx", label: t(cm.formatMlx) }] as const)
                      : []),
                  ] as const
                ).map((fmt) => (
                  <button
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50",
                      effectiveFormatFilter === fmt.id
                        ? "border-foreground/40 bg-background text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    disabled={!canManage}
                    key={fmt.id}
                    onClick={() => setFormatFilter(fmt.id)}
                    type="button"
                  >
                    {fmt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {cancelNotice ? (
            <div
              className="flex items-center justify-between gap-2 rounded-xl border border-border bg-muted/60 px-3.5 py-2.5 text-xs text-foreground"
              role="status"
            >
              <span className="flex items-center gap-1.5">
                <Icon icon={InformationCircleIcon} size={14} />
                {cancelNotice.cleanedBytes
                  ? t(cm.cancelCleanedNoticeWithSize, {
                      size: formatGigabytes(cancelNotice.cleanedBytes, t),
                    })
                  : t(cm.cancelCleanedNotice)}
              </span>
              <button
                className="text-muted-foreground hover:text-foreground"
                data-voice-close
                onClick={() => setCancelNotice(null)}
                type="button"
              >
                {t(cm.dismissNotice)}
              </button>
            </div>
          ) : null}

          {/* Browsable Community Catalog */}
          {canManage ? (
            <section className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {t(cm.catalogHeading)}
                </h2>
                {search.data ? (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {t(cm.catalogCount, { count: search.data.results.length })}
                  </span>
                ) : null}
              </div>

              {searchErrorCopy ? (
                <FormFeedback tone="danger">{searchErrorCopy}</FormFeedback>
              ) : (
                <SearchResultsList
                  disabled={probeMutation.isPending}
                  loading={search.isPending}
                  onSelectRepo={handleSelectRepo}
                  query={searchQuery}
                  results={search.data?.results ?? []}
                  selectedRepoKey={selectedRepoKey}
                  warnings={search.data?.warnings}
                />
              )}
            </section>
          ) : null}

          {/* Installed Custom Models section */}
          <section className="space-y-2.5 border-t border-border pt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t(cm.installedHeading, { count: installed.length })}
              </h2>
              <span className="text-[11px] text-muted-foreground">
                {baseHost.activeCuratedModel
                  ? t(cm.activeCuratedProtected, {
                      name: baseHost.activeCuratedModel.name,
                    })
                  : t(cm.standbyProtectedGeneric)}
              </span>
            </div>
            {installed.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-card/60 p-4 text-xs text-muted-foreground">
                {t(cm.noInstalledCustom)}
              </div>
            ) : (
              <div className="space-y-2.5">
                {installed.map((entry) => {
                  const canSwitchForAgents =
                    canManage &&
                    !switching &&
                    status?.mode === "local" &&
                    entry.model.state === "loaded" &&
                    entry.model.pi_model !== status.runtime_model &&
                    entry.model.id !== status.runtime_model;
                  return (
                    <InstalledCustomModelCard
                      canManage={canManage}
                      canSwitchForAgents={canSwitchForAgents}
                      entry={entry}
                      host={baseHost}
                      key={entry.model.id}
                      onDelete={handleDeleteCustom}
                      onLoad={handleLoadCustom}
                      onRedownload={handleRedownload}
                      onRunSmokeTest={(modelId, contextTokens) =>
                        actionMutation.mutate({
                          action: "smoke_test",
                          contextTokens,
                          modelId,
                        })
                      }
                      onUnload={handleUnloadCustom}
                      onUseForAgents={onUseForAgents}
                      pendingAction={pendingByModel[entry.model.id]}
                      switchingForAgents={switchingModelId === entry.model.id}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* RIGHT: Sticky Preflight & Quantization Inspector Rail */}
        <aside
          aria-label={t(cm.inspectorRegion)}
          className="min-w-0 space-y-3.5 rounded-2xl border border-border bg-sidebar/55 p-4 lg:sticky lg:top-3"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">
                {t(cm.inspectorTitle)}
              </h2>
              <p className="truncate text-[11px] text-muted-foreground tabular-nums">
                {probeHost.maxUsableMemoryBytes > 0
                  ? t(cm.inspectorHostCap, {
                      memory: formatGigabytes(
                        probeHost.maxUsableMemoryBytes,
                        t,
                      ),
                      platform: probeHost.platformLabel,
                    })
                  : t(cm.inspectorHostOnly, {
                      platform: probeHost.platformLabel,
                    })}
              </p>
            </div>
          </div>

          {activeDownload ? (
            <ActiveDownloadCard
              cancelling={pendingByModel[activeDownload.model.id] === "cancel"}
              disabled={!canManage}
              entry={activeDownload}
              onCancel={() =>
                actionMutation.mutate({
                  action: "cancel",
                  modelId: activeDownload.model.id,
                })
              }
            />
          ) : null}

          {probeMutation.isPending ? (
            <div
              aria-busy="true"
              className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card p-6 text-xs text-muted-foreground"
              role="status"
            >
              <Spinner size={15} />
              <span>{t(cm.loadingProbe)}</span>
            </div>
          ) : activeProbe?.response.outcome === "gated" &&
            activeProbe.response.repo ? (
            <GatedTokenCard
              disabled={!canManage}
              errorMessage={activeProbe.tokenError}
              httpStatus={activeProbe.response.hub_http_status ?? 401}
              key={activeProbe.response.repo.repo_id}
              loading={probeMutation.isPending}
              onUnlock={(token) =>
                runProbe({
                  fileName: activeProbe.matchedFileName,
                  hub: activeProbe.response.repo!.hub,
                  target: activeProbe.response.repo!.repo_id,
                  token,
                })
              }
              repo={activeProbe.response.repo}
            />
          ) : activeProbe?.response.outcome === "incompatible" &&
            activeProbe.response.repo ? (
            <IncompatibleRepoCard
              host={probeHost}
              onSearchGguf={handleSearchGguf}
              reason={activeProbe.response.reason ?? "raw_safetensors"}
              repo={activeProbe.response.repo}
              suggestedQuery={activeProbe.response.suggested_search_query}
            />
          ) : activeProbe?.response.outcome === "ready" ? (
            <PreflightPanel
              activeDownloadPresent={Boolean(activeDownload)}
              disabled={!canManage}
              host={probeHost}
              matchedFileName={activeProbe.matchedFileName}
              onSelectQuant={(quantId) =>
                setActiveProbe((current) =>
                  current ? { ...current, selectedQuantId: quantId } : null,
                )
              }
              onStartDownload={handleStartDownload}
              probe={activeProbe.response}
              selectedQuantId={activeProbe.selectedQuantId}
              startingDownload={downloadMutation.isPending}
            />
          ) : activeProbe?.response.outcome === "not_found" ? (
            <div className="rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
              <RichMessage
                message={cm.repoNotFound}
                tags={{
                  repo: (text) => (
                    <span className="font-medium text-foreground">{text}</span>
                  ),
                }}
                values={{
                  target: activeProbe.response.repo_id ?? activeProbe.target,
                }}
              />
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-card p-5 text-center text-xs text-muted-foreground">
              {t(cm.emptyInspector)}
            </div>
          )}

          {latestAttentionModel ? (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t(cm.smokeAttentionHeading)}
              </p>
              <InstalledCustomModelCard
                canManage={canManage}
                canSwitchForAgents={false}
                entry={latestAttentionModel}
                host={baseHost}
                onDelete={handleDeleteCustom}
                onLoad={handleLoadCustom}
                onRedownload={handleRedownload}
                onRunSmokeTest={(modelId, contextTokens) =>
                  actionMutation.mutate({
                    action: "smoke_test",
                    contextTokens,
                    modelId,
                  })
                }
                onUnload={handleUnloadCustom}
                pendingAction={pendingByModel[latestAttentionModel.model.id]}
              />
            </div>
          ) : null}
        </aside>
      </div>

      {dialogEntry && makeRoomCheck ? (
        <MakeRoomDialog
          check={makeRoomCheck}
          disabled={!canManage}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={(unloadFirst) => {
            setDialog(null);
            actionMutation.mutate({
              action: "load",
              contextTokens: dialogEntry.model.verification?.context_tokens,
              force: Boolean(dialogEntry.model.custom?.accepted_risk),
              modelId: dialogEntry.model.id,
              unloadFirst,
            });
          }}
          onRecheck={canManage ? onRefresh : undefined}
          rechecking={rechecking}
          view={view}
        />
      ) : null}

      {dialogEntry && dialog?.kind === "unload" ? (
        <UnloadModelDialog
          disabled={!canManage}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            actionMutation.mutate({
              action: "unload",
              modelId: dialogEntry.model.id,
            });
          }}
          view={view}
        />
      ) : null}

      {dialogEntry && dialog?.kind === "remove" ? (
        <RemoveModelDialog
          disabled={!canManage}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            actionMutation.mutate({
              action: "remove",
              modelId: dialogEntry.model.id,
            });
          }}
          view={view}
        />
      ) : null}
    </div>
  );
}
