import {
  AiChipIcon,
  AiSparklesIcon,
  ArrowDown01Icon,
  ChatGptIcon,
  ClaudeIcon,
  DeepseekIcon,
  GoogleGeminiIcon,
  GrokIcon,
  KimiAiIcon,
  MetaIcon,
  MicrosoftIcon,
  MistralIcon,
  QwenIcon,
} from "@hugeicons/core-free-icons";
import { isInkling2MiniModelId } from "@linger/service-kit/featured-models";
import { useId, type MouseEvent } from "react";
import { Link } from "react-router";

import { AutoHeight } from "@/components/ui/auto-height";
import { Button, buttonClassName } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import {
  type AssignableLocalModelAgent,
  isAgentUsingModel,
  primaryLocalModelAgent,
  usedByAgentNames,
} from "./local-model-agents";
import { ModelFacts } from "./local-model-details";
import {
  engineBadgeCopy,
  modelErrorShortCopy,
  unavailableShortCopy,
} from "./local-models-copy";
import { localModelsMessages as m } from "./local-models.messages";
import type {
  LocalModel,
  LocalModelAction,
  LocalModelsView,
} from "./local-models-queries";
import {
  collapsedRowBadges,
  downloadPercent,
  downloadStatusDetail,
  downloadStopped,
  formatGigabytes,
  joinList,
  modelBaseName,
  placeName,
  placeTitle,
  usedByBadge,
  type ModelEntry,
  type ModelStatus,
} from "./local-models-rules";

interface FamilyBrand {
  icon: IconSvgElement;
  tone: string;
}

const defaultBrand: FamilyBrand = {
  icon: AiChipIcon,
  tone: "bg-muted text-muted-foreground",
};

const featuredInklingBrand: FamilyBrand = {
  icon: AiSparklesIcon,
  tone: "bg-[var(--app-mention-surface)] text-app-info",
};

const familyBrands: Record<NonNullable<LocalModel["family"]>, FamilyBrand> = {
  claude: { icon: ClaudeIcon, tone: "bg-acorn-500/15 text-acorn-700" },
  deepseek: {
    icon: DeepseekIcon,
    tone: "bg-bluebell-500/15 text-bluebell-700",
  },
  gemma: {
    icon: GoogleGeminiIcon,
    tone: "bg-bluebell-500/15 text-bluebell-700",
  },
  glm: { icon: AiChipIcon, tone: "bg-grass-500/15 text-grass-700" },
  grok: { icon: GrokIcon, tone: "bg-fawn-500/15 text-fawn-700" },
  kimi: { icon: KimiAiIcon, tone: "bg-bubblegum-500/15 text-bubblegum-700" },
  llama: { icon: MetaIcon, tone: "bg-rain-500/15 text-rain-700" },
  mistral: { icon: MistralIcon, tone: "bg-sun-500/15 text-sun-700" },
  openai: { icon: ChatGptIcon, tone: "bg-lake-500/15 text-lake-700" },
  other: defaultBrand,
  phi: { icon: MicrosoftIcon, tone: "bg-lichen-500/15 text-lichen-700" },
  qwen: { icon: QwenIcon, tone: "bg-lavender-500/15 text-lavender-700" },
};

function modelBrand(model: LocalModel): FamilyBrand {
  if (isInkling2MiniModelId(model.id)) return featuredInklingBrand;
  return model.family && Object.hasOwn(familyBrands, model.family)
    ? familyBrands[model.family]
    : defaultBrand;
}

