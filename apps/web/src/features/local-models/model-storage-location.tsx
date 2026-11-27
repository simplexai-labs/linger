import {
  Alert02Icon,
  ArrowDown01Icon,
  Copy01Icon,
  Folder01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format-bytes";

import {
  type DesktopModelStorageActionResult,
  type DesktopModelStorageErrorCode,
  desktopModelStorage,
  desktopPlatform,
  openFolderMessage,
  revealFileMessage,
} from "./desktop-model-storage";
import { localModelsMessages as m } from "./local-models.messages";
import type {
  LocalModel,
  LocalModelHost,
  LocalModelStorageFile,
  LocalModelsView,
} from "./local-models-queries";
import { formatGigabytes } from "./local-models-rules";

/** Selects a code element's text so the person can copy it by hand when the clipboard is unavailable. */
export function selectCodeText(element: HTMLElement | null) {
  if (!element) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function storageErrorMessage(code: DesktopModelStorageErrorCode) {
  switch (code) {
    case "NOT_FOUND":
      return m.storageNotFound;
    case "NOT_AVAILABLE":
      return m.storageNotAvailable;
    case "OUTSIDE_ROOT":
      return m.storageOutsideRoot;
    default:
      return m.storageOpenFailed;
  }
}

/**
 * Formats a file path relative to the model's storage directory when possible,
 * otherwise returns its basename. Works identically for POSIX and Windows paths.
 */
export function displayStorageFileName(
  filePath: string,
  modelDir: string,
): string {
  const trimmedFile = filePath.replace(/[\\/]+$/, "");
  const trimmedDir = modelDir.replace(/[\\/]+$/, "");
  const normFile = trimmedFile.replace(/\\/g, "/");
  const normDir = trimmedDir.replace(/\\/g, "/");
  const caseInsensitive =
    /^[a-zA-Z]:\//.test(normFile) || /^[a-zA-Z]:\//.test(normDir);
  const cmpFile = caseInsensitive ? normFile.toLowerCase() : normFile;
  const cmpDir = caseInsensitive ? normDir.toLowerCase() : normDir;
  if (cmpDir.length > 0 && cmpFile.startsWith(`${cmpDir}/`)) {
    return trimmedFile.slice(trimmedDir.length + 1);
  }
  const lastSep = Math.max(
    trimmedFile.lastIndexOf("/"),
    trimmedFile.lastIndexOf("\\"),
  );
  return lastSep >= 0 ? trimmedFile.slice(lastSep + 1) : trimmedFile;
}

function CopyPathButton({
  codeRef,
  path,
}: {
  codeRef?: { readonly current: HTMLElement | null };
  path: string;
}) {
  const t = useT();
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const copied = copiedPath === path;

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
    },
    [],
  );

  function markCopied() {
    window.clearTimeout(timerRef.current);
    setCopiedPath(path);
    timerRef.current = window.setTimeout(() => setCopiedPath(null), 1_500);
  }

  function copy() {
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      void clipboard.writeText(path).then(
        () => markCopied(),
        () => selectCodeText(codeRef?.current ?? null),
      );
      return;
    }
    selectCodeText(codeRef?.current ?? null);
  }

  return (
    <Button
      aria-label={t(copied ? m.storageCopiedPathOf : m.storageCopyPathOf, {
        path,
      })}
      className={copied ? "text-app-success" : undefined}
      onClick={copy}
      size="compactIcon"
      title={t(copied ? commonMessages.copied : m.storageCopyPath)}
      tone="ghost"
    >
      <Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
    </Button>
  );
}

interface StoragePathControlProps {
  readonly actionDisabled?: boolean;
  readonly actionLabel?: string;
  readonly actionTitle?: string;
  readonly inlineHint?: string;
  readonly layout?: "inline" | "stacked";
  readonly onAction?: () => Promise<DesktopModelStorageActionResult>;
  readonly path: string;
}

