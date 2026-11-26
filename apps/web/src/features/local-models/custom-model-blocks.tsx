import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CloudDownloadIcon,
  Delete02Icon,
  Download01Icon,
  HardDriveIcon,
  InformationCircleIcon,
  Key01Icon,
  Layers01Icon,
  Link01Icon,
  LockPasswordIcon,
  PlayIcon,
  RefreshIcon,
  Search01Icon,
  Shield01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { RichMessage, useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format-bytes";

import { customModelsMessages as cm } from "./custom-models.messages";
import type {
  CustomModelHub,
  CustomModelIncompatibleReason,
  CustomModelProbeRepo,
  CustomModelProbeResponse,
  CustomModelQuantVariant,
  CustomModelSearchResultItem,
} from "./custom-models-queries";
import {
  type CustomHostHeadroom,
  customModelBadge,
  evaluatePreflight,
  formatCompactCount,
  parseOmniboxInput,
  requiredDiskBytes,
} from "./custom-model-rules";
import { familyBrand } from "./local-model-brand";
import type { LocalModelAction, LocalModelView } from "./local-models-queries";
import { downloadPercent, formatGigabytes } from "./local-models-rules";

export function OmniboxInput({
  disabled = false,
  host,
  hub,
  inputValue,
  loading = false,
  onChangeHub,
  onChangeInput,
  onSubmit,
}: {
  disabled?: boolean;
  host: CustomHostHeadroom;
  hub: CustomModelHub;
  inputValue: string;
  loading?: boolean;
  onChangeHub: (hub: CustomModelHub) => void;
  onChangeInput: (value: string) => void;
  onSubmit: () => void;
}) {
  const t = useT();
  const parsed = parseOmniboxInput(inputValue, hub);
  const isDirectRepo = parsed.mode === "repo";
  const formatSummary = host.supportsMlx
    ? t(cm.formatGgufAndMlx)
    : t(cm.formatGgufOnly);

  function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    if (disabled || loading) return;
    onSubmit();
  }

  return (
    <form className="space-y-2" onSubmit={handleFormSubmit}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          aria-label={t(cm.hubSourceGroup)}
          className="inline-flex rounded-lg border border-border bg-muted/60 p-0.5"
          role="group"
        >
          <button
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              hub === "huggingface"
                ? "bg-card text-foreground shadow-outline"
                : "text-muted-foreground hover:text-foreground",
            )}
            disabled={disabled}
            onClick={() => onChangeHub("huggingface")}
            type="button"
          >
            {t(cm.hubHuggingFace)}
          </button>
          <button
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              hub === "modelscope"
                ? "bg-card text-foreground shadow-outline"
                : "text-muted-foreground hover:text-foreground",
            )}
            disabled={disabled}
            onClick={() => onChangeHub("modelscope")}
            type="button"
          >
            {t(cm.hubModelScope)}
          </button>
        </div>

        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          <Icon icon={Layers01Icon} size={12} />
          {formatSummary}
        </span>
      </div>

      <div className="flex items-stretch gap-2">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground">
            <Icon icon={isDirectRepo ? Link01Icon : Search01Icon} size={15} />
          </span>
          <input
            aria-label={t(cm.omniboxLabel)}
            className="ui-field-control h-9 w-full pr-8 pl-8 text-sm text-foreground"
            disabled={disabled}
            onChange={(event) => onChangeInput(event.target.value)}
            placeholder={t(cm.omniboxPlaceholder)}
            type="text"
            value={inputValue}
          />
          {inputValue && !disabled ? (
            <button
              aria-label={t(cm.clearInput)}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => onChangeInput("")}
              type="button"
            >
              <Icon icon={Cancel01Icon} size={13} />
            </button>
          ) : null}
        </div>
        <Button
          disabled={disabled}
          loading={loading}
          size="compact"
          tone="primary"
          type="submit"
        >
          {t(isDirectRepo ? cm.probeAction : cm.searchAction)}
        </Button>
      </div>
    </form>
  );
}

