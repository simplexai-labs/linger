import { defineMessages } from "@/i18n/messages";

/** Connecting a Computer and getting an AI app on it ready to run Agents. */
export const computerSetupMessages = defineMessages("computerSetup", {
  label: "Connect a Local Computer",
  title: "Connect a computer",
  runInPowerShell:
    "Run these commands in PowerShell on the computer you want to connect.",
  runInTerminal:
    "Run these commands in a terminal on the computer you want to connect.",
  installCli: "Install CLI",
  connectComputer: "Connect computer",
  connectedTitle: "Computer connected",
  waitingNewTitle: "Waiting for a new computer",
  waitingTitle: "Waiting for your computer",
  connectedStatus: "Your computer is online.",
  checkingNew: "Checking for a new Local Computer...",
  checkingOnline: "Checking for an online Local Computer...",
  operatingSystem: "Computer operating system",
  chooseOperatingSystem: "Choose operating system",
  copyCommand: "Copy command",
  commandCopied: "Command copied",
  commandSelected: "Command selected",
  copied: "Copied",
  copiedToClipboard: "Copied to clipboard",
  selectedToCopy: "Command selected. Press Cmd+C or Ctrl+C to copy.",
  copyUnavailable: "Copy is unavailable on this connection.",
  serverSummary: "Connect a server · No browser on this computer?",
  serverIntro:
    "Install the CLI (step 1), then use a token instead of browser sign-in.",
  serverName: "Server name",
  serverNamePlaceholder: "My server",
  generating: "Generating…",
  generateToken: "Generate connection token",
  tokenFailed:
    "Could not generate a token. Check your connection and try again.",
  tokenInstructions:
    "Run the command on the server and paste this token. Expires {time}.",
  tokenLabel: "Server connection token",
  generateAnother: "Generate another token",
  signInRequired: "{app} sign-in required",
  signInGuidance: "Run <code>{command}</code> on {computer}.",
  piSignIn: "Or enter /login in Pi.",
  antigravitySignIn: "Or set GEMINI_API_KEY.",
  installRuntime:
    "Install a Runtime on {computer} as the OS user that runs Local Computer. It appears here within a minute.",
  installRuntimePowerShell:
    "Install a Runtime on {computer} as the OS user that runs Local Computer, in PowerShell. It appears here within a minute.",
  updateRuntime:
    "Update a Runtime on {computer} as the OS user that runs Local Computer. It appears here within a minute.",
  updateRuntimePowerShell:
    "Update a Runtime on {computer} as the OS user that runs Local Computer, in PowerShell. It appears here within a minute.",
  runtimeCommand: "{app}: <code>{command}</code>",
  npmNeedsNode: "Needs Node.js.",
  updateRequiredTitle: "{app} update required",
  updateRunInTerminal: "Run in Terminal on {computer}:",
  updateRunInPowerShell: "Run in PowerShell on {computer}:",
  updateAlternativeMac:
    "If you installed {app} from Homebrew or its macOS app, update it there instead.",
  computerUpgradeRequired:
    "{computer} needs a Linger update. Open <link>Settings › Computers</link>.",
  checkingRuntimeTitle: "Checking {app}",
  checkingRuntimeBody:
    "Waiting for {computer} to report {app} status. It updates here on its own.",
  runtimeCheckFailedTitle: "Couldn't check {app}",
  runtimeCheckFailedBody:
    "Check {app} on {computer} or inspect its status in <link>Settings › Computers</link>.",
  piCheckingSetup: "Checking Pi model setup on {computer}…",
  piNeedsModelTitle: "Pi needs a model",
  piNeedsModelBody:
    "No local model on {computer} yet. Download one or set a model source in <link>Settings › Models</link>.",
  piDownloadingTitle: "Downloading local model",
  piDownloadingBody:
    "{model} is downloading on {computer}. See <link>Settings › Models</link>.",
  piDownloadingBodyWithPercent:
    "{model} is downloading on {computer} ({percent}%). See <link>Settings › Models</link>.",
  piLoadingTitle: "Loading local model",
  piLoadingBody:
    "{model} is loading on {computer}. See <link>Settings › Models</link>.",
  piDownloadStoppedTitle: "Local model download stopped",
  piDownloadStoppedBody:
    "{model} didn't finish downloading on {computer}. Resume the download or choose another model in <link>Settings › Models</link> to run Agents with Pi.",
  piCredentialsOrSourceTitle: "Pi credentials or model source needed",
  piCredentialsOrSourceBody:
    "Pi on {computer} couldn't authenticate with its configured model source. Check your BYOK API key or switch to a local model in <link>Settings › Models</link>.",
  piStandaloneCliToggle: "Using the standalone Pi CLI instead?",
  desktopConnectIntro:
    "Connect this computer to run Agents with the Codex or Claude Code installed on it.",
  connecting: "Connecting…",
  connectThisComputer: "Connect this computer",
  lookingForApps: "Looking for Codex and Claude Code on this computer…",
  desktopAuthFailed:
    "This computer's sign-in expired. Choose Reconnect This Computer in the Linger menu bar menu.",
  desktopIdentityConflict:
    "This computer is already registered under another Computer entry. Choose Reconnect This Computer in the Linger menu bar menu.",
  desktopUpgradeRequired: "Update the Linger app to connect this computer.",
  desktopDisconnected:
    "The Linger background service is not running. Quit and reopen the app.",
  desktopRuntimeCrashed:
    "Codex and Claude Code could not be checked because the local runtime stopped. Linger is restarting it.",
});