function StoragePathControl({
  actionDisabled = false,
  actionLabel,
  actionTitle,
  inlineHint,
  layout = "inline",
  onAction,
  path,
}: StoragePathControlProps) {
  const t = useT();
  const codeRef = useRef<HTMLElement>(null);
  const [opening, setOpening] = useState(false);
  const [errorState, setErrorState] = useState<{
    readonly code: DesktopModelStorageErrorCode;
    readonly path: string;
  } | null>(null);
  const actionError = errorState?.path === path ? errorState.code : null;

  async function handleAction() {
    if (!onAction || opening || actionDisabled) return;
    setErrorState(null);
    setOpening(true);
    try {
      const result = await onAction();
      if (!result.ok) {
        setErrorState({ code: result.code, path });
      }
    } catch {
      setErrorState({ code: "OPEN_FAILED", path });
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <div
        className={cn(
          "flex min-w-0 gap-1.5",
          layout === "stacked"
            ? "flex-col items-start"
            : "flex-wrap items-center",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 max-w-full items-center gap-1",
            layout === "stacked" ? "w-full" : "flex-1 basis-52",
          )}
        >
          <code
            className="min-w-0 flex-1 truncate rounded-md bg-muted/75 px-2 py-0.5 font-mono text-xs text-foreground"
            ref={codeRef}
            title={path}
          >
            {path}
          </code>
          <CopyPathButton codeRef={codeRef} path={path} />
        </div>
        {onAction && actionLabel ? (
          <Button
            className="shrink-0"
            disabled={actionDisabled}
            loading={opening}
            onClick={() => void handleAction()}
            size="compact"
            title={actionTitle}
            tone="subtle"
          >
            {opening ? null : <Icon icon={Folder01Icon} size={14} />}
            {actionLabel}
          </Button>
        ) : null}
      </div>
      {inlineHint ? (
        <p className="text-[11px] text-muted-foreground">{inlineHint}</p>
      ) : null}
      {actionError ? (
        <p className="text-xs text-app-danger" role="alert">
          {t(storageErrorMessage(actionError))}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Compact global model storage footer row inside `MemorySummaryCard` (or
 * standalone card when no memory summary is rendered). Shown only to the
 * Computer's owner when `host.models_dir` is present.
 */
export function ModelStorageSummaryRow({
  bordered = true,
  isLocalDesktop = false,
  view,
}: {
  readonly bordered?: boolean;
  readonly isLocalDesktop?: boolean;
  readonly view: LocalModelsView;
}) {
  const t = useT();
  const host = view.computer.host;
  if (!view.viewer_is_owner || !host?.models_dir) return null;

  const storageBridge = isLocalDesktop ? desktopModelStorage() : undefined;
  const platform = isLocalDesktop ? desktopPlatform() : undefined;
  const folderMissing = host.models_dir_exists === false;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3",
        bordered && "border-t border-border/50 bg-muted/20",
      )}
      data-model-storage-summary=""
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Icon className="shrink-0" icon={Folder01Icon} size={14} />
          {t(m.factModelStorage)}
        </span>
        {host.disk_free_bytes != null ? (
          <span className="text-[11px] tabular-nums text-muted-foreground/80">
            ·{" "}
            {t(m.storageDiskFree, {
              free: formatGigabytes(host.disk_free_bytes, t),
            })}
          </span>
        ) : null}
      </div>
      <StoragePathControl
        actionDisabled={folderMissing}
        actionLabel={storageBridge ? t(openFolderMessage(platform)) : undefined}
        actionTitle={
          folderMissing ? t(m.storageCreatedOnFirstDownload) : undefined
        }
        inlineHint={
          folderMissing ? t(m.storageCreatedOnFirstDownload) : undefined
        }
        onAction={storageBridge ? () => storageBridge.openFolder() : undefined}
        path={host.models_dir}
      />
    </div>
  );
}

/**
 * Global model storage fact row inside `AdvancedDialog -> Hardware` beside
 * `Free disk`. Covers offline and no-pool states as well as normal hardware inspection.
 */
export function AdvancedStorageFact({
  host,
  isLocalDesktop = false,
  viewerIsOwner,
}: {
  readonly host: LocalModelHost;
  readonly isLocalDesktop?: boolean;
  readonly viewerIsOwner: boolean;
}) {
  const t = useT();
  if (!viewerIsOwner || !host.models_dir) return null;

  const storageBridge = isLocalDesktop ? desktopModelStorage() : undefined;
  const platform = isLocalDesktop ? desktopPlatform() : undefined;
  const folderMissing = host.models_dir_exists === false;

  return (
    <div
      className="flex flex-col gap-1.5 border-t border-border/70 py-2 text-sm sm:flex-row sm:items-start sm:gap-3"
      data-advanced-model-storage=""
    >
      <span className="w-28 shrink-0 pt-0.5 text-xs font-medium text-muted-foreground">
        {t(m.factModelStorage)}
      </span>
      <StoragePathControl
        actionDisabled={folderMissing}
        actionLabel={storageBridge ? t(openFolderMessage(platform)) : undefined}
        actionTitle={
          folderMissing ? t(m.storageCreatedOnFirstDownload) : undefined
        }
        inlineHint={
          folderMissing ? t(m.storageCreatedOnFirstDownload) : undefined
        }
        layout="stacked"
        onAction={storageBridge ? () => storageBridge.openFolder() : undefined}
        path={host.models_dir}
      />
    </div>
  );
}

function StorageFileRow({
  file,
  isDownloading,
  modelDir,
  onReveal,
  revealLabel,
}: {
  readonly file: LocalModelStorageFile;
  readonly isDownloading: boolean;
  readonly modelDir: string;
  readonly onReveal?: (
    targetPath: string,
  ) => Promise<DesktopModelStorageActionResult>;
  readonly revealLabel?: string;
}) {
  const t = useT();
  const [revealing, setRevealing] = useState(false);
  const [errorCode, setErrorCode] =
    useState<DesktopModelStorageErrorCode | null>(null);
  const label = displayStorageFileName(file.path, modelDir);

  async function reveal() {
    if (!onReveal || revealing || !file.present) return;
    setErrorCode(null);
    setRevealing(true);
    try {
      const result = await onReveal(file.path);
      if (!result.ok) {
        setErrorCode(result.code);
      }
    } catch {
      setErrorCode("OPEN_FAILED");
    } finally {
      setRevealing(false);
    }
  }

  return (
    <li className="py-1.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <code
          className="min-w-0 flex-1 basis-44 truncate font-mono text-xs text-foreground"
          title={file.path}
        >
          {label}
        </code>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {file.role === "mmproj" ? (
            <span className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              {t(m.storageRoleMmproj)}
            </span>
          ) : file.role === "other" ? (
            <span className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              {t(m.storageRoleOther)}
            </span>
          ) : null}
          {file.shared ? (
            <span className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              {t(m.storageSharedBadge)}
            </span>
          ) : null}
          {!file.present && !isDownloading ? (
            <span className="inline-flex h-4 shrink-0 items-center rounded bg-[var(--app-status-warning-surface)] px-1.5 text-[10px] font-medium text-app-warning">
              {t(m.storageFileMissingBadge)}
            </span>
          ) : null}
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {formatBytes(file.size_bytes)}
          </span>
          <CopyPathButton path={file.path} />
          {onReveal && revealLabel ? (
            <Button
              aria-label={`${revealLabel}: ${label}`}
              disabled={!file.present}
              loading={revealing}
              onClick={() => void reveal()}
              size="compactIcon"
              title={revealLabel}
              tone="ghost"
            >
              {revealing ? null : <Icon icon={Folder01Icon} size={14} />}
            </Button>
          ) : null}
        </div>
      </div>
      {errorCode ? (
        <p className="mt-1 text-xs text-app-danger" role="alert">
          {t(storageErrorMessage(errorCode))}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Per-model on-disk file location inside `ModelFacts`. Shown only to the
 * Computer's owner when `model.storage` is present.
 */
export function ModelStorageFact({
  isLocalDesktop = false,
  model,
  viewerIsOwner,
}: {
  readonly isLocalDesktop?: boolean;
  readonly model: LocalModel;
  readonly viewerIsOwner: boolean;
}) {
  const t = useT();
  const filesListId = useId();
  const [filesOpen, setFilesOpen] = useState(false);

  const storage = model.storage;
  if (!viewerIsOwner || !storage) return null;

  const storageBridge = isLocalDesktop ? desktopModelStorage() : undefined;
  const platform = isLocalDesktop ? desktopPlatform() : undefined;
  const revealLabel = storageBridge
    ? t(revealFileMessage(platform))
    : undefined;
  const isDownloading = model.state === "downloading";
  const showMissingWarning = !storage.files_present && !isDownloading;

  async function revealPrimary(): Promise<DesktopModelStorageActionResult> {
    if (!storageBridge || !storage) {
      return { ok: false, code: "NOT_AVAILABLE" };
    }
    const primary = storage.files.find(
      (file) => file.path === storage.primary_path,
    );
    if (primary?.present ?? storage.files_present) {
      return storageBridge.revealPath(storage.primary_path);
    }
    const dirResult = await storageBridge.revealPath(storage.dir);
    if (!dirResult.ok && dirResult.code === "NOT_FOUND") {
      return storageBridge.openFolder();
    }
    return dirResult;
  }

  return (
    <div
      className="space-y-2 border-t border-border/40 pt-3 @xl:col-span-2"
      data-model-storage-fact=""
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t(m.factFileLocation)}
        </span>
        {storage.files.length > 1 ? (
          <button
            aria-controls={filesListId}
            aria-expanded={filesOpen}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setFilesOpen((open) => !open)}
            type="button"
          >
            <span>
              {t(m.storageFilesCount, { count: storage.files.length })}
            </span>
            <Icon
              className={cn(
                "transition-transform duration-150 motion-reduce:transition-none",
                filesOpen && "rotate-180",
              )}
              icon={ArrowDown01Icon}
              size={12}
            />
          </button>
        ) : null}
      </div>

      <StoragePathControl
        actionLabel={revealLabel}
        onAction={storageBridge ? revealPrimary : undefined}
        path={storage.primary_path}
      />

      {showMissingWarning ? (
        <p
          className="flex items-center gap-1.5 text-xs text-app-warning"
          role="status"
        >
          <Icon className="shrink-0" icon={Alert02Icon} size={14} />
          <span>{t(m.storageFilesMissing)}</span>
        </p>
      ) : null}

      {storage.files.length > 1 && filesOpen ? (
        <ul
          className="divide-y divide-border/40 rounded-xl bg-muted/35 px-3 py-1"
          id={filesListId}
        >
          {storage.files.map((file) => (
            <StorageFileRow
              file={file}
              isDownloading={isDownloading}
              key={file.path}
              modelDir={storage.dir}
              onReveal={
                storageBridge
                  ? (targetPath) => storageBridge.revealPath(targetPath)
                  : undefined
              }
              revealLabel={revealLabel}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
