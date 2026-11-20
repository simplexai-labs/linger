import {
  AiChipIcon,
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
import { useId, type MouseEvent } from "react";
import { Link } from "react-router";

import { Button, buttonClassName } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import {
  type AssignableLocalModelAgent,
  isAgentUsingModel,
  primaryLocalModelAgent,
  usedByAgentNames,
} from "./local-model-agents";
import { ModelFacts } from "./local-model-details";
import { modelErrorShortCopy, unavailableShortCopy } from "./local-models-copy";
import type {
  LocalModel,
  LocalModelAction,
  LocalModelsView,
} from "./local-models-queries";
import {
  collapsedRowBadges,
  downloadMemoryCheck,
  downloadPercent,
  downloadStatusDetail,
  downloadStopped,
  formatGigabytes,
  placeName,
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

function familyBrand(family: LocalModel["family"]): FamilyBrand {
  return family ? familyBrands[family] : defaultBrand;
}

function cardTone(
  status: ModelStatus,
  recommended: boolean,
  expanded: boolean,
): string {
  if (status === "loaded") {
    return cn(
      "bg-card shadow-sm",
      expanded
        ? "border-app-success/45"
        : "border-[var(--app-status-success-border)] hover:border-app-success/45",
    );
  }
  if (recommended) {
    return cn(
      "bg-[var(--app-card-info-surface)]",
      expanded
        ? "border-app-info/45"
        : "border-[var(--app-card-info-border)] hover:border-app-info/45",
    );
  }
  if (status === "downloading" || status === "loading") {
    return cn(
      "bg-card",
      expanded ? "border-app-info/45" : "border-[var(--app-card-info-border)]",
    );
  }
  if (status === "failed") {
    return cn(
      "bg-card",
      expanded
        ? "border-app-danger/45"
        : "border-[var(--app-status-danger-border)] hover:border-app-danger/45",
    );
  }
  if (status === "unavailable") {
    return cn(
      "bg-muted/35",
      expanded ? "border-border-hover" : "border-border/70 hover:bg-muted/55",
    );
  }
  return cn(
    "bg-card",
    expanded ? "border-border-hover" : "border-border hover:bg-accent/40",
  );
}

/**
 * The status word every row shows under its name, with the dot that colors
 * it. Models not on the Computer carry no dot, like an unconnected Connector.
 */
const statusTags: Record<
  ModelStatus,
  { dot?: string; label: string; working?: boolean }
> = {
  available: { label: "Not downloaded" },
  downloading: {
    dot: "bg-app-info",
    label: "Downloading",
    working: true,
  },
  failed: { dot: "bg-app-danger", label: "Couldn't load" },
  idle: { dot: "bg-muted-foreground/60", label: "Downloaded" },
  loaded: { dot: "bg-app-success", label: "Loaded" },
  loading: { dot: "bg-app-info", label: "Loading", working: true },
  unavailable: { label: "Can't download" },
};

/**
 * The label a row shows while an action that ends its current status is
 * under way: until a snapshot moves the model on, the status alone would
 * read as if nothing had happened.
 */
const endingLabels: Partial<Record<LocalModelAction, string>> = {
  cancel: "Cancelling",
  remove: "Removing",
  unload: "Unloading",
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
      Open chat
    </Link>
  );
}

function RowStatusLine({
  detail,
  download,
  lowMemoryNeedBytes,
  recommended,
  slower,
  status,
  tag,
}: {
  detail: string | null;
  download: string;
  lowMemoryNeedBytes?: number;
  recommended: boolean;
  slower: boolean;
  status: ModelStatus;
  tag: { dot?: string; label: string; working?: boolean };
}) {
  const lowMemoryNotice =
    lowMemoryNeedBytes !== undefined ? (
      <>
        {" · "}
        <span className="text-app-warning">
          needs {formatGigabytes(lowMemoryNeedBytes)} free to load
        </span>
      </>
    ) : null;
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {tag.dot ? (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", tag.dot)}
        />
      ) : null}
      <span
        className={cn(
          "truncate tabular-nums",
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
          {tag.label}
        </span>
        {recommended ? (
          <>
            {" · "}
            {download}
            {" · "}
            <span className="font-medium text-app-info">Recommended</span>
            {lowMemoryNotice}
          </>
        ) : slower ? (
          <>
            {" · "}
            {download}
            {" · "}
            <span className="text-app-warning">runs slower</span>
            {lowMemoryNotice}
          </>
        ) : detail ? (
          <>
            {` · ${detail}`}
            {lowMemoryNotice}
          </>
        ) : (
          lowMemoryNotice
        )}
      </span>
    </span>
  );
}

function RowMetadataPills({
  badges,
  overflowTitle,
  status,
  usedBy,
  usedByTitle,
}: {
  badges: string[];
  overflowTitle?: string;
  status: ModelStatus;
  usedBy?: string;
  usedByTitle?: string;
}) {
  return (
    <div
      className={cn(
        "col-span-2 row-start-2 flex flex-wrap items-center gap-1.5 pl-13 @2xl:col-span-1 @2xl:col-start-2 @2xl:row-start-1 @2xl:justify-end @2xl:pl-0",
        status === "unavailable" && "opacity-60",
      )}
    >
      {usedBy ? (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
            status === "loaded"
              ? "bg-[var(--app-status-success-surface)] text-app-success"
              : "bg-muted text-secondary-foreground",
          )}
          title={usedByTitle}
        >
          {usedBy}
        </span>
      ) : null}
      {badges.map((badge, index) => (
        <span
          className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
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
  const shownProgress =
    model.download?.step === "verify" && !model.download.total_bytes
      ? 100
      : progress;
  return (
    <div className="px-4 pb-3">
      <span
        aria-label={`${model.name} download progress`}
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
  onAssignAgent,
  requested,
  switchingForAgents = false,
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
  onAssignAgent?: (agent: AssignableLocalModelAgent) => void;
  /** An action asked for and not yet in a snapshot. */
  requested?: LocalModelAction;
  switchingForAgents?: boolean;
  view: LocalModelsView;
}) {
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
  const where = placeName(view, model.pool);
  const ending = requested && endingLabels[requested];
  const tag = ending
    ? {
        dot: statusTags[status].dot,
        label: stopped && requested === "cancel" ? "Discarding" : ending,
        working: true,
      }
    : stopped
      ? { ...statusTags.failed, label: "Download stopped" }
      : statusTags[status];
  const progress = downloadPercent(model);
  const download = formatGigabytes(model.download_bytes);
  const recommended = status === "available" && model.recommended;
  const slower =
    status === "available" && !model.recommended && model.fit === "system";
  const lowMemory =
    status === "available" ? downloadMemoryCheck(view, model) : null;
  const brand = familyBrand(model.family);
  const computerId = view.computer.computer_id;
  const usedNames = usedByAgentNames(entry, assignableAgents, computerId);
  const usedBy = usedByBadge({ ...entry, status }, usedNames);
  const usedByTitle = usedNames.length
    ? `Used by ${usedNames.join(", ")}`
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
  const { badges, overflowTitle } = collapsedRowBadges(model);
  const hasMeta = Boolean(usedBy) || badges.length > 0;
  const damagedFiles =
    status === "failed" &&
    (model.error?.code === "CHECKSUM_MISMATCH" ||
      model.error?.code === "MODEL_FILES_MISSING");
  const detail = {
    available: download,
    downloading: started ? null : downloadStatusDetail(model),
    failed: modelErrorShortCopy(model.error) ?? null,
    idle: model.note
      ? "no room to load yet"
      : usedNames.length
        ? "load to answer"
        : null,
    loaded: [
      where ? `${where[0]!.toUpperCase()}${where.slice(1)}` : undefined,
      formatGigabytes(model.memory_bytes),
    ]
      .filter(Boolean)
      .join(" · "),
    loading: where ?? null,
    unavailable: unavailableShortCopy(model.availability.reason),
  }[status];

  const action = (
    {
      available: ["Download", handlers.onDownload, "download"],
      downloading: ["Cancel", handlers.onCancel, "cancel"],
      failed: stopped
        ? (["Resume download", handlers.onDownload, "download"] as const)
        : damagedFiles
          ? (["Remove", handlers.onRemove, "remove"] as const)
          : (["Retry", handlers.onLoad, "load"] as const),
      idle: ["Load", handlers.onLoad, "load"],
      loaded: ["Unload", handlers.onUnload, "unload"],
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
        "@container rounded-xl border transition-[background-color,border-color,box-shadow] duration-150 motion-reduce:transition-none",
        cardTone(status, recommended, expanded),
      )}
      data-recommended={recommended || undefined}
      data-status={status}
    >
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2 px-4 py-3",
          hasMeta && "@2xl:grid-cols-[minmax(0,1fr)_auto_auto]",
        )}
      >
        <button
          aria-controls={panelId}
          aria-expanded={expanded}
          aria-label={model.name}
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
            <span className="block truncate text-sm font-medium text-foreground">
              {model.name}
            </span>
            <RowStatusLine
              detail={ending ? null : detail}
              download={download}
              lowMemoryNeedBytes={lowMemory?.needBytes}
              recommended={recommended}
              slower={slower}
              status={status}
              tag={tag}
            />
          </span>
        </button>
        {hasMeta ? (
          <RowMetadataPills
            badges={badges}
            overflowTitle={overflowTitle}
            status={status}
            usedBy={usedBy}
            usedByTitle={usedByTitle}
          />
        ) : null}
        <div
          className={cn(
            "col-span-2 flex flex-wrap items-center justify-end gap-1.5 pl-13 @md:col-span-1 @md:col-start-2 @md:row-start-1 @md:flex-nowrap @md:pl-0",
            hasMeta ? "row-start-3 @2xl:col-start-3" : "row-start-2",
          )}
        >
          {status === "loaded" && handlers.onUseForAgents ? (
            <Button
              aria-label={`Use ${model.name} for Agents`}
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
              Use for Agents
            </Button>
          ) : showsPrimaryAssignButton && primaryAgent && onAssignAgent ? (
            <Button
              aria-label={`Use ${model.name} with ${primaryAgent.name}`}
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
                  ? `Wait for ${primaryAgent.name} to finish the current turn`
                  : undefined
              }
              tone="primary"
            >
              Use with {primaryAgent.name}
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
              aria-label={`${action[0]} ${model.name}`}
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
              {action[0]}
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
        <div
          className="border-t border-border px-4 pt-1 pb-3"
          id={panelId}
          role="region"
          aria-label={`${model.name} details`}
        >
          {model.description ? (
            <p className="pt-2 pb-1 text-sm text-muted-foreground">
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
            onAssignAgent={onAssignAgent}
            view={view}
          />
          {removable || stopped ? (
            <div className="mt-2 border-t border-border/70 pt-2.5">
              {removable ? (
                <Button
                  disabled={disabled}
                  loading={requested === "remove"}
                  onClick={handlers.onRemove}
                  size="compact"
                  tone="danger"
                >
                  Remove from computer
                </Button>
              ) : null}
              {stopped ? (
                <Button
                  disabled={disabled}
                  loading={requested === "cancel"}
                  onClick={handlers.onCancel}
                  size="compact"
                  tone="danger"
                >
                  Discard download
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
