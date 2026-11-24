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
  connectedStatus:
    "Computer is online. Check its Runtime status before running tasks.",
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
    "Install the CLI using step 1, then use a temporary token instead of browser sign-in. The server only needs an outbound connection.",
  serverName: "Server name",
  serverNamePlaceholder: "My server",
  generating: "Generating…",
  generateToken: "Generate connection token",
  tokenFailed:
    "Could not generate a token. Check your connection and try again.",
  tokenInstructions:
    "Run the command on the server, paste this token at the prompt, then press Enter. Expires at {time}. Keep it private.",
  tokenLabel: "Server connection token",
  waitingForServer:
    "Waiting for the server to connect. If exchange is interrupted, retry the same token before it expires.",
  generateAnother: "Generate another token",
  signInRequired: "{app} sign-in required",
  signInGuidance:
    "Run <code>{command}</code> or update the configured {app} credentials on {computer}, using the same OS user that runs Local Computer.",
  piSignIn:
    "In Pi, enter /login to sign in, or configure an API key in Pi auth.json.",
  antigravitySignIn:
    "Antigravity can also use a Gemini API key set as GEMINI_API_KEY for Local Computer.",
  installRuntime:
    "Install a Runtime on {computer} as the OS user that runs Local Computer. It appears here within a minute.",
  installRuntimePowerShell:
    "Install a Runtime on {computer} as the OS user that runs Local Computer, in PowerShell. It appears here within a minute.",
  updateRuntime:
    "Update a Runtime on {computer} as the OS user that runs Local Computer. It appears here within a minute.",
  updateRuntimePowerShell:
    "Update a Runtime on {computer} as the OS user that runs Local Computer, in PowerShell. It appears here within a minute.",
  runtimeCommand: "{app}: <code>{command}</code>",
  npmNeedsNode: "The npm commands need Node.js.",
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
