import { defineMessages } from "@linger/service-kit/messages";

// The setup window (setup.html): installing Linger on this computer or
// connecting it to a team server, then the permissions it asks for.
export const setupMessages = defineMessages("setup", {
  pageTitle: "Set Up Linger",

  // Welcome and the install plan.
  welcomeEyebrow: "Private to this computer",
  welcomeTitle: "Set up Linger",
  welcomeLeadLocal: "Runs on this computer, just for you. Takes a few minutes.",
  welcomeLeadTeam: "Connect this computer to your team's Linger.",
  modelSource: "Model source",
  modelSourceHint: "Where your agents get their models.",
  localModel: "Local model",
  subscription: "Subscription",
  byokTooltip:
    "Bring Your Own Key — Connect your own OpenAI-compatible or Anthropic API endpoint, key, and model through Linger's local Bifrost gateway.",
  localModelToggle: "Run tasks on a local model",
  aiRuntime: "AI runtime",
  runtimeHint: "Runs your tasks.",
  auto: "Auto",
  appIntegrations: "App integrations (optional)",
  appIntegrationsHint:
    "Composio connects apps; turn on voice inside the app. Keys stay on this computer.",
  composioKey: "Composio API key",
  show: "Show",
  hide: "Hide",
  remove: "Remove",
  keep: "Keep",
  installLocation: "Install location",
  changeLocation: "Change…",
  quickInstall: "Quick Install",
  install: "Install",
  getStarted: "Get Started",
  customize: "Customize",
  useDefaults: "Use the defaults",
  checkAgain: "Check again",
  teamServer: "Have a team server?",
  connectInstead: "Connect to it instead",
  downloadingTools: "Downloading setup tools…",
  checkingComputer: "Checking this computer…",
  findingSetup: "Finding the best setup for this computer",
  recommendedPlan: "Recommended for this computer: {plan}",
  bestRuntime: "Best AI runtime",
  localModelPi: "Local model + Pi",
  cannotCheck: "Couldn't check this computer for a local model.",
  fitsGpu: "fits {gpu}",
  fitsComputer: "fits this computer",
  memoryAmount: "{size} memory",
  downloadAmount: "{size} download",
  diskAmount: "{size} disk",
  memoryWithServices: "{size} memory with its services",
  heldWhy:
    "Local model on hold. {reasons} Quick Install sets up {plan} now, or choose Check again once memory is free.",
  heldWhyGeneric:
    "Local model on hold. {reasons} Quick Install sets up {plan} now, or choose Check again once the issue is resolved.",
  heldWhyCudaDriver:
    "Local model on hold. {reasons} Quick Install sets up {plan} now.",
  keyRemovedOnInstall: "Removed when you install",
  keySaved: "Saved · type to replace",
  apiKey: "API key",
  keysNote: "Applies when the installation runs.",
  recommendedLocal: "Recommended: Local model on this computer.",
  recommendedSubscription: "Recommended: Subscription ({runtime}).",
  chooseSource: "Choose how your agents run.",
  localRecommended: "Recommended for this computer · Runs on Pi via Bifrost",
  localRuns: "Runs your tasks on this computer via Pi",
  localOnHold: "Local model on hold",
  localNotAvailable: "Not available on this computer",
  recommendedRuntime: "Recommended: {runtime}.",
  subscriptionHint: "Sign in with your ChatGPT or Claude subscription.",
  locationHint:
    "Go back and set the install location to the drive itself (Linger installs into {folder}) or an empty folder directly on the drive.",

  // Featured partner model spotlight (Inkling 2 Mini by Thinking Machines).
  featuredModelName: "Inkling 2 Mini",
  featuredPartnerBadge: "Featured · Thinking Machines",
  featuredModelSpecs:
    "26.4B Looped MoE · 3.4B active · Vision & Agentic Coding · Apache 2.0",
  featuredModelSelected: "Selected for Quick Install on this computer.",
  featuredModelLibraryNote:
    "Featured in Linger's local model library · Switchable anytime in Settings → Models",
  featuredModelCustomizeNote:
    "Featured: Inkling 2 Mini by Thinking Machines · Switchable anytime in Settings → Models",
  featuredModelAriaLabel:
    "Featured local model: Inkling 2 Mini by Thinking Machines",
  learnMoreLink: "Learn more ↗",
  thinkingMachinesLink: "Thinking Machines ↗",
  openAnnouncement:
    "Open Thinking Machines Inkling 2 Mini announcement in browser",

  // Download progress.
  lessThanMinuteLeft: "less than a minute left",
  minutesLeft: "about {minutes} min left",
  hoursLeft: "about {hours} h left",
  hoursMinutesLeft: "about {hours} h {minutes} min left",
  thisFile: "This file: {amount}",
  amountOf: "{done} of {total}",
  amountLeft: "{size} left",

  // Why a local model is not offered, in the page's words for each reason
  // code of the localmodels tool.
  memoryCounts: " ({free} free, {needed} needed)",
  reasonGpuMemory:
    "Other programs are using the GPU's memory{counts}. Close programs that use the GPU, such as games, video or other AI apps.",
  reasonGpuMemoryOf:
    "Other programs are using GPU {gpu}'s memory{counts}. Close programs that use the GPU, such as games, video or other AI apps.",
  reasonFreeMemory:
    "Other programs are using the memory it needs{counts}. Close other programs.",
  reasonGpuSharing: "Other work is running on the GPU. Close it.",
  reasonGpuOwnership:
    "Linger couldn't tell which programs are using the GPU, so it can't share it. Close programs that use the GPU.",
  reasonGatewayPortInUse:
    "Another program is using the port Linger's local model gateway needs. Close the program using that port.",
  reasonHarnessUnavailable:
    "The Pi runtime required for local models isn't ready right now. Check your connection or permissions.",
  reasonFacts: "Linger couldn't read this computer's memory, disk or GPU.",
  reasonCudaUpdate:
    "Your NVIDIA driver supports CUDA {has}, but local models require CUDA {needs} or newer. Update your NVIDIA driver, then choose Check again.",
  reasonCudaTooOldNeeds:
    "Your NVIDIA driver is too old for local models (requires CUDA {needs} or newer). Update your NVIDIA driver, then choose Check again.",
  reasonCudaTooOld:
    "Your NVIDIA driver is too old for local models. Update your NVIDIA driver, then choose Check again.",
  reasonCudaUnknownNeeds:
    "Linger couldn't read the CUDA version from your NVIDIA driver (requires CUDA {needs} or newer). Update or reinstall your NVIDIA driver, then choose Check again.",
  reasonCudaUnknown:
    "Linger couldn't read the CUDA version from your NVIDIA driver. Update or reinstall your NVIDIA driver, then choose Check again.",
  reasonUnsupported: "Local models don't run on this system.",
  reasonPlanHeld:
    "Another app is holding the memory it needs, such as another AI app. Quit it.",
  reasonPlanUnavailable: "No local model fits this computer.",
  reasonHeld:
    "Other programs are using the memory it needs. Close other programs.",
  reasonHeldGeneric:
    "Something on this computer is temporarily blocking the local model.",
  reasonUnavailable: "This computer can't run a local model now.",
  heldGpu: "On hold: The GPU has {free} free, needs {needed}",
  heldGpuOf: "On hold: GPU {gpu} has {free} free, needs {needed}",
  heldMemory: "On hold: {free} of memory free, needs {needed}",
  heldGatewayPort: "On hold: free the gateway port, then Check again.",
  heldHarnessUnavailable: "On hold: prepare the Pi runtime, then Check again.",
  heldCudaDriver: "On hold: update your NVIDIA driver, then Check again.",
  heldClose: "On hold: close other programs, then Check again.",
  heldResolve: "On hold: resolve the issue, then Check again.",

  // BYOK fields.
  pathMostProviders: "Most providers",
  pathZhipu: "Zhipu GLM (base https://open.bigmodel.cn)",
  pathVolcano: "Volcano Engine Ark",
  pathNone: "No path. The base URL already has it.",
  endpointNone: "No endpoint. The base URL is the full address.",
  noAnswer: "Linger did not answer.",
  showSuggestions: "Show {field} suggestions",
  baseUrl: "Base URL",
  baseUrlPlaceholder: "Base URL (https://…)",
  apiKeyPlaceholder: "API key (stored privately on this computer)",
  listModels: "List models",
  listingModels: "Listing models",
  test: "Test",
  testing: "Testing…",
  path: "Path",
  pathHeading: "Path · optional",
  endpoint: "Endpoint",
  endpointHeading: "Endpoint · optional",
  defaultTag: "Default",
  runtimeDefault: "{runtime} default",
  model: "Model",
  modelPlaceholder: "Model ID (e.g. gpt-5.4 or claude-sonnet-4-6)",
  modelsHint:
    "Use the refresh button to list the endpoint's models, or type an ID.",
  listingFrom: "Listing models from <url>{url}</url>…",
  modelsFrom: {
    one: "{count} model from <url>{url}</url>",
    other: "{count} models from <url>{url}</url>",
  },
  contextSize: "{size} context",
  connected: "Connected",
  couldNotConnect: "Couldn't connect",
  dismiss: "Dismiss",
  invalidParts: "Path and endpoint must be empty or a path such as /v1.",
  greyDefaults: "Grey values are defaults. Path and endpoint are optional.",
  sendsTo: "Sends {format} requests to <url>{url}</url>",
  sendsToRuntime:
    "Sends {format} (the {runtime} format) requests to <url>{url}</url>",

  // Installing.
  installingTitle: "Installing Linger",
  installStopped: "Installation stopped",
  startingLinger: "Starting Linger",
  preparingUpdate: "Updating Linger on this computer…",
  preparingStart: "Starting Linger on this computer…",
  dataKept: "Your data is kept. Fix the problem and try again.",
  takesMinutes: "This takes a few minutes. You can keep working.",
  stepPrepare: "Checking this computer",
  stepDownload: "Downloading Linger {version}",
  stepServices: "Setting up AI and local services",
  stepWorkspace: "Setting up your account",
  stepSignIn: "Sign in to {runtime}",
  stepSignInRuntime: "Sign in to your AI runtime",
  stepConnect: "Connecting this computer",
  stepAgents: "Preparing your agents",
  stepRunning: "{step}…",
  waitingRuntime:
    "Checking the AI runtime on this computer. On some computers this takes a few minutes; the bar moves on once it finishes.",
  runtimeLookupTimedOut:
    "Checking the AI runtime did not finish in 10 minutes. Try Again picks up the same check; if it stops again, save diagnostics and send them to Linger support.",
  runtimeLookupUnreachable:
    "Lost the connection to the installer while checking the AI runtime. Try Again to reconnect; your data is kept.",
  showDetails: "Show Details",
  hideDetails: "Hide Details",
  showLogs: "Show Logs",
  saveDiagnostics: "Save Diagnostics",
  sendDiagnostics: "Send Diagnostics",
  savedDiagnostics: "Saved {file}. Send this file to Linger support.",
  back: "Back",
  tryAgain: "Try Again",

  // The AI runtime's sign-in.
  signInTo: "Sign in to {runtime}",
  signInLeadPi:
    "Pi needs a model provider. Run pi in a terminal to sign in, or use BYOK below; setup continues by itself.",
  signInLeadCodex:
    "Your agents run on Codex. Authorize it with your ChatGPT account to continue.",
  signInLeadClaude:
    "Your agents run on Claude Code. Authorize it with your Claude account to continue.",
  signInWaiting: "Waiting for authorization in your browser…",
  signInContinues: "Linger continues by itself once you've signed in.",
  deviceCode: "Enter this code on the sign-in page:",
  deviceCodeSetting:
    "Turn on device code sign-in for Codex in ChatGPT first: Settings → Security.",
  copyCode: "Copy code",
  signInLink: "Sign-in link",
  openInBrowser: "Open in browser",
  copyLink: "Copy link",
  browserFailed:
    "Linger couldn't open a browser. Copy the link and open it in a browser on this computer.",
  browserFailedDevice:
    "Linger couldn't open a browser. Copy the link and open it in any browser, on this computer or another device.",
  useDeviceCode: "Use a code on another device",
  useBrowserHere: "Use the browser on this computer",
  signInFailed: "Sign-in did not finish.",
  signInTimedOut: "Sign-in timed out. Retry to get a new link.",
  signInEnded:
    "Sign-in stopped before it finished. Retry, or choose another way below.",
  signInUnavailable:
    "This runtime can't be signed in to from here. Use a different runtime or BYOK.",
  authorize: "Authorize",
  retry: "Retry",
  otherRuntime: "Use a different runtime",
  byokInstead: "Use BYOK instead",
  continueWithByok: "Continue with BYOK",
  cancel: "Cancel",
  havingTrouble: "Having trouble?",
  signInHelpCode: "If the sign-in page shows a code, paste it here.",
  pastedCode: "Code from the sign-in page",
  pasteCode: "Paste the code",
  continue: "Continue",

  // Sending diagnostics.
  filesToSend: "Files to send",
  reportId: "Report ID",
  sendPreparing: "Preparing diagnostics",
  sendConfirm: "Send diagnostics to {host}?",
  sendSending: "Sending diagnostics",
  sendSent: "Diagnostics sent",
  sendFailed: "Couldn't send diagnostics",
  sendCollecting: "Collecting logs and settings…",
  sendConfirmLead: {
    one: "{count} file, {size}: logs and settings of this app and of Linger on this computer. Passwords, tokens, keys and your home folder path are removed first; credential files and your data are never included. Only the people who run {host} can read the report.",
    other:
      "{count} files, {size}: logs and settings of this app and of Linger on this computer. Passwords, tokens, keys and your home folder path are removed first; credential files and your data are never included. Only the people who run {host} can read the report.",
  },
  sendUploading: "Uploading to {host}… {percent}%",
  sendSentLead:
    "Give this report ID to Linger support so they can find your report.",
  sendByHand: "You can still use Save Diagnostics and send the file by hand.",
  send: "Send",
  copyReportId: "Copy Report ID",
  copied: "Copied",
  done: "Done",
  close: "Close",

  // Ready.
  readyTitle: "Linger is ready",
  readyLead: "Running on this computer, just for you.",
  computerConnected: "This computer is connected",
  accountTitle: "Your account on this computer",
  email: "Email",
  password: "Password",
  copy: "Copy",
  showPassword: "Show password",
  hidePassword: "Hide password",
  copyPassword: "Copy password",
  accountNote: "Use these to log in again if you log out.",
  accountReveal: "Open account file location",
  legacyNote:
    "Your data from the earlier Simplex app can't be upgraded to Linger, so this is a fresh workspace. The earlier data was moved, not deleted, to {folder}.",
  openLinger: "Open Linger",

  // Connecting to a team server.
  stepOf: "Step {step} of {total}",
  serverTitle: "Where is your team's Linger?",
  serverLead: "Enter the address your team uses for Linger.",
  serverAddress: "Server address",
  serverHint: "Ask your admin if you're not sure.",
  signInTitle: "Sign in to your account",
  signInLead:
    "Linger opens in its own window. Sign in there, and this window moves on by itself.",
  account: "Account",
  signedIn: "Signed in",
  waiting: "Waiting…",
  notSignedIn: "Not signed in",
  openSignIn: "Open Sign-in",
  connectTitle: "Connect this computer",
  connectLead:
    "Your workspace will see this computer and can send it tasks. You can disconnect it at any time.",
  connect: "Connect",
  connecting: "Connecting…",

  // Permissions. The tray icon sits in the menu bar on macOS and in the
  // system tray elsewhere, so those sentences come in both.
  permissionsTitle: "A few permissions",
  changeLaterMenuBar:
    "Change these later from the menu bar or in your system settings.",
  changeLaterTray:
    "Change these later from the system tray or in your system settings.",
  notifications: "Notifications",
  notificationsHint: "Know when a task finishes or needs you.",
  allowNotifications: "Allow Notifications",
  testSent: "Test Sent",
  folders: "Folders",
  foldersHint: "Folders tasks may read and change.",
  addFolder: "Add Folder…",
  fullDiskAccess: "Full Disk Access",
  fullDiskAbout: "Recommended. Covers every folder, no prompts.",
  fullDiskMissing: "Off. Protected folders prompt the first time.",
  userFolders: "Downloads, Documents, Desktop",
  userFoldersAbout: "Lets tasks read these folders.",
  userFoldersMissing: "Not allowed. Tasks can't read these folders.",
  automation: "Control other apps",
  automationAbout: "Lets tasks drive apps like your browser.",
  automationMissing: "Not allowed. Tasks can't control other apps.",
  allowed: "Allowed",
  openSettings: "Open Settings",
  allow: "Allow…",
  preventSleep: "Prevent sleep",
  preventSleepHint: "Keep this computer awake for incoming tasks.",
  openAtLogin: "Open at login",
  openAtLoginMenuBar: "Start in the menu bar when you log in.",
  openAtLoginTray: "Start in the system tray when you log in.",
  startUsing: "Start Using Linger",
});
