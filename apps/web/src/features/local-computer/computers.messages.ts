import { defineMessages } from "@/i18n/messages";

/** Settings › Computers: the list, one Computer's detail, and its dialogs. */
export const computersMessages = defineMessages("computers", {
  // The page and the list of Computers.
  pageTitle: "Computers",
  allComputers: "All computers",
  connect: "Connect",
  directoryLabel: "Local computers directory",
  reconnecting: "Reconnecting…",
  offline: "Offline",
  offlineSince: "Offline · {time}",
  updateRequired: "Update required",
  signInToApp: "Sign in to {app}",
  updateApp: "Update {app}",
  couldNotCheckApp: "Couldn't check {app}",
  setUpApp: "Set up {app}",
  ready: "Ready",
  readyRunning: "Ready · {count} running",
  oneStepLeft: "One step left",

  // Empty and unavailable states.
  unavailableTitle: "Computer unavailable",
  unavailableBody:
    "This Computer is offline or no longer available to your account.",
  backToComputers: "Back to computers",
  setupCommands: "Setup commands",
  connectDialogTitle: "Connect Local Computer",
  connectDialogDescription:
    "Install the CLI, then authorize this workspace from your terminal.",
  noComputersTitle: "Run Agents on your computer",
  noComputersBody: "About 2 minutes to set up.",

  // One Computer's detail.
  detailsLabel: "{computer} details",
  agents: "Agents",
  aiApps: "AI apps",
  aiAppsHint:
    "Agents use these apps on this computer to do the work. One ready app is enough.",
  localModels: "Local models",
  manageLocalModels: "Manage local models",
  manageLocalModelsHint: "Download and load models that run on this computer",
  power: "Power",
  preventSleep: "Prevent sleep",
  preventSleepHint:
    "Keep this computer awake while locked so scheduled midnight Memory and Wiki tasks run on time (recommended while plugged in).",
  preventSleepFailed: "Could not update sleep setting. Try again.",
  access: "Access",
  advanced: "Advanced",
  update: "Update",
  updateTo: "Update to {version}",
  updateLingerComputer: "Update Linger Computer",
  updateInstructions:
    "Wait for running tasks to finish, then run this on {computer}. Your Agents stay connected.",
  checkAgain: "Check again",
  appVersion: "App {version}",
  lingerTooOld: "This app version is too old to run Agents",
  lingerRunning: "The Linger app is running",
  connected: "Connected",
  agentsUseApp: "Agents use {app} here",
  appSignedOut: "{app} is installed but signed out",
  signIn: "Sign in",
  appTooOld: "{app} is too old to run Agents",
  needAiApp: "Agents need Claude Code, Codex or Pi on this computer",
  turnOn: "Turn it on",
  turnOnHint:
    "Turn it on and connect to the internet. It usually reconnects by itself.",
  startApp: "Start the app",
  stillOffline: "Still offline after a minute?",
  runInTerminalOn: "Run in Terminal on {computer}:",
  reconnect: "Reconnect",
  reconnectHint: "Reset or replaced it? Connect it again.",
  add: "Add",
  optionalApp: "{description} · optional",
  notInstalled: "Not installed",
  lastSeenSignedOut: "Last seen signed out",
  lastCheckFailed: "Last check failed",
  lastSeenOutdated: "Last seen outdated",
  lastSeenReady: "Last seen ready",
  notCheckedYet: "Not checked yet",
  signedOut: "Signed out",
  couldNotCheck: "Couldn't check",
  updateNeeded: "Update needed",
  checkAgainOn: "Check again in Terminal on {computer}:",
  workspaceHint: "Where Agents keep their work on this computer",
  agentsCanView: "Agents can view here",
  agentsCanEdit: "Agents can edit here",
  app: "App",
  notReported: "Not reported",
  versionAvailable: "{version} available",
  computerId: "Computer ID",
  troubleshoot: "Troubleshoot",
  toolStatus: "Status",
  toolRestart: "Restart",
  toolRecheck: "Re-check",
  toolStop: "Stop",
  removeComputer: "Remove computer",
  runInPowerShellWindows: "Run in PowerShell on this Windows computer.",

  // AI apps and their state, as other pages list them too.
  descriptionClaude: "Anthropic's coding agent",
  descriptionCodex: "OpenAI's coding agent",
  descriptionPi: "Open-source coding agent",
  descriptionAntigravity: "Google's coding agent",
  statusSignInRequired: "Sign-in required",
  statusCouldNotCheck: "Could not check",
  statusChecking: "Checking",

  // The Agents on a Computer.
  noAgents: "No Agents on this computer yet. Create one from Chats.",
  less: "Less",
  more: "More",
  tasksRunning: {
    one: "{count} task running",
    other: "{count} tasks running",
  },
  appSignInNeeded: "{app} sign-in needed",
  statusUnavailable: "Status unavailable",
  agentsNeedAttention: {
    one: "{count} needs attention",
    other: "{count} need attention",
  },
  agentsOffline: "{count} offline",
  agentsStatusUnavailable: "{count} status unavailable",

  // Setting up one AI app.
  computerOffline: "{computer} is offline",
  appReady: "{app} is ready",
  checkingApp: "Checking {app}…",
  setupAccountHint:
    "On {computer}, in the same account you used to connect it.",
  stepInstall: "Install",
  piLoginHint: "Then type /login in Pi",
  signInPageHint: "A sign-in page opens in your browser",
  pasteIntoTerminal: "Paste into Terminal on {computer}",
  runThenSignIn: "Run this, then sign in on the page that opens",

  // The page the CLI opens to connect a Computer.
  connectName: "Connect {computer}",
  reconnectName: "Reconnect {computer}",
  localRuntimeAccess: "Local runtime access",
  localRuntimeAccessBody:
    "The Computer will appear as an available runtime for your account.",
  loadingSpaces: "Loading spaces...",
  spacesUnavailable: "Spaces are unavailable.",
  noSpace: "No space is available for this account.",
  space: "Space",
  signedInAs: "Signed in as <email>{email}</email>",
  confirmReplacement: "Confirm Local Computer replacement",
  replacementRemoved:
    "This Computer was removed from the signed-in account. Continuing stops the old local daemon and connects this machine as a new Computer for the account shown above. The old Computer and its Agents are not deleted from the server.",
  replacementWrongAccount:
    "This Computer cannot be renewed by the signed-in account. Continuing stops the old local daemon and connects this machine as a new Computer for the account shown above. The old Computer and its Agents are not deleted from the server.",
  keepCurrentSetup: "Keep current setup",
  replaceLocalIdentity: "Replace local identity",
  connectFailed: "The Computer could not be connected. Run setup again.",
  signingOut: "Signing out...",
  useAnotherAccount: "Use another account",
  connectingRequest: "Connecting...",
  reconnectComputer: "Reconnect computer",
  invalidRequestTitle: "Connection request is invalid",
  invalidRequestBody: "Return to the terminal and run setup again.",
  couldNotConnect: "Could not connect",

  // The gate shown until a Computer can run Another Me.
  gateKicker: "Before you start",
  gateTitle: "Connect your computer",
  gateIntro:
    "Your Agents run on your own computer with Claude Code, Codex or Pi. Connect one to start.",
  gateReady: "Your computer is ready. Creating your Another Me...",
  installTheCli: "Install the CLI",
  setUpAiApp: "Set up an AI app",
  availableOnceOnline: "Available once your computer is online.",
  signOut: "Sign out",
  waitingForComputer:
    "Waiting for your computer. Approve the request when it opens in your browser.",
  computerNeedsUpdate:
    "{computer} needs an update. Run the command in step 1 again on it.",
  computerOfflineStart:
    "{computer} is offline. Start it with <code>{command}</code>.",
  computerOnline: "{computer} is online.",
  oneReadyAppEnough: "One ready app is enough.",
  orRunLocalModel:
    "Or run a model on {computer} itself: load one in <link>Settings › Models</link>.",
  checkingComputer: "Checking {computer}. Changes show up within a minute.",

  // Removing a Computer.
  removeTitle: "Remove Local Computer",
  removeDescription:
    "This revokes <strong>{computer}</strong> and removes it from this workspace. Reconnecting requires a new setup.",
  noOtherComputer:
    "No other computer can take these Agents. Connect your new computer first.",
  moveAndRemove: {
    one: "Move {count} Agent and remove",
    other: "Move {count} Agents and remove",
  },
  moveDeleteAndRemove: "Move, delete and remove",
  deleteAndRemove: "Delete and remove",
  deleteAgentHint:
    "Removes this Agent from every Room and deletes your direct chat with it.",
  anotherMeNeedsComputer:
    "Another Me can't be deleted. Connect another computer to move it.",
  agentNeedsComputer:
    "Connect another computer to move this Agent, or delete it.",
  assignedAgents: "Assigned Agents",
  assignedAgentsMoveFirst: "Assigned Agents move first",
  targetFor: "Target for {name}",
  chooseTarget: "Choose a target",
  deleteAgentInstead: "Delete this Agent instead",
  moveFailed: "Failed: {message}",
  deleted: "Deleted",
  deleting: "Deleting…",
  moved: "Moved",
  moving: "Moving…",

  // Connecting the user's Chrome to a Computer.
  connectMyBrowser: "Connect my browser",
  connectMyBrowserIntro:
    "Let Agent browser tasks on this Computer use your everyday Chrome and its sign-ins. The token goes only to your Computer and never appears in chat.",
  loadingComputers: "Loading your Computers…",
  cannotLoadComputers: "Can't load your Computers right now.",
  computerNoLongerConnected:
    "This Computer is no longer connected to your account.",
  noLocalComputerYet:
    "You don't have a Local Computer yet. Connect one in Settings > Computers first. Cloud Computers can't use your browser.",
  computer: "Computer",
  computerNamed: "Computer: <name>{computer}</name>",
  computerOfflineOption: "{computer} (offline)",
  reconfigure: "Reconfigure",
  disconnect: "Disconnect",
  disconnecting: "Disconnecting…",
  installExtensionStep: "Install <link>Playwright Extension</link> in Chrome",
  copyTokenStep:
    "Click the extension icon and copy the token it shows (the full <code>PLAYWRIGHT_MCP_EXTENSION_TOKEN=…</code> line also works)",
  pasteTokenStep: "Paste it below and connect",
  extensionToken: "Extension token",
  pasteToken: "Paste token",
  connectingUpToMinute: "Connecting, up to 1 minute…",
  checkingBrowserStatus: "Checking browser status…",
  browserComputerOffline:
    "This Computer is offline. Make sure it's on and running Linger Computer.",
  browserUnavailableOffline: "Unavailable while this computer is offline.",
  agentsCanUseChrome: "Agents can use your Chrome",
  chromeOptional: "Optional · let Agents use your Chrome",
  connectChrome: "Connect Chrome",
  manage: "Manage",
  agentsUseSignIns: "Agents use your sign-ins.",
  agentsBrowseWithoutSignIns: "Agents browse without your sign-ins.",
  agentsAskBeforeBrowsing: "Agents ask before browsing.",

  // What a Computer reports about its browser.
  browserConnectedLabel:
    "Connected. Browser tasks use your Chrome and its sign-ins.",
  tokenExpired: "Token expired",
  tokenExpiredLabel:
    "Token expired. Copy a new token from the extension, then reconnect.",
  chromeUnavailable: "Chrome unavailable",
  chromeUnavailableLabel:
    "Can't reach your Chrome. Make sure Chrome is open on this Computer, then reconnect.",
  extensionUnavailable: "Extension unavailable",
  extensionNotFound:
    "Playwright Extension not found. Install and enable it in Chrome, then reconnect.",
  notConnected: "Not connected",
  notConnectedLabel:
    "Not connected. Agent browser tasks wait until you connect your everyday Chrome.",
  isolatedLabel:
    "Not connected. Agents use a separate browser without your sign-ins.",
  notSupported: "Not supported",
  unsupportedLabel:
    "This Computer can't use your browser. Agents use a separate browser without your sign-ins.",
  browserStatus: "Browser status",
  browserStatusUnknown: "Browser status unknown",

  // Why connecting the browser failed.
  browserInvalidToken:
    "Can't read this token. Copy the full line that starts with PLAYWRIGHT_MCP_EXTENSION_TOKEN=, or only the token after the equals sign.",
  browserComputerNotFound:
    "Can't find this Computer. It may have been removed.",
  browserOutdated:
    "Linger Computer on this Computer is out of date. Update it, then connect your browser.",
  browserTimeout:
    "Connection timed out. Make sure Chrome is open and the extension is enabled, then try again.",
  browserTokenRejected:
    "The extension didn't accept this token. Copy the current token from the extension, then reconnect.",
  chromeNotInstalled:
    "Google Chrome isn't installed on this Computer. Install Chrome first.",
  browserBusy: "An Agent task is using this Chrome. Connect after it finishes.",
  browserConnectionDamaged:
    "The saved browser connection on this Computer is damaged. Paste a token to reconnect.",
  browserConnectFailed:
    "This Computer couldn't connect to your browser. Try again later.",
  browserConnectUnavailable:
    "Can't connect to the browser right now. Try again later.",
});