export function GatedTokenCard({
  disabled = false,
  errorMessage,
  httpStatus,
  loading = false,
  onUnlock,
  repo,
}: {
  disabled?: boolean;
  errorMessage?: string;
  httpStatus: number;
  loading?: boolean;
  onUnlock: (token: string) => void;
  repo: CustomModelProbeRepo;
}) {
  const t = useT();
  const [token, setToken] = useState("");
  const [emptyError, setEmptyError] = useState(false);
  const tokenPrefix = repo.hub === "huggingface" ? "hf_" : "ms_";
  const hubName =
    repo.hub === "huggingface" ? t(cm.hubHuggingFace) : t(cm.hubModelScope);

  function handleUnlock(event: FormEvent) {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setEmptyError(true);
      return;
    }
    setEmptyError(false);
    onUnlock(trimmed);
  }

  return (
    <div className="rounded-xl border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-app-warning shadow-outline">
          <Icon icon={LockPasswordIcon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">
              {t(cm.gatedTitle)}
            </h4>
            <span className="rounded-sm bg-card px-1.5 py-0.5 text-[11px] font-medium text-app-warning shadow-outline">
              {t(cm.gatedHttpBadge, { status: httpStatus })}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            <RichMessage
              message={cm.gatedDescription}
              tags={{
                repo: (text) => (
                  <span className="font-medium text-foreground">{text}</span>
                ),
              }}
              values={{ hub: hubName, repoId: repo.repo_id }}
            />
          </p>

          <form className="mt-3 space-y-2" onSubmit={handleUnlock}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[180px] flex-1">
                <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground">
                  <Icon icon={Key01Icon} size={14} />
                </span>
                <input
                  aria-label={t(cm.tokenLabel)}
                  autoComplete="off"
                  className="ui-field-control h-9 w-full pl-8 text-xs text-foreground"
                  disabled={disabled || loading}
                  onChange={(event) => {
                    setToken(event.target.value);
                    if (emptyError) setEmptyError(false);
                  }}
                  placeholder={t(cm.tokenPlaceholder, { prefix: tokenPrefix })}
                  type="password"
                  value={token}
                />
              </div>
              <Button
                disabled={disabled}
                loading={loading}
                size="compact"
                tone="primary"
                type="submit"
              >
                {t(loading ? cm.unlockingRepo : cm.unlockRepo)}
              </Button>
            </div>
            {emptyError ? (
              <p className="text-xs text-app-danger" role="alert">
                {t(cm.tokenEmptyError)}
              </p>
            ) : errorMessage ? (
              <p className="text-xs text-app-danger" role="alert">
                {errorMessage}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {t(cm.tokenZeroDownloadNote)}
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export function IncompatibleRepoCard({
  host,
  onSearchGguf,
  reason,
  repo,
  suggestedQuery,
}: {
  host: CustomHostHeadroom;
  onSearchGguf: (query: string) => void;
  reason: CustomModelIncompatibleReason;
  repo: CustomModelProbeRepo;
  suggestedQuery?: string;
}) {
  const t = useT();
  const title =
    reason === "mlx_unsupported"
      ? t(cm.incompatibleMlxTitle)
      : reason === "no_runnable_files"
        ? t(cm.incompatibleNoFilesTitle)
        : t(cm.incompatibleSafetensorsTitle);

  return (
    <div className="rounded-xl border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-app-danger shadow-outline">
          <Icon icon={AlertCircleIcon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">{title}</h4>
            <span className="rounded-sm bg-card px-1.5 py-0.5 text-[11px] font-medium text-app-danger shadow-outline">
              {t(cm.installBlockedBadge)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {reason === "mlx_unsupported" ? (
              <RichMessage
                message={cm.incompatibleMlxBody}
                tags={{
                  host: (text) => (
                    <span className="font-medium text-foreground">{text}</span>
                  ),
                  repo: (text) => (
                    <span className="font-medium text-foreground">{text}</span>
                  ),
                }}
                values={{ host: host.platformLabel, repoId: repo.repo_id }}
              />
            ) : reason === "no_runnable_files" ? (
              <RichMessage
                message={cm.incompatibleNoFilesBody}
                tags={{
                  repo: (text) => (
                    <span className="font-medium text-foreground">{text}</span>
                  ),
                }}
                values={{ repoId: repo.repo_id }}
              />
            ) : (
              <RichMessage
                message={cm.incompatibleSafetensorsBody}
                tags={{
                  code: (text) => (
                    <code className="rounded bg-card px-1 py-0.5 text-[11px]">
                      {text}
                    </code>
                  ),
                  repo: (text) => (
                    <span className="font-medium text-foreground">{text}</span>
                  ),
                }}
                values={{ repoId: repo.repo_id }}
              />
            )}
          </p>
          {suggestedQuery ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                onClick={() => onSearchGguf(suggestedQuery)}
                size="compact"
                tone="primary"
              >
                <Icon icon={Search01Icon} size={14} />
                {t(cm.searchGgufEquivalents)}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {t(cm.suggestedQueryLabel, { query: suggestedQuery })}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function SearchResultsList({
  disabled = false,
  loading = false,
  onSelectRepo,
  query,
  results,
  selectedRepoKey,
  warnings = [],
}: {
  disabled?: boolean;
  loading?: boolean;
  onSelectRepo: (item: CustomModelSearchResultItem) => void;
  query: string;
  results: readonly CustomModelSearchResultItem[];
  selectedRepoKey?: string;
  warnings?: readonly string[];
}) {
  const t = useT();

  if (loading) {
    return (
      <div aria-busy="true" className="space-y-2" role="status">
        <span className="sr-only">{t(cm.loadingCatalog)}</span>
        {[0, 1, 2].map((index) => (
          <div
            className="flex items-start gap-3 rounded-xl border border-border bg-card p-3"
            key={index}
          >
            <Skeleton className="mt-0.5 size-9 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-full max-w-md" />
              <Skeleton className="h-3 w-36" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {warnings.length > 0 ? (
        <div
          className="rounded-xl border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] px-3.5 py-2 text-xs text-app-warning"
          role="status"
        >
          {warnings.join(" · ")}
        </div>
      ) : null}

      {results.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5 text-center">
          <p className="text-sm font-medium text-foreground">
            {query
              ? t(cm.noSearchResultsTitle, { query })
              : t(cm.noSearchResultsEmptyTitle)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(cm.noSearchResultsBody)}
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {query
                ? t(cm.catalogResultsSummaryQuery, {
                    count: results.length,
                    query,
                  })
                : t(cm.catalogResultsSummary, { count: results.length })}
            </span>
            <span>{t(cm.zeroDownloadProbe)}</span>
          </div>

          {results.map((repo) => {
            const brand = familyBrand(repo.family);
            const repoKey = `${repo.hub}:${repo.repo_id}`;
            const isSelected = repoKey === selectedRepoKey;
            return (
              <button
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-60",
                  isSelected
                    ? "border-foreground/40 bg-muted/60 shadow-outline"
                    : "border-border bg-card hover:border-border-hover hover:bg-muted/30",
                )}
                disabled={disabled}
                key={repoKey}
                onClick={() => onSelectRepo(repo)}
                type="button"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg",
                    brand.tone,
                  )}
                >
                  <Icon icon={brand.icon} size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-foreground">
                      {repo.repo_id}
                    </span>
                    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-secondary-foreground">
                      {repo.format}
                    </span>
                    <span className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {repo.hub === "huggingface"
                        ? t(cm.hubHuggingFaceShort)
                        : t(cm.hubModelScope)}
                    </span>
                    {repo.gated ? (
                      <span className="rounded-sm bg-[var(--app-status-warning-surface)] px-1.5 py-0.5 text-[10px] font-medium text-app-warning">
                        {t(cm.gatedPill)}
                      </span>
                    ) : null}
                    {!repo.compatible ? (
                      <span className="rounded-sm bg-[var(--app-status-danger-surface)] px-1.5 py-0.5 text-[10px] font-medium text-app-danger">
                        {t(cm.incompatiblePill)}
                      </span>
                    ) : null}
                  </div>
                  {repo.description ? (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {repo.description}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
                    {repo.parameter_billions !== undefined ? (
                      <span>
                        {t(cm.paramsBillions, {
                          value: Number(repo.parameter_billions.toFixed(1)),
                        })}
                      </span>
                    ) : null}
                    {repo.quant_count !== undefined && repo.quant_count > 0 ? (
                      <span>
                        {t(cm.quantsCount, { count: repo.quant_count })}
                      </span>
                    ) : null}
                    {repo.default_quant ? (
                      <span>
                        {repo.default_quant.label} (
                        {formatGigabytes(repo.default_quant.size_bytes, t)})
                      </span>
                    ) : null}
                    <span>
                      {t(cm.pullsCount, {
                        count: formatCompactCount(repo.downloads),
                      })}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

export function PreflightPanel({
  activeDownloadPresent,
  disabled = false,
  host,
  matchedFileName,
  onSelectQuant,
  onStartDownload,
  probe,
  selectedQuantId,
  startingDownload = false,
}: {
  activeDownloadPresent: boolean;
  disabled?: boolean;
  host: CustomHostHeadroom;
  matchedFileName?: string;
  onSelectQuant: (quantId: string) => void;
  onStartDownload: (
    variant: CustomModelQuantVariant,
    acceptedRisk: boolean,
  ) => void;
  probe: CustomModelProbeResponse;
  selectedQuantId: string;
  startingDownload?: boolean;
}) {
  const t = useT();
  const [shardsExpanded, setShardsExpanded] = useState(false);

  const repo = probe.repo;
  const variants = probe.quant_variants ?? [];
  const selectedQuant =
    variants.find((q) => q.id === selectedQuantId) ?? variants[0];

  if (!repo || !selectedQuant) {
    return null;
  }

  const assessment = evaluatePreflight({
    host,
    metadataComplete: probe.metadata_complete ?? true,
    metadataNote: probe.metadata_note,
    quantVariants: variants,
    selectedQuant,
  });
  const brand = familyBrand(repo.family);
  const isSweetSpot = probe.recommended_variant_id === selectedQuant.id;

  const diskPctOfFree =
    assessment.diskFreeBytes > 0
      ? Math.min(
          100,
          (assessment.diskRequiredBytes / assessment.diskFreeBytes) * 100,
        )
      : assessment.diskOk
        ? 0
        : 100;
  const memPctOfMax =
    assessment.hostMaxMemoryBytes > 0
      ? Math.min(
          100,
          (assessment.estimatedMemoryBytes / assessment.hostMaxMemoryBytes) *
            100,
        )
      : 100;

  const memoryBadgeStyle =
    assessment.memoryTier === "comfortable"
      ? "bg-[var(--app-status-success-surface)] text-app-success border-[var(--app-status-success-border)]"
      : assessment.memoryTier === "tight"
        ? "bg-[var(--app-status-warning-surface)] text-app-warning border-[var(--app-status-warning-border)]"
        : "bg-[var(--app-status-danger-surface)] text-app-danger border-[var(--app-status-danger-border)]";

  const memoryTierLabel =
    assessment.memoryTier === "comfortable"
      ? t(cm.tierComfortable)
      : assessment.memoryTier === "tight"
        ? t(cm.tierTight)
        : assessment.memoryTier === "unknown"
          ? t(cm.tierUnknownMeta)
          : t(cm.tierExceedsCeiling);

  const memoryReason =
    assessment.memoryTier === "unknown"
      ? (assessment.metadataNote ?? t(cm.reasonUnknownMeta))
      : assessment.memoryTier === "exceeds"
        ? t(cm.reasonExceeds, {
            estimated: formatGigabytes(assessment.estimatedMemoryBytes, t),
            max: formatGigabytes(assessment.hostMaxMemoryBytes, t),
          })
        : assessment.memoryTier === "tight"
          ? t(cm.reasonTight, {
              estimated: formatGigabytes(assessment.estimatedMemoryBytes, t),
              max: formatGigabytes(assessment.hostMaxMemoryBytes, t),
            })
          : t(cm.reasonComfortable, {
              estimated: formatGigabytes(assessment.estimatedMemoryBytes, t),
              max: formatGigabytes(assessment.hostMaxMemoryBytes, t),
            });

  const downloadBlocked =
    disabled ||
    activeDownloadPresent ||
    startingDownload ||
    selectedQuant.already_installed;

  return (
    <div className="space-y-3">
      {/* Probed repository header */}
      <div className="rounded-xl border border-border bg-card p-3.5">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              brand.tone,
            )}
          >
            <Icon icon={brand.icon} size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h4 className="truncate text-sm font-semibold text-foreground">
                {repo.repo_id}
              </h4>
              {repo.format ? (
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-secondary-foreground">
                  {repo.format}
                </span>
              ) : null}
              <span className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {repo.hub === "huggingface"
                  ? t(cm.hubHuggingFace)
                  : t(cm.hubModelScope)}
              </span>
              {probe.token_provided ? (
                <span className="rounded-sm bg-[var(--app-status-success-surface)] px-1.5 py-0.5 text-[10px] font-medium text-app-success">
                  {t(cm.tokenUnlockedBadge)}
                </span>
              ) : null}
            </div>
            {probe.gguf_meta ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {probe.gguf_meta.architecture ? (
                  <span>
                    {t(cm.archMeta, { arch: probe.gguf_meta.architecture })}
                  </span>
                ) : null}
                {probe.gguf_meta.n_ctx_train ? (
                  <span>
                    {t(cm.contextKilo, {
                      value: Math.round(probe.gguf_meta.n_ctx_train / 1024),
                    })}
                  </span>
                ) : null}
                {probe.gguf_meta.moe ? <span>{t(cm.moeMeta)}</span> : null}
                {repo.license ? <span>{repo.license}</span> : null}
              </div>
            ) : repo.license ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {repo.license}
              </p>
            ) : null}
            {matchedFileName ? (
              <p className="mt-1 text-[11px] text-app-info">
                {t(cm.matchedFileNote, { file: matchedFileName })}
              </p>
            ) : null}
          </div>
        </div>

        {/* Selected sweet-spot quant summary */}
        <div className="mt-3 rounded-lg border border-border bg-background px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-foreground">
                {selectedQuant.label}
              </span>
              {isSweetSpot ? (
                <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--app-mention-surface)] px-1.5 py-0.5 text-[10px] font-medium text-app-info">
                  <Icon icon={SparklesIcon} size={11} />
                  {t(cm.sweetSpotBadge)}
                </span>
              ) : null}
              {selectedQuant.already_installed ? (
                <span className="rounded-sm bg-[var(--app-status-success-surface)] px-1.5 py-0.5 text-[10px] font-medium text-app-success">
                  {t(cm.alreadyInstalledBadge)}
                </span>
              ) : null}
              {selectedQuant.shard_count > 1 ? (
                <button
                  aria-expanded={shardsExpanded}
                  className="inline-flex items-center gap-1 rounded-sm bg-lavender-500/15 px-1.5 py-0.5 text-[10px] font-medium text-lavender-700 hover:bg-lavender-500/25"
                  onClick={() => setShardsExpanded((open) => !open)}
                  type="button"
                >
                  {t(cm.shardsMerged, { count: selectedQuant.shard_count })}
                  <Icon
                    icon={shardsExpanded ? ArrowUp01Icon : ArrowDown01Icon}
                    size={11}
                  />
                </button>
              ) : null}
            </div>
            <span className="text-xs font-medium tabular-nums text-foreground">
              {t(cm.downloadSizeLabel, {
                size: formatGigabytes(selectedQuant.total_download_bytes, t),
              })}
            </span>
          </div>
          {selectedQuant.bits_per_weight !== undefined ? (
            <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
              {t(cm.bitsPerWeight, {
                bits: Number(selectedQuant.bits_per_weight.toFixed(2)),
              })}
            </p>
          ) : null}
          {selectedQuant.mmproj_file ? (
            <p className="mt-1.5 flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-[11px] text-foreground">
              <Icon
                className="shrink-0"
                icon={InformationCircleIcon}
                size={13}
              />
              <span className="truncate">
                {t(cm.mmprojCompanionNote, {
                  file: selectedQuant.mmproj_file,
                  size: formatGigabytes(selectedQuant.mmproj_bytes, t),
                })}
              </span>
            </p>
          ) : null}
          {shardsExpanded && selectedQuant.files.length > 1 ? (
            <ul className="mt-2 space-y-0.5 border-t border-border pt-2 font-mono text-[10px] text-muted-foreground">
              {selectedQuant.files.map((file) => (
                <li className="truncate" key={file.path}>
                  • {file.path}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* Quantization selector grid */}
        {variants.length > 1 ? (
          <div className="mt-2.5">
            <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t(cm.selectQuantHeading, { count: variants.length })}
            </p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {variants.map((variant) => {
                const chosen = variant.id === selectedQuant.id;
                const varCheck = evaluatePreflight({
                  host,
                  metadataComplete: probe.metadata_complete ?? true,
                  quantVariants: variants,
                  selectedQuant: variant,
                });
                return (
                  <button
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors",
                      chosen
                        ? "border-foreground/50 bg-muted/70 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:border-border-hover hover:text-foreground",
                    )}
                    key={variant.id}
                    onClick={() => onSelectQuant(variant.id)}
                    type="button"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <span className="truncate">{variant.label}</span>
                        {variant.shard_count > 1 ? (
                          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                            {variant.shard_count}x
                          </span>
                        ) : null}
                      </div>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {t(cm.quantOptionMeta, {
                          memory: formatGigabytes(
                            varCheck.estimatedMemoryBytes,
                            t,
                          ),
                          size: formatGigabytes(
                            variant.total_download_bytes,
                            t,
                          ),
                        })}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        !varCheck.diskOk
                          ? "bg-app-danger"
                          : varCheck.memoryTier === "comfortable"
                            ? "bg-app-success"
                            : varCheck.memoryTier === "tight"
                              ? "bg-app-warning"
                              : "bg-sun-500",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {/* Honest Tiered Preflight Card */}
      <div className="rounded-xl border border-border bg-card p-3.5">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t(cm.preflightHeading, { host: host.shortLabel })}
          </h4>
          <span className="text-[11px] text-muted-foreground">
            {t(cm.standbyIsolatedBadge)}
          </span>
        </div>

        {/* 1. Disk Space (ONLY hard-stop) */}
        <div className="mt-3 rounded-lg border border-border bg-background p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <Icon icon={HardDriveIcon} size={14} />
              {t(cm.diskHeadroomLabel)}
            </span>
            <span
              className={cn(
                "font-medium tabular-nums",
                assessment.diskOk ? "text-app-success" : "text-app-danger",
              )}
            >
              {t(cm.diskFreeRatio, {
                free: formatGigabytes(assessment.diskFreeBytes, t),
                required: formatGigabytes(assessment.diskRequiredBytes, t),
              })}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-200",
                assessment.diskOk ? "bg-app-success" : "bg-app-danger",
              )}
              style={{ width: `${diskPctOfFree}%` }}
            />
          </div>
          {!assessment.diskOk ? (
            <div className="mt-2 space-y-2 rounded-md border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] p-2.5 text-xs">
              <p className="font-medium text-app-danger">
                <RichMessage
                  message={cm.diskHardStop}
                  tags={{
                    code: (text) => <code className="text-[11px]">{text}</code>,
                  }}
                />
              </p>
              {assessment.smallerDiskFitQuant ? (
                <Button
                  onClick={() =>
                    onSelectQuant(assessment.smallerDiskFitQuant!.id)
                  }
                  size="compact"
                  tone="primary"
                >
                  {t(cm.switchSmallerQuant, {
                    label: assessment.smallerDiskFitQuant.label,
                    required: formatGigabytes(
                      assessment.smallerDiskFitQuant.disk_required_bytes ||
                        requiredDiskBytes(
                          assessment.smallerDiskFitQuant.total_download_bytes,
                        ),
                      t,
                    ),
                    size: formatGigabytes(
                      assessment.smallerDiskFitQuant.total_download_bytes,
                      t,
                    ),
                  })}
                </Button>
              ) : (
                <p className="text-muted-foreground">
                  {t(cm.freeDiskNeeded, {
                    shortfall: formatGigabytes(
                      assessment.diskShortfallBytes,
                      t,
                    ),
                  })}
                </p>
              )}
            </div>
          ) : null}
        </div>

        {/* 2. Memory / VRAM (Transparent estimate — NEVER a dead-end) */}
        <div className="mt-2.5 rounded-lg border border-border bg-background p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
            <span className="font-medium text-foreground">
              {t(cm.memoryEstimateLabel)}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
                memoryBadgeStyle,
              )}
            >
              {memoryTierLabel}
            </span>
          </div>

          <div className="mt-1.5 flex items-baseline justify-between gap-2 text-xs tabular-nums">
            <span className="text-muted-foreground">
              {assessment.memoryEstimateBasis === "gguf_header"
                ? t(cm.memoryBasisGguf)
                : t(cm.memoryBasisRough)}
            </span>
            <span className="shrink-0 font-medium text-foreground">
              {t(cm.memoryRatio, {
                estimated: formatGigabytes(assessment.estimatedMemoryBytes, t),
                max: formatGigabytes(assessment.hostMaxMemoryBytes, t),
              })}
            </span>
          </div>

          <div className="mt-2 space-y-1">
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-200",
                  assessment.memoryTier === "comfortable"
                    ? "bg-app-success"
                    : assessment.memoryTier === "tight"
                      ? "bg-app-warning"
                      : "bg-sun-500",
                )}
                style={{ width: `${memPctOfMax}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{t(cm.gaugeSafe)}</span>
              <span>{t(cm.gaugeTight)}</span>
              <span>
                {t(cm.gaugeMax, {
                  max: formatGigabytes(assessment.hostMaxMemoryBytes, t),
                })}
              </span>
            </div>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">{memoryReason}</p>

          {assessment.smallerMemoryQuant &&
          assessment.memoryTier !== "comfortable" ? (
            <div className="mt-2">
              <button
                className="text-xs font-medium text-app-link underline-offset-2 hover:underline"
                onClick={() => onSelectQuant(assessment.smallerMemoryQuant!.id)}
                type="button"
              >
                {t(cm.tipSmallerMemory, {
                  label: assessment.smallerMemoryQuant.label,
                  memory: formatGigabytes(
                    assessment.smallerMemoryQuant.estimated_memory_bytes,
                    t,
                  ),
                })}
              </button>
            </div>
          ) : null}
        </div>

        {/* Action CTA */}
        <div className="mt-3 flex flex-col gap-2">
          {!assessment.diskOk ? (
            <Button className="w-full" disabled tone="primary">
              {t(cm.insufficientDiskCta, {
                required: formatGigabytes(assessment.diskRequiredBytes, t),
              })}
            </Button>
          ) : selectedQuant.already_installed ? (
            <Button className="w-full" disabled tone="secondary">
              <Icon icon={CheckmarkCircle02Icon} size={15} />
              {t(cm.alreadyInstalledCta, { label: selectedQuant.label })}
            </Button>
          ) : assessment.requiresEscapeHatch ? (
            <div className="space-y-2 rounded-lg border border-sun-500/35 bg-sun-500/10 p-2.5">
              <div className="flex items-start gap-2 text-xs text-sun-700">
                <Icon
                  className="mt-0.5 shrink-0"
                  icon={Alert02Icon}
                  size={15}
                />
                <span>
                  {host.activeCuratedModel ? (
                    <RichMessage
                      message={cm.escapeHatchNoticeWithActive}
                      tags={{
                        strong: (text) => <strong>{text}</strong>,
                      }}
                      values={{ activeModel: host.activeCuratedModel.name }}
                    />
                  ) : (
                    <RichMessage
                      message={cm.escapeHatchNoticeStandalone}
                      tags={{
                        strong: (text) => <strong>{text}</strong>,
                      }}
                    />
                  )}
                </span>
              </div>
              <Button
                className="w-full border-sun-500/40 bg-sun-500 text-white hover:bg-sun-700"
                data-voice-risk="confirm"
                disabled={downloadBlocked}
                loading={startingDownload}
                onClick={() => onStartDownload(selectedQuant, true)}
                tone="secondary"
              >
                {startingDownload ? null : (
                  <Icon icon={Download01Icon} size={15} />
                )}
                {t(
                  startingDownload
                    ? cm.startingDownloadCta
                    : cm.installAnywayCta,
                )}
              </Button>
            </div>
          ) : (
            <Button
              className="w-full"
              disabled={downloadBlocked}
              loading={startingDownload}
              onClick={() => onStartDownload(selectedQuant, false)}
              tone="primary"
            >
              {startingDownload ? null : (
                <Icon icon={CloudDownloadIcon} size={15} />
              )}
              {startingDownload
                ? t(cm.startingDownloadCta)
                : t(cm.downloadInstallCta, {
                    label: selectedQuant.label,
                    size: formatGigabytes(
                      selectedQuant.total_download_bytes,
                      t,
                    ),
                  })}
            </Button>
          )}

          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Icon className="shrink-0" icon={Shield01Icon} size={13} />
            {t(cm.standbyFooterNote)}
          </p>
        </div>
      </div>
    </div>
  );
}

export function ActiveDownloadCard({
  cancelling = false,
  disabled = false,
  entry,
  onCancel,
}: {
  cancelling?: boolean;
  disabled?: boolean;
  entry: LocalModelView;
  onCancel: () => void;
}) {
  const t = useT();
  const { model } = entry;
  const progress = model.download;
  const percent = downloadPercent(model);
  const doneBytes = progress?.done_bytes ?? 0;
  const totalBytes = progress?.total_bytes ?? model.download_bytes;
  const shardCount = progress?.shard_count ?? model.custom?.shard_count ?? 1;
  const shardIndex = progress?.shard_index ?? 1;
  const speed =
    progress?.bytes_per_second && progress.bytes_per_second > 0
      ? `${formatBytes(progress.bytes_per_second)}/s`
      : undefined;

  return (
    <div className="rounded-xl border border-[var(--app-card-info-border)] bg-[var(--app-card-info-surface)] p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Spinner size={14} />
            <span className="truncate text-sm font-semibold text-foreground">
              {progress?.step === "verify"
                ? t(cm.verifyingTitle)
                : t(cm.downloadingTitle, {
                    name: model.custom?.repo_id ?? model.name,
                  })}
            </span>
          </div>
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            {model.quant}
            {shardCount > 1
              ? ` · ${t(cm.shardProgress, { current: shardIndex, total: shardCount })}`
              : ""}{" "}
            · {formatGigabytes(doneBytes, t)} / {formatGigabytes(totalBytes, t)}
            {speed ? ` · ${speed}` : ""}
          </p>
        </div>
        <Button
          data-voice-close
          disabled={disabled}
          loading={cancelling}
          onClick={onCancel}
          size="compact"
          tone="danger"
        >
          {t(cancelling ? cm.cancellingDownload : cm.cancelDownload)}
        </Button>
      </div>

      <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-card">
        <div
          className="h-full rounded-full bg-app-info transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{t(cm.resumableHint)}</span>
        <span className="font-medium tabular-nums text-foreground">
          {percent}%
        </span>
      </div>
    </div>
  );
}

export function InstalledCustomModelCard({
  canManage,
  canSwitchForAgents,
  entry,
  host,
  onDelete,
  onLoad,
  onRedownload,
  onRunSmokeTest,
  onUnload,
  onUseForAgents,
  pendingAction,
  switchingForAgents = false,
}: {
  canManage: boolean;
  canSwitchForAgents: boolean;
  entry: LocalModelView;
  host: CustomHostHeadroom;
  onDelete: (entry: LocalModelView) => void;
  onLoad: (entry: LocalModelView) => void;
  onRedownload: (entry: LocalModelView) => void;
  onRunSmokeTest: (modelId: string, contextTokens: number) => void;
  onUnload: (entry: LocalModelView) => void;
  onUseForAgents?: (modelId: string) => void;
  pendingAction?: LocalModelAction;
  switchingForAgents?: boolean;
}) {
  const t = useT();
  const [logOpen, setLogOpen] = useState(false);
  const { model } = entry;
  const brand = familyBrand(model.family);
  const badge = customModelBadge(model);
  const verification = model.verification;
  const failure = verification?.failure;
  const smokeRunning =
    verification?.status === "running" || pendingAction === "smoke_test";
  const smokeContext = verification?.context_tokens ?? 4096;
  const repoTitle = model.custom?.repo_id ?? model.name;
  const shardCount = model.custom?.shard_count ?? 1;
  const isLoaded = model.state === "loaded";
  const isLoading = model.state === "loading" || pendingAction === "load";
  const isUnloading = pendingAction === "unload";
  const isRemoving = pendingAction === "remove";
  const rowBusy = smokeRunning || isLoading || isUnloading || isRemoving;

  const badgeConfig =
    badge === "verified"
      ? {
          cls: "bg-[var(--app-status-success-surface)] text-app-success border-[var(--app-status-success-border)]",
          label: t(cm.badgeVerified),
        }
      : badge === "failed"
        ? {
            cls: "bg-[var(--app-status-danger-surface)] text-app-danger border-[var(--app-status-danger-border)]",
            label: t(cm.badgeFailed),
          }
        : {
            cls: "bg-[var(--app-status-warning-surface)] text-app-warning border-[var(--app-status-warning-border)]",
            label: t(cm.badgeUntested),
          };

  const failureCopy = failure
    ? failure.kind === "oom"
      ? {
          detail: t(cm.smokeOomDetail),
          headline: t(cm.smokeOomHeadline, { ctx: failure.context_tokens }),
          kindLabel: t(cm.failureKindOom),
        }
      : failure.kind === "unsupported_arch"
        ? {
            detail: t(cm.smokeUnsupportedArchDetail),
            headline: t(cm.smokeUnsupportedArchHeadline),
            kindLabel: t(cm.failureKindUnsupportedArch),
          }
        : failure.kind === "corrupt"
          ? {
              detail: t(cm.smokeCorruptDetail),
              headline: t(cm.smokeCorruptHeadline),
              kindLabel: t(cm.failureKindCorrupt),
            }
          : {
              detail: t(cm.smokeUnknownDetail),
              headline: t(cm.smokeUnknownHeadline),
              kindLabel: t(cm.failureKindUnknown),
            }
    : undefined;

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-3.5 transition-colors",
        badge === "failed"
          ? "border-[var(--app-status-danger-border)]"
          : "border-border hover:border-border-hover",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
              brand.tone,
            )}
          >
            <Icon icon={brand.icon} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {repoTitle}
              </span>
              <span className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                {model.quant}
              </span>
              <span
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold",
                  badgeConfig.cls,
                )}
              >
                {badgeConfig.label}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
              <span>
                {t(cm.onDiskSize, {
                  size: formatGigabytes(model.download_bytes, t),
                })}
              </span>
              {shardCount > 1 ? (
                <span>· {t(cm.shardsCount, { count: shardCount })}</span>
              ) : null}
              <span>· {t(cm.standbyRestartSafe)}</span>
              {isLoaded ? (
                <span className="font-medium text-app-success">
                  · {t(cm.activeForAgents)}
                </span>
              ) : null}
            </div>
            {model.custom?.mmproj_file ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t(cm.mmprojCompanionNote, {
                  file: model.custom.mmproj_file,
                  size: formatGigabytes(model.custom.mmproj_bytes ?? 0, t),
                })}
              </p>
            ) : null}
          </div>
        </div>

        {canManage ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {smokeRunning ? (
              <Button disabled size="compact" tone="secondary">
                <Spinner size={13} />
                {t(cm.smokeRunning, { ctx: smokeContext })}
              </Button>
            ) : isLoading ? (
              <Button disabled size="compact" tone="secondary">
                <Spinner size={13} />
                {t(cm.loadingModel)}
              </Button>
            ) : isUnloading ? (
              <Button disabled size="compact" tone="secondary">
                <Spinner size={13} />
                {t(cm.unloadingModel)}
              </Button>
            ) : isRemoving ? (
              <Button disabled size="compact" tone="secondary">
                <Spinner size={13} />
                {t(cm.removingModel)}
              </Button>
            ) : badge === "untested" ? (
              <Button
                onClick={() => onRunSmokeTest(model.id, 4096)}
                size="compact"
                tone="primary"
              >
                <Icon icon={PlayIcon} size={13} />
                {t(cm.smokeTestCta)}
              </Button>
            ) : badge === "verified" ? (
              <>
                {isLoaded ? (
                  <>
                    {canSwitchForAgents && onUseForAgents ? (
                      <Button
                        loading={switchingForAgents}
                        onClick={() => onUseForAgents(model.id)}
                        size="compact"
                        tone="primary"
                      >
                        {t(cm.useForAgents)}
                      </Button>
                    ) : null}
                    <Button
                      onClick={() => onUnload(entry)}
                      size="compact"
                      tone="secondary"
                    >
                      <Icon icon={CheckmarkCircle02Icon} size={13} />
                      {t(cm.returnToStandby)}
                    </Button>
                  </>
                ) : (
                  <Button
                    onClick={() => onLoad(entry)}
                    size="compact"
                    tone="primary"
                  >
                    <Icon icon={CheckmarkCircle02Icon} size={13} />
                    {t(cm.useForAgents)}
                  </Button>
                )}
              </>
            ) : null}

            <Button
              aria-label={t(cm.deleteModelLabel, { name: repoTitle })}
              data-voice-risk="never"
              disabled={rowBusy}
              onClick={() => onDelete(entry)}
              size="compact"
              tone="ghost"
            >
              <Icon icon={Delete02Icon} size={14} />
              <span className="hidden sm:inline">{t(cm.deleteButton)}</span>
            </Button>
          </div>
        ) : null}
      </div>

      {/* Smoke Test Failure Recovery Box */}
      {badge === "failed" && failure && failureCopy ? (
        <div className="mt-3 rounded-lg border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-semibold text-app-danger">
              <Icon icon={AlertCircleIcon} size={14} />
              {failureCopy.headline}
            </span>
            <span className="rounded bg-card px-1.5 py-0.5 text-[10px] font-medium uppercase text-app-danger shadow-outline">
              {failureCopy.kindLabel}
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">{failureCopy.detail}</p>
          <p className="mt-1 text-[11px] font-medium text-foreground">
            {host.activeCuratedModel
              ? t(cm.safetyNetIntactWithActive, {
                  activeModel: host.activeCuratedModel.name,
                })
              : t(cm.safetyNetIntactStandalone)}
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {canManage && failure.can_retry_lower_ctx ? (
              <Button
                disabled={rowBusy}
                onClick={() => onRunSmokeTest(model.id, 2048)}
                size="compact"
                tone="primary"
              >
                <Icon icon={RefreshIcon} size={13} />
                {t(cm.retryLowerCtxCta)}
              </Button>
            ) : null}
            {canManage && failure.can_redownload && model.custom ? (
              <Button
                disabled={rowBusy}
                onClick={() => onRedownload(entry)}
                size="compact"
                tone="primary"
              >
                <Icon icon={CloudDownloadIcon} size={13} />
                {t(cm.redownloadCta)}
              </Button>
            ) : null}
            {canManage ? (
              <Button
                data-voice-risk="never"
                disabled={rowBusy}
                onClick={() => onDelete(entry)}
                size="compact"
                tone="danger"
              >
                <Icon icon={Delete02Icon} size={13} />
                {t(cm.deleteAndFree, {
                  size: formatGigabytes(model.download_bytes, t),
                })}
              </Button>
            ) : null}
            {failure.diagnostic_log ? (
              <button
                aria-expanded={logOpen}
                className="ml-auto text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => setLogOpen((open) => !open)}
                type="button"
              >
                {t(logOpen ? cm.collapseDiagnosticLog : cm.showDiagnosticLog)}
              </button>
            ) : null}
          </div>

          {logOpen && failure.diagnostic_log ? (
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-card p-2 font-mono text-[11px] leading-relaxed text-foreground">
              {failure.diagnostic_log}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
