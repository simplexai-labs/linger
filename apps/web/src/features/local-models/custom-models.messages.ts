import { defineMessages } from "@/i18n/messages";

/** Settings › Models › Custom Hub (Hugging Face / ModelScope) and Chat badge copy. */
export const customModelsMessages = defineMessages("customModels", {
  // Segmented sub-tabs inside Local model.
  catalogModeRegion: "Model catalog mode",
  tabCurated: "Official Curated",
  tabCustom: "Custom · HF / ModelScope",
  customTabDescription:
    "Browse or paste a Hugging Face or ModelScope repository to inspect GGUF shards, disk headroom, and memory estimates before downloading.",
  hostHeadroomChip: "{host} · {free} free",

  // Upgrade & availability notices.
  customUnsupportedTitle: "Update Linger to install custom models",
  customUnsupportedBody:
    "This computer is running an older version of Linger that doesn't support custom Hugging Face or ModelScope repositories yet. Update Linger on {computer}, then return here.",
  readOnlyCustomNotice:
    "Only the person who connected {name} can search, probe, or install custom models.",

  // Omnibox & filters.
  hubSourceGroup: "Model hub source",
  hubAll: "All Hubs",
  hubHuggingFace: "Hugging Face",
  hubHuggingFaceShort: "HF",
  hubModelScope: "ModelScope",
  formatAuto: "Auto ({formats})",
  formatGguf: "GGUF",
  formatMlx: "MLX",
  formatGgufOnly: "GGUF only",
  formatGgufAndMlx: "GGUF + MLX",
  omniboxLabel: "Custom model URL or search query",
  omniboxPlaceholder:
    "Paste HF / ModelScope URL, owner/repo, or search community catalog…",
  probeAction: "Probe",
  searchAction: "Search",
  clearInput: "Clear input",

  // Catalog browsing & empty states.
  catalogHeading: "Community Repositories · Click to inspect",
  catalogCount: "{count} shown",
  catalogResultsSummary: {
    one: "{count} compatible repository",
    other: "{count} compatible repositories",
  },
  catalogResultsSummaryQuery: {
    one: '{count} compatible repository for "{query}"',
    other: '{count} compatible repositories for "{query}"',
  },
  zeroDownloadProbe: "Zero-download probe",
  loadingCatalog: "Searching community repositories…",
  loadingProbe: "Inspecting repository metadata…",
  noSearchResultsTitle: 'No compatible models matched "{query}"',
  noSearchResultsEmptyTitle: "No community repositories returned",
  noSearchResultsBody:
    'Try searching "Qwen", "DeepSeek", or paste a direct Hugging Face / ModelScope repository URL.',
  repoNotFound:
    "Repository <repo>{target}</repo> wasn't found. Check the owner/repo spelling or pick a repository from the catalog.",
  emptyInspector:
    "Select a community repository on the left or paste a Hugging Face / ModelScope link to inspect sharded GGUF files, disk headroom, and memory comfort zones.",
  noInstalledCustom:
    "No custom models downloaded yet. Select any repository to inspect preflight checks in the right rail.",
  gatedPill: "Gated",
  incompatiblePill: "Incompatible",
  quantsCount: {
    one: "{count} quant",
    other: "{count} quants",
  },
  pullsCount: "{count} pulls",
  paramsBillions: "{value}B",
  contextKilo: "{value}K ctx",

  // Gated repository token unlock card.
  gatedTitle: "Gated or Private Repository",
  gatedHttpBadge: "HTTP {status}",
  gatedDescription:
    "<repo>{repoId}</repo> requires a read-only {hub} access token before metadata and file sizes can be inspected.",
  tokenLabel: "Read-only access token",
  tokenPlaceholder: "Paste read-only token ({prefix}…)",
  unlockRepo: "Unlock Repo",
  unlockingRepo: "Unlocking…",
  tokenEmptyError: "Enter a read-only access token to unlock metadata.",
  tokenRejectedError:
    "The hub rejected that token (HTTP {status}). Verify read permissions and license acceptance, then try again.",
  tokenZeroDownloadNote:
    "Zero-download probe: token is kept only in memory for this check and is never saved to disk or browser storage.",

  // Incompatible repository card.
  incompatibleMlxTitle: "MLX format isn't supported on this computer",
  incompatibleSafetensorsTitle:
    "Incompatible raw Safetensors / PyTorch weights",
  incompatibleNoFilesTitle: "No runnable model files found",
  installBlockedBadge: "Install Blocked",
  incompatibleMlxBody:
    "<repo>{repoId}</repo> ships Apple MLX weights, which can't run on <host>{host}</host> right now. Use a GGUF build instead.",
  incompatibleSafetensorsBody:
    "<repo>{repoId}</repo> contains raw unquantized <code>.safetensors</code> shards with no runnable GGUF files for Linger's local engine.",
  incompatibleNoFilesBody:
    "<repo>{repoId}</repo> doesn't contain runnable GGUF weight files for Linger's local engine.",
  searchGgufEquivalents: "Search community GGUF equivalents",
  suggestedQueryLabel: 'Query: "{query}"',

  // Preflight & quantization inspector.
  inspectorRegion: "Preflight and Quantization Inspector",
  inspectorTitle: "Preflight & Quant Inspector",
  inspectorHostCap: "{platform} · {memory} max RAM",
  inspectorHostOnly: "{platform}",
  tokenUnlockedBadge: "Token unlocked",
  matchedFileNote: "Matched direct file link: {file}",
  archMeta: "arch {arch}",
  moeMeta: "MoE",
  sweetSpotBadge: "Sweet-spot",
  alreadyInstalledBadge: "Installed",
  shardsMerged: "{count} shards merged",
  downloadSizeLabel: "{size} download",
  bitsPerWeight: "{bits} bits/weight",
  mmprojCompanionNote: "Includes multimodal projector {file} (+{size})",
  selectQuantHeading: "Select quantization ({count})",
  quantOptionMeta: "{size} · ~{memory} RAM",
  preflightHeading: "Preflight Check · {host}",
  standbyIsolatedBadge: "Standby-First isolated",
  diskHeadroomLabel: "Disk space (1.1x headroom)",
  diskFreeRatio: "{required} / {free} free",
  diskHardStop:
    "Hard stop: not enough free disk space for download + <code>.part</code> temp files.",
  switchSmallerQuant: "Switch to {label} ({size} · needs {required})",
  freeDiskNeeded: "Free at least {shortfall} on disk before downloading.",
  memoryEstimateLabel: "Memory / VRAM estimate",
  memoryBasisGguf: "Estimated from GGUF header metadata",
  memoryBasisRough: "Rule of thumb: size × 1.2 + 0.8 GB",
  memoryRatio: "~{estimated} / {max}",
  tierComfortable: "Likely fit (Estimate)",
  tierTight: "Tight headroom (Estimate)",
  tierUnknownMeta: "Unknown / Incomplete Metadata",
  tierExceedsCeiling: "Exceeds host ceiling (Risky)",
  gaugeSafe: "Safe",
  gaugeTight: "Tight (78%)",
  gaugeMax: "Host max ({max})",
  reasonComfortable:
    "Estimated ~{estimated} fits comfortably within {max} usable memory.",
  reasonTight:
    "Estimated ~{estimated} leaves limited headroom ({max} max). May run slower or trigger low-memory mode.",
  reasonExceeds:
    "Estimated ~{estimated} exceeds this host's {max} usable memory ceiling. Loading may fail or swap heavily.",
  reasonUnknownMeta:
    "Incomplete community metadata: runtime compatibility and KV-cache overhead couldn't be verified.",
  tipSmallerMemory: "Tip: switch to {label} (~{memory}) for safer headroom",
  escapeHatchNoticeWithActive:
    "Linger never dead-ends on memory estimates. You can install in <strong>Standby-First</strong> mode and verify safely with a Quick Smoke Test without disrupting <strong>{activeModel}</strong>.",
  escapeHatchNoticeStandalone:
    "Linger never dead-ends on memory estimates. You can install in <strong>Standby-First</strong> mode and verify safely with a Quick Smoke Test before assigning any Agent.",
  installAnywayCta: "Install Anyway — I accept the risk",
  downloadInstallCta: "Download & Install {label} ({size})",
  startingDownloadCta: "Starting download…",
  alreadyInstalledCta: "{label} is already installed",
  insufficientDiskCta: "Insufficient Disk Space ({required} required)",
  standbyFooterNote:
    "Installs in Standby-First mode · never auto-loads on app restart.",

  // Active download & cancel cleanup.
  downloadingTitle: "Downloading {name}",
  verifyingTitle: "Verifying SHA-256 checksum…",
  shardProgress: "Shard {current}/{total}",
  cancelDownload: "Cancel",
  cancellingDownload: "Cancelling…",
  resumableHint: "Resumable · .part temp files auto-cleaned on cancel",
  cancelCleanedNoticeWithSize:
    "Download cancelled · Removed {size} of partial .part temp files.",
  cancelCleanedNotice:
    "Download cancelled · Partial .part temp files were cleaned up.",
  dismissNotice: "Dismiss",

  // Installed custom models & smoke test recovery.
  installedHeading: "Installed Custom Models ({count})",
  activeCuratedProtected: "Active curated model ({name}) stays protected",
  standbyProtectedGeneric: "Standby-First isolated from curated models",
  smokeAttentionHeading: "Smoke Test Attention",
  badgeUntested: "Custom · Untested",
  badgeVerified: "Custom · Verified",
  badgeFailed: "Custom · Failed",
  onDiskSize: "{size} on disk",
  shardsCount: "{count} shards",
  standbyRestartSafe: "Standby-First (safe on restart)",
  activeForAgents: "Active for Agents",
  smokeRunning: "Smoke Test (ctx={ctx})…",
  smokeTestCta: "Quick Smoke Test (ctx=4096)",
  retryLowerCtxCta: "Retry at ctx=2048",
  redownloadCta: "Re-download Clean Copy",
  useForAgents: "Use for Agents",
  returnToStandby: "Return to Standby",
  loadingModel: "Loading…",
  unloadingModel: "Unloading…",
  removingModel: "Removing…",
  deleteButton: "Delete",
  deleteModelLabel: "Delete {name} and free space",
  deleteAndFree: "Delete & Free {size}",
  showDiagnosticLog: "View diagnostic log",
  collapseDiagnosticLog: "Collapse diagnostic log",
  safetyNetIntactWithActive:
    "Safety net intact: {activeModel} remains active and uninterrupted.",
  safetyNetIntactStandalone:
    "Safety net intact: custom smoke test ran in isolation with zero impact on your Agents.",
  smokeOomHeadline: "Out of memory during ctx={ctx} smoke load",
  smokeOomDetail:
    "Allocating weights and KV cache exceeded available memory. Lowering context to 2048 reduces KV cache memory.",
  smokeUnsupportedArchHeadline:
    "Unsupported model architecture in bundled engine",
  smokeUnsupportedArchDetail:
    "This community build uses an architecture not yet supported by Linger's bundled local engine.",
  smokeCorruptHeadline: "Corrupt or incomplete weight data",
  smokeCorruptDetail:
    "Weight verification failed. Re-downloading replaces the damaged files without affecting other models.",
  smokeUnknownHeadline: "Unexpected runtime load error",
  smokeUnknownDetail:
    "The local runtime exited before reporting ready. Inspect the diagnostic log or delete this custom model to reclaim disk space.",
  failureKindOom: "OOM",
  failureKindUnsupportedArch: "Unsupported arch",
  failureKindCorrupt: "Corrupt",
  failureKindUnknown: "Load error",

  // Chat / Agent model selector badge.
  customModelBadge: "Custom",
});