function cardTone(
  status: ModelStatus,
  inSpotlight: boolean,
  expanded: boolean,
  recommended: boolean,
): string {
  if (inSpotlight) {
    return cn(
      "rounded-none border-0 bg-card",
      !expanded && "hover:bg-muted/35",
    );
  }
  if (status === "failed") {
    return cn(
      "rounded-xl border bg-card",
      expanded
        ? "border-app-danger/45"
        : "border-[var(--app-status-danger-border)] hover:border-app-danger/45",
    );
  }
  if (status === "unavailable") {
    return cn(
      "rounded-xl border bg-muted/40",
      expanded ? "border-border-hover" : "border-border/70 hover:bg-muted/55",
    );
  }
  if (recommended) {
    return cn(
      "rounded-xl border bg-card",
      expanded
        ? "border-app-info/45"
        : "border-[var(--app-card-info-border)] hover:border-app-info/45 hover:bg-muted/30",
    );
  }
  return cn(
    "rounded-xl border bg-card",
    expanded
      ? "border-border-hover"
      : "border-border hover:border-border-hover hover:bg-muted/30",
  );
}

/**
 * The status word every row shows under its name, with the dot that colors
 * it. Models not on the Computer carry no dot, like an unconnected Connector.
 */
const statusTags: Record<
  ModelStatus,
  { dot?: string; label: Message<string>; working?: boolean }
> = {
  available: { label: m.statusAvailable },
  downloading: {
    dot: "bg-app-info",
    label: m.statusDownloading,
    working: true,
  },
  failed: { dot: "bg-app-danger", label: m.statusFailed },
  idle: { dot: "bg-muted-foreground/60", label: m.statusIdle },
  loaded: { dot: "bg-app-success", label: m.statusLoaded },
  loading: { dot: "bg-app-info", label: m.statusLoading, working: true },
  unavailable: { label: m.statusUnavailable },
};

/**
 * The label a row shows while an action that ends its current status is
 * under way: until a snapshot moves the model on, the status alone would
 * read as if nothing had happened.
 */
const endingLabels: Partial<Record<LocalModelAction, Message<string>>> = {
  cancel: m.endingCancel,
  remove: m.endingRemove,
  unload: m.endingUnload,
};

interface Handlers {
  onCancel: () => void;
  onDownload: () => void;
  onLoad: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onUnload: () => void;
  onUseForAgents?: () => void;
}

function stopRowClick(event: MouseEvent) {
  event.stopPropagation();
}

function OpenChatLink({
  href,
  onClick,
}: {
  href: string;
  onClick: (event: MouseEvent) => void;
}) {
  const t = useT();
  return (
    <Link
      className={buttonClassName({
        className: "px-2.5",
        size: "compact",
        tone: "ghost",
      })}
      onClick={onClick}
      to={href}
    >
      {t(m.openChat)}
    </Link>
  );
}

function RowStatusLine({
  availableSummary,
  detail,
  slower,
  status,
  tag,
}: {
  availableSummary: string;
  detail: string | null;
  slower: boolean;
  status: ModelStatus;
  tag: { dot?: string; label: Message<string>; working?: boolean };
}) {
  const t = useT();
  return (
    <span
      className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      data-status-line=""
    >
      {tag.dot ? (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", tag.dot)}
        />
      ) : null}
      <span
        className={cn(
          "min-w-0 leading-snug tabular-nums",
          tag.working && "town-shimmer-text",
        )}
      >
        <span
          className={
            status === "loaded"
              ? "font-medium text-app-success"
              : status === "failed"
                ? "text-app-danger"
                : tag.dot
                  ? "text-foreground"
                  : undefined
          }
        >
          {t(tag.label)}
        </span>
        {slower ? (
          <>
            {" · "}
            {availableSummary}
            {" · "}
            <span className="text-app-warning">{t(m.runsSlower)}</span>
          </>
        ) : detail ? (
          ` · ${detail}`
        ) : null}
      </span>
    </span>
  );
}

function availableDetailCopy(model: LocalModel, t: Translate): string {
  const download = formatGigabytes(model.download_bytes, t);
  if (model.memory_bytes <= 0) return download;
  const memory = formatGigabytes(model.memory_bytes, t);
  if (model.fit === "gpu") {
    if (model.host_ram_bytes && model.host_ram_bytes > 0) {
      return t(m.availableDetailWithVramAndRam, {
        download,
        ram: formatGigabytes(model.host_ram_bytes, t),
        vram: memory,
      });
    }
    return t(m.availableDetailWithVram, { download, vram: memory });
  }
  return t(m.availableDetailWithMemory, { download, memory });
}

