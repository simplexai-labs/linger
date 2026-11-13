import { AiChipIcon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useId, type MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

import { formatBytes } from "@/lib/format-bytes";

import { ModelFacts } from "./local-model-details";
import { unavailableShortCopy } from "./local-models-copy";
import type { LocalModelsView } from "./local-models-queries";
import {
  downloadPercent,
  placeName,
  type ModelEntry,
  type ModelStatus,
} from "./local-models-rules";

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

interface Handlers {
  onCancel: () => void;
  onDownload: () => void;
  onLoad: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onUnload: () => void;
}

function stopRowClick(event: MouseEvent) {
  event.stopPropagation();
}

/**
 * One catalog model on one Computer: a full-width Connectors-style card whose
 * header carries the status and one action, and which expands to the details.
 */
export function ModelRow({
  disabled,
  entry,
  expanded,
  view,
  ...handlers
}: Handlers & {
  /** Actions are off: the Computer is offline, the viewer only reads, or one is pending. */
  disabled: boolean;
  entry: ModelEntry;
  expanded: boolean;
  view: LocalModelsView;
}) {
  const panelId = useId();
  const { model, status } = entry;
  const where = placeName(view, model.pool);
  const tag = statusTags[status];
  const progress = downloadPercent(model);
  const download = formatBytes(model.download_bytes);
  const detail = {
    available: model.recommended
      ? `${download} · Recommended`
      : model.fit === "system"
        ? `${download} · runs slower`
        : download,
    downloading:
      model.download?.step === "verify" ? "checking file" : `${progress}%`,
    failed: null,
    idle: model.note ? "no room to load yet" : null,
    loaded: [
      where ? `${where[0]!.toUpperCase()}${where.slice(1)}` : undefined,
      formatBytes(model.memory_bytes),
    ]
      .filter(Boolean)
      .join(" · "),
    loading: where ?? null,
    unavailable: unavailableShortCopy(model.availability.reason),
  }[status];

  const action = (
    {
      available: ["Download", handlers.onDownload],
      downloading: ["Cancel", handlers.onCancel],
      failed: ["Retry", handlers.onLoad],
      idle: ["Load", handlers.onLoad],
      loaded: ["Unload", handlers.onUnload],
      loading: null,
      unavailable: null,
    } as const
  )[status];
  const removable =
    status === "loaded" || status === "idle" || status === "failed";

  return (
    <article
      className={cn(
        "rounded-xl border bg-card transition-colors duration-150 motion-reduce:transition-none",
        expanded ? "border-border-hover" : "border-border hover:bg-accent/40",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          aria-controls={panelId}
          aria-expanded={expanded}
          aria-label={model.name}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            status === "unavailable" && "opacity-60",
          )}
          onClick={handlers.onToggle}
          type="button"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-card text-foreground shadow-outline">
            <Icon icon={AiChipIcon} size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {model.name}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {tag.dot ? (
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", tag.dot)}
                />
              ) : null}
              <span
                className={cn("truncate", tag.working && "town-shimmer-text")}
              >
                <span className={tag.dot ? "text-foreground" : undefined}>
                  {tag.label}
                </span>
                {detail ? ` · ${detail}` : null}
              </span>
            </span>
          </span>
        </button>
        {action ? (
          <Button
            aria-label={`${action[0]} ${model.name}`}
            className="px-2.5"
            disabled={disabled}
            onClick={(event) => {
              stopRowClick(event);
              action[1]();
            }}
            size="compact"
            tone={status === "downloading" ? "ghost" : "secondary"}
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
      {status === "downloading" ? (
        <div className="px-4 pb-3">
          <span
            aria-label={`${model.name} download progress`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress}
            className="block h-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <span
              className="block h-full origin-left rounded-full bg-primary transition-transform duration-200 motion-reduce:transition-none"
              style={{ transform: `scaleX(${progress / 100})` }}
            />
          </span>
        </div>
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
          <ModelFacts entry={entry} view={view} />
          {removable ? (
            <Button
              className="mt-2"
              disabled={disabled}
              onClick={handlers.onRemove}
              size="compact"
              tone="danger"
            >
              Remove from computer
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
