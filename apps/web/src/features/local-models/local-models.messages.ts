import { defineMessages } from "@/i18n/messages";

/** Settings › Models: a Computer's model source and its local model library. */
export const localModelsMessages = defineMessages("localModels", {
  // The page and its header.
  title: "Models",
  noComputersTitle: "No computers yet",
  noComputersBody:
    "Connect a computer in <link>Computers</link> to download and run models on it.",
  thisComputer: "this computer",
  computerPicker: "Computer",
  computerOffline: "{name} · Offline",
  computerSearchLabel: "Search computers",
  computerSearchPlaceholder: "Search computers…",
  computerSearchClear: "Clear computer search",
  computerStatusFilter: "Filter computers by status",
  computerFilterAll: "All",
  computerFilterOnline: "Online",
  computerFilterOffline: "Offline",
  computerGroupOnline: "Online",
  computerGroupOffline: "Offline",
  computerStatusOffline: "Offline",
  computerEmptyQuery: 'No computers match "{query}".',
  computerEmptyOnline: "No online computers.",
  computerEmptyOffline: "No offline computers.",
  computerClearFilters: "Clear filters",
  agentsUse: "Agents on {computer} use {source}",
  memoryInUse: "{used} of {total} memory in use",
  gpuMemoryInUse: "{used} of {total} GPU memory in use",
  memoryFree: "{free} free",
  memoryFreeChecked: "{free} free · Checked {time}",
  recheckMemory: "Recheck memory",
  details: "Details",
  retrying: "Retrying…",
  switchingComputer:
    "Switching {computer}. This can take a few minutes the first time.",
  offlineByok:
    "<strong>{name} is offline.</strong> Reconnect it in <link>Computers</link> to test or change its model source.",
  offlineByokLastSeen:
    "<strong>{name} is offline (last seen {time}).</strong> Reconnect it in <link>Computers</link> to test or change its model source.",
  offlineLibrary:
    "<strong>{name} is offline.</strong> This is what it last reported. Reconnect it in <link>Computers</link> to manage its models.",
  offlineLibraryLastSeen:
    "<strong>{name} is offline (last seen {time}).</strong> This is what it last reported. Reconnect it in <link>Computers</link> to manage its models.",
  offlineReadOnly:
    "<strong>{name} is offline.</strong> This is what it last reported.",
  offlineReadOnlyLastSeen:
    "<strong>{name} is offline (last seen {time}).</strong> This is what it last reported.",
  readOnlyNotice:
    "Only the person who connected {name} can download, load or remove its models.",
  openComputer: "Open {name}",
  openMyComputers: "Open my computers",
  loadFailedTitle: "Couldn't load the models of {name}",
  loadFailedTitleThisComputer: "Couldn't load the models of this computer",
  loadingModels: "Loading models",
  modelFailure: "{name}: {reason}",
  assignFailed: "Couldn't switch the Agent to this model. Try again.",
  assignBusy:
    "Couldn't switch {agents} to {model} while working. Switch once the current turn finishes.",
  assignFailedNamed: "Couldn't switch {agents} to {model}. Try again.",
  willSwitch: "Will switch {agents} to {model} once it finishes loading.",
  memoryGuidance: "Memory guidance",
  noModelsTitle: "No local models available",
  noModelsBody: "{name} didn't list any models for this hardware yet.",
  /** Joins two full sentences shown as one notice. */
  sentences: "{first} {second}",
  /** Between the names of a list, such as the Agents that use a model. */
  listSeparator: ", ",

  // Sizes, counts and progress.
  gigabytes: "{value} GB",
  poolSystem: "System memory",
  poolUnified: "Unified memory",
  gpuIndex: "GPU {index}",
  gpuIndexNamed: "GPU {index} · {name}",
  placeSystem: "system memory",
  placeMemory: "memory",
  placeMemoryTitle: "Memory",
  contextTokens: "{tokens} tokens",
  contextKiloTokens: "{thousands}K tokens",
  contextCompact: "{thousands}K",
  agentCount: { one: "{count} Agent", other: "{count} Agents" },
  activeParameters: "{parameters} active",
  parametersWithArchitecture: "{scale} ({architecture})",
  secondsLeft: "{seconds}s left",
  minutesLeft: "{minutes}m left",
  hoursMinutesLeft: "{hours}h {minutes}m left",
  hoursLeft: "{hours}h left",
  checkingFile: "checking file",
  percent: "{percent}%",
  perSecond: "{size}/s",
  tokensPerSecond: "{speed} tokens/s",
  promptTokensPerSecond: "{speed} prompt tokens/s",

  // A model row.
  statusAvailable: "Not downloaded",
  statusDownloading: "Downloading",
  statusFailed: "Couldn't load",
  statusIdle: "Downloaded",
  statusLoaded: "Loaded",
  statusLoading: "Loading",
  statusProbingConcurrency: "Probing max concurrency",
  statusUnavailable: "Can't download",
  statusDownloadStopped: "Download stopped",
  endingCancel: "Cancelling",
  endingRemove: "Removing",
  endingUnload: "Unloading",
  endingDiscard: "Discarding",
  openChat: "Open chat",
  featured: "Featured",
  featuredNew: "New",
  featuredSpotlightRegion: "Featured model: Inkling 2 Mini",
  featuredByThinkingMachines: "Featured · Thinking Machines",
  featuredInklingSummary:
    "26.4B looped MoE (3.4B active) built for local agentic coding and vision — Apache 2.0.",
  featuredReadAnnouncement: "Read announcement",
  featuredHuggingFace: "Hugging Face",
  featuredNotInCatalog:
    "Not in this computer's local model catalog yet. Update Linger's local models runtime if you're on an older version.",
  recommended: "Recommended",
  runsSlower: "runs slower",
  availableDetailWithMemory: "{download} · {memory} memory",
  availableDetailWithVram: "{download} · {vram} VRAM",
  availableDetailWithVramAndRam: "{download} · {vram} VRAM + {ram} RAM",
  loadedMemoryHybrid: "{vram} VRAM + {ram} RAM",
  sectionOnComputer: "On this computer",
  sectionAvailable: "Available to download",
  sectionNeedsMoreMemory: {
    one: "{count} model needs more memory",
    other: "{count} models need more memory",
  },
  sectionUnavailable: {
    one: "{count} model unavailable on this computer",
    other: "{count} models unavailable on this computer",
  },
  chooseVersion: "Choose version for {name}",
  variantLabelWithEngine: "{quant} · {engine}",
  variantOptionDetail: "{label} · {detail}",
  noRoomYet: "no room to load yet",
  loadToAnswer: "load to answer",
  usedByNames: "Used by {names}",
  actionDownload: "Download",
  actionResumeDownload: "Resume download",
  actionLoad: "Load",
  actionUnload: "Unload",
  downloadModel: "Download {name}",
  cancelModel: "Cancel {name}",
  resumeDownloadModel: "Resume download {name}",
  removeModel: "Remove {name}",
  retryModel: "Retry {name}",
  loadModel: "Load {name}",
  unloadModel: "Unload {name}",
  useForAgentsNamed: "Use {name} for Agents",
  useForAgents: "Use for Agents",
  useWithNamed: "Use {model} with {agent}",
  useWith: "Use with {agent}",
  waitForTurn: "Wait for {agent} to finish the current turn",
  downloadProgress: "{name} download progress",
  detailsOf: "{name} details",
  removeFromComputer: "Remove from computer",
  discardDownload: "Discard download",

  // The details of a model and of a Computer.
  copyEndpointOf: "Copy {name} endpoint",
  copiedEndpointOf: "Copied {name} endpoint",
  copyEndpoint: "Copy endpoint",
  gatewayPiNotInstalled: "Bifrost · Pi not installed",
  gatewayReady: "Ready · Bifrost (Pi)",
  gatewayRegistering: "Bifrost · Registering with Pi…",
  gatewaySettingUp: "Bifrost · Setting up Pi…",
  gatewayPiUnavailable: "Bifrost · Pi unavailable",
  factLastDownload: "Last download",
  factLastLoad: "Last load",
  factWhyNot: "Why not",
  factNote: "Note",
  factCapabilities: "Capabilities",
  factPublisher: "Publisher",
  factParameters: "Parameters",
  factEngine: "Engine",
  factConcurrency: "Concurrency",
  factMemory: "Memory",
  factSystemMemory: "System memory",
  factOnDisk: "On disk",
  factDownload: "Download",
  factContext: "Context",
  factVersion: "Version",
  factSpeed: "Speed",
  factLicense: "License",
  factUsedBy: "Used by",
  factSource: "Source",
  factGateway: "Gateway",
  factEndpoint: "Endpoint",
  factFreeDisk: "Free disk",
  memoryOn: "{size} on {place}",
  idleUsedWarning: {
    one: "{names} uses this model. Load it so it can answer.",
    other: "{names} use this model. Load it so they can answer.",
  },
  downloadNeedsRoom:
    "This model can download now, but only {free} is free on {pool}. Close memory-heavy apps and recheck memory before loading it.",
  noAgentYet: "No Agent yet",
  switchAgentTo: "Switch an Agent to {name}",
  switchingAgent: "Switching…",
  switchAgent: "Switch Agent…",
  agentWorking: "{name} · Working",
  finishTurnToSwitch: "Finish the current turn to switch",
  poolInUse: "{pool}: {used} of {total} in use",
  otherApps: "Other apps",
  otherAppsSize: "Other apps · {size}",
  systemAndEngine: "System & engine",
  systemAndEngineSize: "System & engine · {size}",
  hardware: "Hardware",

  // Confirmations.
  affectedUnload: {
    one: "{names} uses this model and can't answer until it is loaded again.",
    other: "{names} use this model and can't answer until it is loaded again.",
  },
  affectedRemove: {
    one: "{names} uses this model and can't answer until you choose another model for it.",
    other:
      "{names} use this model and can't answer until you choose another model for them.",
  },
  noAgentUses: "No Agent uses this model.",
  makeRoomTitle: "Make room to load",
  makeRoomDescription: "{name} needs {need} on {pool}; {free} is free.",
  unloadAndLoad: "Unload and load",
  roomFreeNow:
    "Enough memory is free now ({free} available). Click Load to start.",
  unloadTheseLegend: "Unload these to free memory:",
  notUsed: "Not used",
  tooBig:
    "{name} needs more than all {total} of {pool}, so it can't load there.",
  alsoUsingMemory: "Also using this memory",
  closeOtherAppsRecheck:
    "Close other apps that use {place}, then click Recheck memory.",
  closeOtherAppsRetry: "Close other apps that use {place}, then try again.",
  otherAppsCloseRecheck:
    "Other apps are using {size}. Close other apps that use {place}, then click Recheck memory.",
  otherAppsCloseRetry:
    "Other apps are using {size}. Close other apps that use {place}, then try again.",
  unloadNotEnough:
    "Unloading models here doesn't free enough. Choose a smaller model.",
  otherAppsOnPool:
    "Other apps are using {size} on {pool}. Close unnecessary apps and click Recheck memory to free the remaining room.",
  selectMore: "Select at least {size} more to unload before loading {name}.",
  affectedUntilReload:
    "{names} can't answer until their model is loaded again.",
  switchOnceLoaded: "Switch {agents} to {model} once loaded",
  unloadTitle: "Unload {name}?",
  unloadDescription:
    "Frees {size} of memory. It stays on disk, so you can load it again later.",
  unloadDescriptionPool:
    "Frees {size} of {pool}. It stays on disk, so you can load it again later.",
  removeTitle: "Remove {name}?",
  removeDescription:
    "Deletes its files and frees {size} of disk on {computer}. You can download it again later.",
  removeDescriptionLoaded:
    "Unloads it, deletes its files and frees {size} of disk on {computer}. You can download it again later.",

  // Where the Agents of a Computer get their model.
  modeByok: "BYOK",
  modeLocal: "Local model",
  modeSubscription: "Subscription",
  sourceByok: "BYOK · {model}",
  sourceSubscription: "Subscription · {runtime}",
  byokExplanation:
    "Bring your own key: use your own OpenAI-compatible or Anthropic API endpoint. A gateway on this computer serves it to your Agents.",
  switched: "Switched.",
  agentsNowUse: "Agents now use {source}.",
  agentsMoved: {
    one: "{count} Agent was moved.",
    other: "{count} Agents were moved.",
  },
  tasksEnded: {
    one: "{count} task was ended.",
    other: "{count} tasks were ended.",
  },
  terminateTitle: "End running tasks?",
  terminateDescription: {
    one: "{names} is working on tasks on {computer}. Switching now ends those tasks; they can't be resumed.",
    other:
      "{names} are working on tasks on {computer}. Switching now ends those tasks; they can't be resumed.",
  },
  terminateDescriptionSome:
    "Some Agents are working on tasks on {computer}. Switching now ends those tasks; they can't be resumed.",
  terminateBody: "To keep them, wait until they finish and switch then.",
  terminateConfirm: "Terminate tasks & Switch",
  modelSource: "Model source",
  inUse: "In use",
  switchLocalSingle:
    "<model>{name}</model> is on this computer and can run your Agents locally.",
  switchLocalChoose:
    "Choose a model on this computer to run your Agents locally.",
  switchLocalDownload: "Download a model below to run your Agents locally.",
  localOptionLoaded: "{name} · Loaded · {size}",
  localOptionDownloaded: "{name} · Downloaded · {size}",
  switchToLocal: "Switch to Local model",
  aiRuntime: "AI runtime",
  byokApiAddress: "API address",
  baseUrl: "Base URL",
  byokPath: "Path",
  byokEndpoint: "Endpoint",
  byokPathHeading: "Path · optional",
  byokEndpointHeading: "Endpoint · optional",
  byokShowSuggestions: "Show {label} suggestions",
  byokSuggestions: "{label} suggestions",
  byokDefaultOption: "{label} · Default",
  byokPathMostProviders: "Most providers",
  byokPathZhipu: "Zhipu GLM (base {url})",
  byokPathVolcano: "Volcano Engine Ark",
  byokPathNone: "No path. The base URL already has it.",
  byokEndpointRuntimeDefault: "{protocol} · {runtime} default",
  byokEndpointNone: "No endpoint. The base URL is the full address.",
  byokAddressHint:
    "Base URL from your provider's docs. Path and endpoint are optional: pick one, type your own, or clear it.",
  byokAddressInvalid:
    "Path and endpoint take segments like /v1, without spaces, ?, # or \\.",
  byokSendsTo: "Sends {protocol} requests to <url>{url}</url>",
  byokSendsToRuntimeFormat:
    "Sends {protocol} (the {runtime} format) requests to <url>{url}</url>",
  keySavedHint: "A key is saved on this computer. Leave blank to keep it.",
  keyOptionalHint:
    "Optional for an endpoint on this computer or your local network.",
  apiKey: "API key",
  model: "Model",
  listModels: "List models",
  byokListingFrom: "Listing models from {url}…",
  byokModelsListedFrom: {
    one: "{count} model listed from {url}.",
    other: "{count} models listed from {url}.",
  },
  byokModelHint: "List the endpoint's models, or type an ID.",
  byokContextTokens: "{tokens}-token context",
  byokContextKilo: "{thousands}K context",
  byokTest: "Test",
  byokConnected: "Connected",
  byokCouldNotConnect: "Couldn't connect",
  byokDismiss: "Dismiss",
  saveAndSwitch: "Save & Switch to BYOK",

  // Why an action on a model or a read of the page failed.
  refusalOffline:
    "The computer is offline. Reconnect it in Computers, then try again.",
  refusalActionFailed: "The computer couldn't start this. Try again.",
  refusalUnconfirmed:
    "The computer didn't confirm in time. Its models below show what it's doing.",
  refusalForbidden:
    "Only the person who connected this computer can manage its models.",
  refusalDiskInsufficient:
    "There isn't enough free disk on the computer for this model.",
  refusalInvalidState:
    "The model changed on the computer. Check its status and try again.",
  refusalJobRunning:
    "The computer is still working on this model. Wait for it to finish.",
  refusalMemoryInsufficient:
    "The computer doesn't have enough memory for this model.",
  refusalNoRoom:
    "There isn't enough free memory to load it. Close memory-heavy apps or unload another model, then recheck memory.",
  refusalPlatformUnsupported: "This model doesn't run on this computer.",
  refusalGpuUnsupported:
    "This computer doesn't have a supported GPU for local models.",
  refusalDriverUpdateRequired:
    "Update the NVIDIA driver on this computer before downloading or loading local models.",
  refusalRuntimeDependencyMissing:
    "This computer is missing a system runtime library required for local models.",
  refusalModelUnknown: "The computer doesn't have this model anymore.",
  refusalServiceUnavailable:
    "Linger couldn't reach the computer right now. Try again.",
  refusalToolsUnavailable:
    "The local model tools on this computer aren't working.",
  refusalComputerNotFound:
    "This computer wasn't found. It may have been removed.",
  somethingWentWrong: "Something went wrong. Try again.",

  // Why the last load or download of a model failed.
  errorCancelled: "Loading was stopped.",
  errorChecksumMismatch:
    "The downloaded files were damaged. Remove the model and download it again.",
  errorDiskInsufficient: "There wasn't enough free disk.",
  errorDownloadFailed: "The download didn't finish.",
  errorDriverUpdateRequired:
    "The NVIDIA driver on this computer is too old for the local model engine. Update the driver, then try again.",
  errorEngineStartFailed: "The model engine didn't start.",
  errorGatewayRegistrationFailed:
    "It loaded, but Agents couldn't be given access to it.",
  errorGpuUnsupported:
    "This computer doesn't have a supported GPU for local models.",
  errorHealthCheckFailed: "The model started but didn't answer.",
  errorInvalidState: "The model was busy with another step.",
  errorJobRunning: "Another step was still running.",
  errorLoadNoRoom: "There wasn't enough free memory to load it.",
  errorMemoryInsufficient: "The computer doesn't have enough memory for it.",
  errorModelFilesMissing:
    "Its files are missing. Remove the model and download it again.",
  errorModelUnknown: "The computer doesn't know this model anymore.",
  errorNetworkUnavailable: "The computer couldn't reach the network.",
  errorOutOfMemory: "It ran out of memory while loading.",
  errorRuntimeDependencyMissing:
    "A required system runtime library is missing on this computer.",
  errorUnknownError: "Something went wrong on this computer. Try again.",
  errorGatewayHomeNotPrivate:
    "It loaded, but Agents couldn't be given access to it: a Linger folder on the computer belongs to another account.",
  errorGatewayHomeNotPrivatePath:
    "It loaded, but Agents couldn't be given access to it: the folder {path} belongs to another account. Quit Linger, rename that folder, then open Linger and load the model again.",
  shortCancelled: "loading stopped",
  shortChecksumMismatch: "files damaged",
  shortDiskInsufficient: "not enough disk",
  shortDriverUpdateRequired: "driver update needed",
  shortEngineStartFailed: "engine didn't start",
  shortGatewayRegistrationFailed: "Agents couldn't reach it",
  shortGpuUnsupported: "GPU not supported",
  shortHealthCheckFailed: "model didn't answer",
  shortBusy: "busy with another step",
  shortLoadNoRoom: "not enough free memory",
  shortMemoryInsufficient: "not enough memory",
  shortModelFilesMissing: "files missing",
  shortModelUnknown: "no longer on computer",
  shortNetworkUnavailable: "network unavailable",
  shortOutOfMemory: "ran out of memory",
  shortNotForComputer: "not for this computer",
  shortRuntimeDependencyMissing: "missing runtime library",
  shortUnknownError: "unexpected error",
  noteNoRoomToLoad:
    "It downloaded, but there wasn't enough free {place} to load it. Load it when there is room.",

  // Why a model can't be downloaded to this Computer.
  shortNeedsDisk: "needs more disk",
  shortNeedsMemory: "needs more memory",
  shortNeedsDiskSize: "needs {need} of disk",
  shortNeedsSize: "needs {need}",
  shortNeedsVram: "needs more VRAM",
  shortNeedsVramSize: "needs {need} VRAM",
  shortNeedsSystemMemory: "needs more system memory",
  shortNeedsSystemMemorySize: "needs {need} RAM",
  shortUnavailable: "unavailable",
  unavailableMemory: "This computer doesn't have enough memory for it.",
  unavailableMemoryReclaimable:
    "This computer doesn't have enough memory for it. Close memory-heavy apps and recheck memory.",
  unavailableMemorySizes:
    "Needs {need} of memory; this computer has {have} for models.",
  unavailableMemorySizesReclaimable:
    "Needs {need} of memory; this computer has {have} for models. Close memory-heavy apps and recheck memory.",
  unavailableVram:
    "This computer doesn't have enough GPU memory (VRAM) for it.",
  unavailableVramReclaimable:
    "This computer doesn't have enough GPU memory (VRAM) for it. Close memory-heavy apps and recheck memory.",
  unavailableVramSizes:
    "Needs {need} of GPU memory (VRAM); this computer has {have} available.",
  unavailableVramSizesReclaimable:
    "Needs {need} of GPU memory (VRAM); this computer has {have} available. Close memory-heavy apps and recheck memory.",
  unavailableSystemMemory:
    "This computer doesn't have enough system memory (RAM) for it.",
  unavailableSystemMemoryReclaimable:
    "This computer doesn't have enough system memory (RAM) for it. Close memory-heavy apps and recheck memory.",
  unavailableSystemMemorySizes:
    "Needs {need} of system memory (RAM); this computer has {have} available.",
  unavailableSystemMemorySizesReclaimable:
    "Needs {need} of system memory (RAM); this computer has {have} available. Close memory-heavy apps and recheck memory.",
  unavailableDisk: "There isn't enough free disk for it.",
  unavailableDiskSizes: "Needs {need} of disk; {have} is free.",
  unavailableGpuAmd:
    "AMD GPUs aren't supported for local models yet. Local models require an NVIDIA GPU or Apple Silicon Mac; use BYOK on this computer instead.",
  unavailableGpuIntel:
    "Intel GPUs aren't supported for local models yet. Local models require an NVIDIA GPU or Apple Silicon Mac; use BYOK on this computer instead.",
  unavailableGpuNone:
    "No supported GPU was detected on this computer. Local models require an NVIDIA GPU or Apple Silicon Mac; use BYOK instead.",
  unavailableDriverUpdateVersions:
    "Update your NVIDIA driver: the current driver supports CUDA {detected}, but local models require CUDA {required} or newer.",
  unavailableDriverUpdateVersionsDriver:
    "Update your NVIDIA driver to {driver}+ (CUDA {required}). The current driver supports CUDA {detected} — only the graphics driver needs an update, not CUDA Toolkit.",
  unavailableDriverEngineVersionsDriver:
    "{engine} requires NVIDIA driver {driver}+ (CUDA {required}). Your driver supports CUDA {detected} — only the graphics driver needs an update, not CUDA Toolkit.",
  unavailableDriverEngineVersions:
    "{engine} requires an NVIDIA driver supporting CUDA {required} or newer. Your current driver supports CUDA {detected}.",
  unavailableDriverEngineRequiredDriver:
    "{engine} requires NVIDIA driver {driver}+ (CUDA {required}). Only the graphics driver needs an update, not CUDA Toolkit.",
  unavailableDriverEngineRequiredOnly:
    "{engine} requires an NVIDIA driver supporting CUDA {required} or newer.",
  unavailableDriverUpdateRequiredOnly:
    "Update your NVIDIA driver: local models require CUDA {required} or newer.",
  unavailableDriverUpdateUnknown:
    "Update your NVIDIA driver to run local models on this computer.",
  updateDriver: "Update driver",
  updateDriverAction: "Update driver…",
  updateDriverNamed: "Update NVIDIA driver for {name}",
  driverGuide: "Upgrade guide",
  driverCheckAgain: "Check again",
  driverOtherModelsReady:
    "Other models on this computer already work without updating your driver.",
  driverDialogTitle: "Update NVIDIA driver",
  driverDialogDescriptionForModel:
    "Update the graphics driver on {computer} to unlock {model}.",
  driverDialogDescriptionHost:
    "Update the graphics driver on {computer} to run local models.",
  driverDialogGpuLabel: "Graphics card",
  driverDialogCurrentLabel: "Current",
  driverDialogRequiredLabel: "Required",
  driverDialogCurrentDriverCuda: "Driver {driver} · CUDA {cuda}",
  driverDialogCurrentCudaOnly: "CUDA {cuda}",
  driverDialogCurrentUnknown: "Not detected",
  driverDialogRequiredDriverCuda: "Driver {driver}+ · CUDA {cuda}",
  driverDialogRequiredCudaOnly: "CUDA {cuda}+",
  driverDialogRequiredLatest: "Latest NVIDIA driver",
  driverDialogNoToolkitNote:
    "Only the NVIDIA graphics driver needs an update — CUDA Toolkit is not required.",
  driverDialogInstallUpdate: "Install driver update",
  driverDialogDirectInstallHint:
    "Downloads the official NVIDIA DCH WHQL installer, verifies NVIDIA's digital signature, and installs silently without forcing a restart. Windows will ask for administrator permission.",
  driverDialogDownloading: "Downloading NVIDIA driver {version}…",
  driverDialogDownloadingProgress:
    "Downloading NVIDIA driver {version}… {done} / {total} ({percent}%)",
  driverDialogVerifying: "Verifying NVIDIA digital signature for {version}…",
  driverDialogInstalling:
    "Installing NVIDIA driver {version}… Your screen may blink briefly.",
  driverDialogRebootRequired:
    "NVIDIA driver {version} installed. Restart Windows to finish — when you reopen Linger, your GPU will be rechecked automatically.",
  driverDialogInstallComplete:
    "NVIDIA driver {version} installed. Rechecking your GPU now…",
  driverDialogErrorUnsupportedGpu:
    "Automatic install supports GeForce RTX cards. Use NVIDIA App or Download from NVIDIA below.",
  driverDialogErrorLookupFailed:
    "Couldn't reach NVIDIA's driver lookup right now. Try again or use Download from NVIDIA.",
  driverDialogErrorVersionTooOld:
    "NVIDIA hasn't published a compatible automatic package for this CUDA requirement yet. Use Download from NVIDIA.",
  driverDialogErrorDownloadFailed:
    "The driver download was interrupted. Try again or use Download from NVIDIA.",
  driverDialogErrorSignatureInvalid:
    "The downloaded file failed NVIDIA digital signature verification and was deleted for safety. Use Download from NVIDIA.",
  driverDialogErrorUacCancelled:
    "Administrator permission was cancelled. Try again or update through NVIDIA App.",
  driverDialogErrorInstallFailed:
    "The NVIDIA installer didn't finish. Try again, or use NVIDIA App or Download from NVIDIA.",
  driverResumeBannerRegion: "NVIDIA driver update status",
  driverResumeRebootTitle: "Restart Windows to finish the NVIDIA driver update",
  driverResumeRebootBody:
    "NVIDIA driver {version} is installed. Restart Windows, then reopen Linger to unlock local models.",
  driverResumeReadyTitle: "NVIDIA driver {version} is ready",
  driverResumeReadyBody:
    "Your local models have been rechecked with the updated driver.",
  driverResumeReadyModelBody:
    "Your local models have been rechecked — {model} is ready to download.",
  driverResumeDownloadModel: "Download {model}",
  driverResumeDismiss: "Dismiss",
  driverDialogOpenNvidiaApp: "Open NVIDIA App",
  driverDialogOpenGfe: "Open GeForce Experience",
  driverDialogNvidiaAppSteps:
    "In {app}, open Drivers, download the latest driver, and choose Express Installation. Linger checks again when you return.",
  driverDialogDownloadOfficial: "Download from NVIDIA",
  driverDialogWindowsManualHint:
    "Choose your GPU on NVIDIA's download page, install the latest Game Ready or Studio driver, then return here.",
  driverDialogWindowsRestartNote:
    "Your screen may blink briefly during installation, and Windows may ask to restart.",
  driverDialogCopyGpu: "Copy GPU name",
  driverDialogLinuxHint:
    "Run this command in a terminal on {computer}, restart, then click Check again.",
  driverDialogLinuxUbuntuTab: "Ubuntu / Debian",
  driverDialogLinuxFedoraTab: "Fedora",
  driverDialogCopyCommand: "Copy command",
  driverDialogVerifyHint:
    "After restarting, confirm the CUDA version at the top right of",
  driverDialogReadGuide: "Read step-by-step guide",
  driverDialogReadyBanner:
    "Your NVIDIA driver now meets the requirement. You can download this model now.",
  driverDialogLaunchFailed:
    "Couldn't launch {app} automatically. Use Download from NVIDIA instead.",
  driverDialogCopyFailed: "Couldn't copy to clipboard.",
  unavailableMissingLibraries:
    "Install the missing system library ({libraries}) on this computer, then click Recheck memory.",
  unavailableGlibcVersions:
    "This system's glibc ({detected}) is older than the {required} required by the local model engine.",
  unavailableRuntimeDependency:
    "This computer is missing a system runtime library required by the local model engine.",
  unavailableGeneric: "This model isn't available on this computer right now.",

  // Host-level blockers and debug mode notices.
  hostBlockerRegion: "Local model requirements",
  hostBlockerGpuTitle: "Local models need an NVIDIA GPU or Apple Silicon Mac",
  hostBlockerGpuAmdBody:
    "This computer has an AMD GPU, which isn't supported for local models yet. Switch to BYOK to connect your own API endpoint instead.",
  hostBlockerGpuIntelBody:
    "This computer has an Intel GPU, which isn't supported for local models yet. Switch to BYOK to connect your own API endpoint instead.",
  hostBlockerGpuNoneBody:
    "No supported GPU was found on this computer. Switch to BYOK to connect your own API endpoint instead.",
  switchToByok: "Switch to BYOK",
  hostBlockerDriverTitle: "Update the NVIDIA driver to use local models",
  hostBlockerDriverBody:
    "The installed driver supports CUDA {detected}, while the local model engine requires CUDA {required} or newer. Update the driver, then click Recheck memory.",
  hostBlockerDriverRequiredOnlyBody:
    "The local model engine requires an NVIDIA driver with CUDA {required} or newer. Update the driver, then click Recheck memory.",
  hostBlockerDriverUnknownBody:
    "The installed NVIDIA driver is too old for the local model engine. Update the driver, then click Recheck memory.",
  hostBlockerRuntimeTitle:
    "Install missing runtime dependencies to use local models",
  hostBlockerRuntimeLibrariesBody:
    "This computer is missing {libraries}, required by the local model engine. Install it (for example, libgomp1 on Ubuntu/Debian), then click Recheck memory.",
  hostBlockerRuntimeGlibcBody:
    "This system has glibc {detected}, while the local model engine requires glibc {required} or newer.",
  hostBlockerRuntimeGenericBody:
    "This computer is missing a required system library for the local model engine. Install the missing runtime dependency, then click Recheck memory.",
  debugBannerRegion: "Debug mode active",
  debugBannerTinyTitle: "Debug mode active (tiny)",
  debugBannerSimulateTitle: "Debug mode active (simulate)",
  debugBannerEnvBody:
    "LOCALMODELS_DEBUG is set on this computer, overriding the normal model catalog for testing. Unset LOCALMODELS_DEBUG and restart Linger to restore the standard catalog.",
  debugBannerConfigBody:
    "A local debug config ({path}) is overriding the normal model catalog for testing. Run localmodels debug off or delete that file, then click Recheck memory.",
  debugBannerConfigBodyHidden:
    "A local debug config file on this computer is overriding the normal model catalog for testing. Turn off debug mode on that computer to restore the standard catalog.",

  // A Computer that reports no model library.
  libraryNotReportedTitle: "{computer} hasn't reported local models yet",
  libraryNotReportedBody:
    "It reports them once it connects with an up-to-date Linger app.",
  libraryToolFailedTitle: "Couldn't read the local models on {computer}",
  libraryToolFailedBody:
    "The local model tools on this computer didn't answer. Check that they're installed and working, then open this page again.",
  libraryToolNotInstalledTitle: "Local models aren't set up on {computer}",
  libraryToolNotInstalledBody:
    "Run Quick Install in the Linger desktop app on that computer to add them.",

  capabilityCoding: "Coding",
  capabilityMultilingual: "Multilingual",
  capabilityReasoning: "Reasoning",
  capabilityToolUse: "Tool use",
  capabilityVision: "Vision",
  architectureDense: "Dense",
  architectureMoe: "MoE",
  engineHintPolystrata: "Hybrid GPU + RAM expert offload",
  engineHintStrata: "Hybrid GPU + RAM expert scheduling",
  engineHintLlamaCpp: "All-in-VRAM native engine",
  engineHintLlamaCppUnified: "Unified memory native engine",
  engineHintLlamaCppSystem: "System memory native engine",
  concurrencySingle: "1 request at a time",
  concurrencyMultiple: "{count} concurrent requests",

  // Why a model-source switch, endpoint test or read failed.
  sourceAgentsWorking: "Agents on this computer are working on tasks.",
  sourceByokAuthFailed: "The endpoint rejected the API key.",
  sourceByokGatewayFailed:
    "The computer couldn't configure its local BYOK gateway.",
  sourceByokGatewayFailedDetail:
    "The computer couldn't configure its local BYOK gateway: {detail}",
  sourceByokInvalidConfig:
    "The computer can't use this endpoint. An HTTPS endpoint needs an API key; plain HTTP works only on this computer or your local network.",
  sourceByokNotFound:
    "Nothing answered at the endpoint's address, or it doesn't serve this model ID.",
  sourceByokUnreachable: "The computer couldn't reach the endpoint.",
  sourceByokUpstreamRejected: "The endpoint rejected the test request.",
  sourceNoRoom:
    "There isn't enough free memory on the computer to load that model. Close memory-heavy apps or unload another model, recheck memory, and try again.",
  sourceSwitchFailed: "The computer couldn't switch. Try again.",
  sourceForbidden:
    "Only the person who connected this computer can change its models.",
  sourceUnavailable:
    "This computer can't switch models. Update Linger on it, then try again.",
  sourceUnconfirmed:
    "The computer didn't answer in time. It may still be switching; check again in a minute.",
  sourceByokProbeUnconfirmed:
    "The computer didn't answer in time while checking the endpoint. Try again.",
  sourceRuntimeNotEnabled: "This AI runtime isn't set up on the computer.",
  sourceReadUnconfirmed: "The computer didn't answer in time. Try again.",
  sourceReadFailed:
    "Couldn't read how Agents on this computer get their model. Try again.",

  // What freeing memory other apps hold would unlock.
  guidanceBlockedLoadTitle: "Free memory before loading",
  guidanceBlockedLoadTitleGpu: "Free GPU memory before loading",
  guidanceBlockedLoadBody:
    "Other apps are holding {other} of memory ({free} of {total} free). Forcing a model into tight memory can freeze the computer. Close video players, games, browsers, or other memory-heavy apps, then click Recheck memory to load it.",
  guidanceBlockedLoadBodyGpu:
    "Other apps are holding {other} of GPU memory ({free} of {total} free). Forcing a model into tight memory can freeze the computer. Close video players, games, browsers, or other memory-heavy apps, then click Recheck memory to load it.",
  guidanceBlockedDownloadTitle: "Free memory to install a larger model",
  guidanceBlockedDownloadTitleGpu: "Free GPU memory to install a larger model",
  guidanceBlockedDownloadBody:
    "Other apps are holding {other} of memory ({free} of {total} free), so larger models look unavailable right now. Close unnecessary apps (such as video players, games, or browsers) and click Recheck memory to detect all free memory before installing.",
  guidanceBlockedDownloadBodyGpu:
    "Other apps are holding {other} of GPU memory ({free} of {total} free), so larger models look unavailable right now. Close unnecessary apps (such as video players, games, or browsers) and click Recheck memory to detect all free memory before installing.",
  guidanceConstrainedTitle: "Other apps are using memory",
  guidanceConstrainedTitleGpu: "Other apps are using GPU memory",
  guidanceConstrainedBody:
    "Other apps are using {other} of memory ({free} of {total} free). To avoid loading failures or system freezes, close unnecessary apps and click Recheck memory so you can load a better model.",
  guidanceConstrainedBodyGpu:
    "Other apps are using {other} of GPU memory ({free} of {total} free). To avoid loading failures or system freezes, close unnecessary apps and click Recheck memory so you can load a better model.",
});