function loadedMemoryCopy(model: LocalModel, t: Translate): string {
  const memory = formatGigabytes(model.memory_bytes, t);
  if (model.host_ram_bytes && model.host_ram_bytes > 0) {
    return t(m.loadedMemoryHybrid, {
      ram: formatGigabytes(model.host_ram_bytes, t),
      vram: memory,
    });
  }
  return memory;
}

function variantDetailCopy(entry: ModelEntry, t: Translate): string {
  const { model, status } = entry;
  if (status === "loaded") {
    return model.memory_bytes > 0
      ? [t(m.statusLoaded), loadedMemoryCopy(model, t)].join(" · ")
      : t(m.statusLoaded);
  }
  if (status === "idle") return t(m.statusIdle);
  if (status === "downloading") return t(m.statusDownloading);
  if (status === "loading") return t(m.statusLoading);
  if (status === "failed") {
    return t(downloadStopped(model) ? m.statusDownloadStopped : m.statusFailed);
  }
  if (status === "unavailable") {
    return (
      unavailableShortCopy(model.availability.reason, t) ??
      t(m.statusUnavailable)
    );
  }
  const base = availableDetailCopy(model, t);
  return model.recommended ? `${base} · ${t(m.recommended)}` : base;
}

function RowMetadataPills({
  badges,
  engine,
  engineBadge,
  engineTitle,
  featured,
  overflowTitle,
  status,
  usedBy,
  usedByTitle,
}: {
  badges: string[];
  engine?: LocalModel["engine"];
  engineBadge?: string;
  engineTitle?: string;
  featured: boolean;
  overflowTitle?: string;
  status: ModelStatus;
  usedBy?: string;
  usedByTitle?: string;
}) {
  const t = useT();
  const isAcceleratedEngine = engine === "polystrata" || engine === "strata";
  return (
    <div
      className={cn(
        "col-span-2 row-start-2 flex flex-wrap items-center gap-1.5 pl-13 @2xl:col-span-1 @2xl:col-start-2 @2xl:row-start-1 @2xl:justify-end @2xl:pl-0",
        status === "unavailable" && "opacity-60",
      )}
    >
      {featured ? (
        <span className="inline-flex h-[22px] items-center rounded-sm bg-[var(--app-mention-surface)] px-2 text-xs font-medium text-app-info">
          {t(m.featured)}
        </span>
      ) : null}
      {usedBy ? (
        <span
          className={cn(
            "inline-flex h-[22px] items-center gap-1.5 rounded-sm px-2 text-xs font-medium tabular-nums",
            status === "loaded"
              ? "bg-[var(--app-status-success-surface)] text-app-success"
              : "bg-muted text-secondary-foreground",
          )}
          title={usedByTitle}
        >
          {status === "loaded" ? (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-app-success"
            />
          ) : null}
          {usedBy}
        </span>
      ) : null}
      {engineBadge ? (
        <span
          className={cn(
            "inline-flex h-[22px] items-center rounded-sm px-2 text-xs font-medium",
            isAcceleratedEngine
              ? "bg-lavender-500/15 text-lavender-700"
              : "border border-border bg-card text-secondary-foreground",
          )}
          data-engine={engine}
          title={engineTitle}
        >
          {engineBadge}
        </span>
      ) : null}
      {badges.map((badge, index) => (
        <span
          className="inline-flex h-[22px] items-center rounded-sm bg-muted px-2 text-xs text-muted-foreground"
          key={badge}
          title={index === badges.length - 1 ? overflowTitle : undefined}
        >
          {badge}
        </span>
      ))}
    </div>
  );
}

function DownloadProgress({
  model,
  progress,
}: {
  model: LocalModel;
  progress: number;
}) {
  const t = useT();
  const shownProgress =
    model.download?.step === "verify" && !model.download.total_bytes
      ? 100
      : progress;
  return (
    <div className="px-4 pb-3">
      <span
        aria-label={t(m.downloadProgress, { name: model.name })}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={shownProgress}
        className="block h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <span
          className={cn(
            "block h-full origin-left rounded-full bg-app-info transition-transform duration-200 motion-reduce:transition-none",
            model.download?.step === "verify" &&
              "animate-pulse motion-reduce:animate-none",
          )}
          style={{ transform: `scaleX(${shownProgress / 100})` }}
        />
      </span>
    </div>
  );
}

/**
 * One catalog model on one Computer: a full-width Connectors-style card whose
 * header carries the status and one action, and which expands to the details.
 */
export function ModelRow({
  anotherMeChatHref,
  assignableAgents = [],
  assigningAgentId,
  computer,
  disabled,
  entry,
  expanded,
  hasReadyAlternatives = false,
  inSpotlight = false,
  onAssignAgent,
  onRecheck,
  onSelectVariant,
  onUpdateDriver,
  rechecking = false,
  requested,
  showEngineBadge = true,
  switchingForAgents = false,
  variants,
  view,
  ...handlers
}: Handlers & {
  anotherMeChatHref?: string;
  assignableAgents?: readonly AssignableLocalModelAgent[];
  assigningAgentId?: string;
  computer?: TeamHubLocalComputerPage["items"][number];
  /** Actions are off: the Computer is offline, the viewer only reads, or one is pending. */
  disabled: boolean;
  entry: ModelEntry;
  expanded: boolean;
  hasReadyAlternatives?: boolean;
  /** Rendered inside `FeaturedModelSpotlight`, which already carries the partner header. */
  inSpotlight?: boolean;
  onAssignAgent?: (agent: AssignableLocalModelAgent) => void;
  onRecheck?: () => void;
  onSelectVariant?: (modelId: string) => void;
  onUpdateDriver?: () => void;
  rechecking?: boolean;
  /** An action asked for and not yet in a snapshot. */
  requested?: LocalModelAction;
  /** Show non-accelerated engine pills (e.g. `llama.cpp`); accelerated engines always show. */
  showEngineBadge?: boolean;
  switchingForAgents?: boolean;
  /** Sibling versions of the same logical model when grouped into one card. */
  variants?: readonly ModelEntry[];
  view: LocalModelsView;
}) {
  const t = useT();
  const panelId = useId();
  const { model } = entry;
  // A requested load or download reads as started at once; the snapshot that
  // follows says how it went. A cancel can follow a download no snapshot
  // shows yet.
  const status: ModelStatus =
    requested === "load"
      ? "loading"
      : requested === "download" ||
          (requested === "cancel" && entry.status === "available")
        ? "downloading"
        : entry.status;
  const started = status !== entry.status;
  const stopped = status === "failed" && downloadStopped(model);
  const where = placeName(view, model.pool, t);
  const ending = requested && endingLabels[requested];
  const probingConcurrency =
    status === "loading" && !started && Boolean(model.concurrency_probing);
  const tag = ending
    ? {
        dot: statusTags[status].dot,
        label: stopped && requested === "cancel" ? m.endingDiscard : ending,
        working: true,
      }
    : probingConcurrency
      ? {
          ...statusTags.loading,
          label: m.statusProbingConcurrency,
        }
      : stopped
        ? { ...statusTags.failed, label: m.statusDownloadStopped }
        : statusTags[status];
  const progress = downloadPercent(model);
  const availableSummary = availableDetailCopy(model, t);
  const recommended = status === "available" && model.recommended;
  const featured = isInkling2MiniModelId(model.id);
  const showFeaturedPill = featured && !inSpotlight;
  const slower =
    status === "available" && !model.recommended && model.fit === "system";
  const hasVariants = Boolean(
    variants && variants.length > 1 && onSelectVariant,
  );
  const displayName = modelBaseName(model);
  const variantEngines = hasVariants
    ? new Set(variants!.map((variant) => variant.model.engine).filter(Boolean))
    : undefined;
  const showVariantEngine = Boolean(variantEngines && variantEngines.size > 1);
  const hasDuplicateQuant = hasVariants
    ? new Set(
        variants!.map((variant) => variant.model.quant || variant.model.name),
      ).size < variants!.length
    : false;
  const brand = modelBrand(model);
  const computerId = view.computer.computer_id;
  const usedNames = usedByAgentNames(entry, assignableAgents, computerId);
  const usedBy = usedByBadge({ ...entry, status }, t, usedNames);
  const usedByTitle = usedNames.length
    ? t(m.usedByNames, { names: joinList(usedNames, t) })
    : undefined;
  const primaryAgent = primaryLocalModelAgent(assignableAgents);
  const primaryUsing = primaryAgent
    ? isAgentUsingModel(entry, primaryAgent, computerId)
    : false;
  const canUsePrimary =
    status === "loaded" &&
    Boolean(model.pi_model) &&
    Boolean(primaryAgent) &&
    Boolean(onAssignAgent);
  const isAcceleratedEngine =
    model.engine === "polystrata" || model.engine === "strata";
  const engineBadge =
    showEngineBadge || isAcceleratedEngine
      ? engineBadgeCopy(model.engine)
      : undefined;
  const engineTitle = model.engine_label ?? engineBadge;
  const { badges, overflowTitle } = collapsedRowBadges(model, t);
  const hasMeta =
    showFeaturedPill ||
    Boolean(usedBy) ||
    Boolean(engineBadge) ||
    badges.length > 0;
  const damagedFiles =
    status === "failed" &&
    (model.error?.code === "CHECKSUM_MISMATCH" ||
      model.error?.code === "MODEL_FILES_MISSING");
  const detail = {
    available: availableSummary,
    downloading: started ? null : downloadStatusDetail(model, t),
    failed: modelErrorShortCopy(model.error, t) ?? null,
    idle: model.note
      ? t(m.noRoomYet)
      : usedNames.length
        ? t(m.loadToAnswer)
        : null,
    loaded: [placeTitle(view, model.pool, t), loadedMemoryCopy(model, t)]
      .filter(Boolean)
      .join(" · "),
    loading: where ?? null,
    unavailable: unavailableShortCopy(model.availability.reason, t),
  }[status];

  // The button's word, what it does, the action it asks for, and its name
  // with the model for assistive technology.
  const action = (
    {
      available: [
        m.actionDownload,
        handlers.onDownload,
        "download",
        m.downloadModel,
      ],
      downloading: [
        commonMessages.cancel,
        handlers.onCancel,
        "cancel",
        m.cancelModel,
      ],
      failed: stopped
        ? ([
            m.actionResumeDownload,
            handlers.onDownload,
            "download",
            m.resumeDownloadModel,
          ] as const)
        : damagedFiles
          ? ([
              commonMessages.remove,
              handlers.onRemove,
              "remove",
              m.removeModel,
            ] as const)
          : ([
              commonMessages.retry,
              handlers.onLoad,
              "load",
              m.retryModel,
            ] as const),
      idle: [m.actionLoad, handlers.onLoad, "load", m.loadModel],
      loaded: [m.actionUnload, handlers.onUnload, "unload", m.unloadModel],
      loading: null,
      unavailable: null,
    } as const
  )[status];
  const showsPrimaryAssignButton =
    !(status === "loaded" && handlers.onUseForAgents) &&
    canUsePrimary &&
    Boolean(primaryAgent) &&
    !primaryUsing &&
    Boolean(onAssignAgent);
  // A stopped download has no record to remove; discarding it deletes the
  // kept partial instead.
  const removable =
    status === "loaded" ||
    status === "idle" ||
    (status === "failed" && !stopped);

  return (
    <article
      className={cn(
        "@container overflow-hidden transition-[background-color,border-color] duration-150 motion-reduce:transition-none",
        cardTone(status, inSpotlight, expanded, recommended),
      )}
      data-featured={featured || undefined}
      data-recommended={recommended || undefined}
      data-status={status}
    >
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3",
          hasMeta && "@2xl:grid-cols-[minmax(0,1fr)_auto_auto]",
        )}
      >
        <button
          aria-controls={panelId}
          aria-expanded={expanded}
          aria-label={displayName}
          className={cn(
            "col-span-2 col-start-1 row-start-1 flex min-w-0 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @md:col-span-1",
            status === "unavailable" && "opacity-60",
          )}
          onClick={handlers.onToggle}
          type="button"
        >
          <span
            aria-hidden
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-lg shadow-outline",
              brand.tone,
            )}
            data-family={model.family ?? "other"}
          >
            <Icon icon={brand.icon} size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {displayName}
              </span>
              {recommended ? (
                <span className="inline-flex h-5 shrink-0 items-center rounded-sm bg-[var(--app-mention-surface)] px-1.5 text-xs font-medium text-app-info">
                  {t(m.recommended)}
                </span>
              ) : null}
            </span>
            <RowStatusLine
              availableSummary={availableSummary}
              detail={ending ? null : detail}
              slower={slower}
              status={status}
              tag={tag}
            />
          </span>
        </button>
        {hasMeta ? (
          <RowMetadataPills
            badges={badges}
            engine={model.engine}
            engineBadge={engineBadge}
            engineTitle={engineTitle}
            featured={showFeaturedPill}
            overflowTitle={overflowTitle}
            status={status}
            usedBy={usedBy}
            usedByTitle={usedByTitle}
          />
        ) : null}
        <div
          className={cn(
            "col-span-2 mt-0.5 flex flex-wrap items-center justify-end gap-1.5 border-t border-border/60 pt-2.5 @md:col-span-1 @md:col-start-2 @md:row-start-1 @md:mt-0 @md:flex-nowrap @md:border-t-0 @md:pt-0",
            hasMeta ? "row-start-3 @2xl:col-start-3" : "row-start-2",
          )}
        >
          {hasVariants && variants && onSelectVariant ? (
            <Select
              align="right"
              aria-label={t(m.chooseVersion, { name: displayName })}
              className="max-w-44 shrink-0"
              onValueChange={onSelectVariant}
              value={model.id}
              variant="pill"
            >
              {variants.map((variant) => {
                const quantLabel = variant.model.quant || variant.model.name;
                const engineCopy = showVariantEngine
                  ? engineBadgeCopy(variant.model.engine)
                  : undefined;
                const optionLabel = engineCopy
                  ? t(m.variantLabelWithEngine, {
                      engine: engineCopy,
                      quant: quantLabel,
                    })
                  : quantLabel;
                const triggerLabel = hasDuplicateQuant
                  ? optionLabel
                  : quantLabel;
                return (
                  <SelectItem
                    key={variant.model.id}
                    triggerLabel={triggerLabel}
                    value={variant.model.id}
                  >
                    {t(m.variantOptionDetail, {
                      detail: variantDetailCopy(variant, t),
                      label: optionLabel,
                    })}
                  </SelectItem>
                );
              })}
            </Select>
          ) : model.quant ? (
            <span
              className={cn(
                "inline-flex h-7 max-w-44 shrink-0 items-center truncate rounded-full border border-border/70 bg-muted/40 px-2.5 text-xs font-medium text-muted-foreground",
                status === "unavailable" && "opacity-60",
              )}
              title={`${t(m.factVersion)}: ${model.quant}`}
            >
              {model.quant}
            </span>
          ) : null}
          {status === "loaded" && handlers.onUseForAgents ? (
            <Button
              aria-label={t(m.useForAgentsNamed, { name: model.name })}
              className="px-2.5"
              disabled={disabled}
              loading={switchingForAgents}
              onClick={(event) => {
                stopRowClick(event);
                handlers.onUseForAgents?.();
              }}
              size="compact"
              tone="primary"
            >
              {t(m.useForAgents)}
            </Button>
          ) : showsPrimaryAssignButton && primaryAgent && onAssignAgent ? (
            <Button
              aria-label={t(m.useWithNamed, {
                agent: primaryAgent.name,
                model: model.name,
              })}
              className="px-2.5"
              disabled={
                disabled || primaryAgent.busy || Boolean(assigningAgentId)
              }
              loading={assigningAgentId === primaryAgent.actorId}
              onClick={(event) => {
                stopRowClick(event);
                onAssignAgent(primaryAgent);
              }}
              size="compact"
              title={
                primaryAgent.busy
                  ? t(m.waitForTurn, { agent: primaryAgent.name })
                  : undefined
              }
              tone="primary"
            >
              {t(m.useWith, { agent: primaryAgent.name })}
            </Button>
          ) : !handlers.onUseForAgents &&
            canUsePrimary &&
            primaryAgent?.isAnotherMe &&
            primaryUsing &&
            anotherMeChatHref ? (
            <OpenChatLink href={anotherMeChatHref} onClick={stopRowClick} />
          ) : null}
          {action ? (
            <Button
              aria-label={t(action[3], { name: model.name })}
              className="px-2.5"
              disabled={disabled}
              loading={requested === action[2]}
              onClick={(event) => {
                stopRowClick(event);
                action[1]();
              }}
              size="compact"
              tone={
                status === "downloading"
                  ? "ghost"
                  : damagedFiles
                    ? "danger"
                    : recommended
                      ? "primary"
                      : "secondary"
              }
            >
              {t(action[0])}
            </Button>
          ) : status === "unavailable" &&
            model.availability.reason?.code === "DRIVER_UPDATE_REQUIRED" &&
            onUpdateDriver ? (
            <Button
              aria-label={t(m.updateDriverNamed, { name: model.name })}
              className="px-2.5"
              onClick={(event) => {
                stopRowClick(event);
                onUpdateDriver();
              }}
              size="compact"
              tone={inSpotlight && !expanded ? "primary" : "secondary"}
            >
              {t(m.updateDriver)}
            </Button>
          ) : null}
          <Button
            aria-hidden
            className="text-muted-foreground"
            onClick={handlers.onToggle}
            size="compactIcon"
            tabIndex={-1}
            tone="ghost"
          >
            <Icon
              className={cn(
                "transition-transform duration-200 motion-reduce:transition-none",
                !expanded && "-rotate-90",
              )}
              icon={ArrowDown01Icon}
              size={14}
            />
          </Button>
        </div>
      </div>
      {entry.status === "downloading" ? (
        <DownloadProgress model={model} progress={progress} />
      ) : null}
      {expanded ? (
        <AutoHeight appear>
          <div
            aria-label={t(m.detailsOf, { name: model.name })}
            className="border-t border-border bg-app-canvas/60 px-4 pt-3 pb-3.5"
            id={panelId}
            role="region"
          >
            {model.description ? (
              <p className="pb-2.5 text-sm text-muted-foreground">
                {model.description}
              </p>
            ) : null}
            <ModelFacts
              assignableAgents={assignableAgents}
              assigningAgentId={assigningAgentId}
              computer={computer}
              disabled={disabled}
              entry={entry}
              hasPrimaryAssignAction={showsPrimaryAssignButton}
              hasReadyAlternatives={hasReadyAlternatives}
              onAssignAgent={onAssignAgent}
              onRecheck={onRecheck}
              onUpdateDriver={onUpdateDriver}
              rechecking={rechecking}
              view={view}
            />
            {removable || stopped ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
                {removable ? (
                  <Button
                    data-voice-risk="never"
                    disabled={disabled}
                    loading={requested === "remove"}
                    onClick={handlers.onRemove}
                    size="compact"
                    tone="danger"
                  >
                    {t(m.removeFromComputer)}
                  </Button>
                ) : null}
                {stopped ? (
                  <Button
                    data-voice-risk="never"
                    disabled={disabled}
                    loading={requested === "cancel"}
                    onClick={handlers.onCancel}
                    size="compact"
                    tone="danger"
                  >
                    {t(m.discardDownload)}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </AutoHeight>
      ) : null}
    </article>
  );
}
