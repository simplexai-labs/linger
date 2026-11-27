import { defineMessages } from "@linger/service-kit/messages";

// The page the window shows instead of the server (offline.html): the server
// is out of reach, the services on this computer start or update, or no
// server is set yet.
export const offlineMessages = defineMessages("offline", {
  unreachableTitle: "Can't reach the server",
  unreachable:
    "Linger can't reach <host>{host}</host>. Check your network or VPN and make sure the server is running.",
  tryAgain: "Try Again",
  changeServer: "Change Server",
  showLogs: "Show Logs",
  saveDiagnostics: "Save Diagnostics",
  sendDiagnostics: "Send Diagnostics",
  setUpAgain: "Set Up Again",
  serverAddress: "Server address",
  serverHint: "The address of your team's Linger server.",
  invalidServer: "Enter a server address that starts with http:// or https://",
  connect: "Connect",
  cancel: "Cancel",
  updatingTitle: "Updating Linger",
  updating:
    "Linger is restarting on this computer with the new version. This takes about a minute.",
  updatingServicesTitle: "Updating services",
  updatingPrepare: "Preparing service update…",
  updatingStopping: "Stopping local services…",
  updatingSwitching: "Switching to the new version…",
  updatingVerifying: "Starting services and verifying health…",
  updatingComplete: "Update complete, opening workspace…",
  updatingRollback: "Health check failed, rolling back automatically…",
  updatingRolledBack: "Rolled back to the previous stable version",
  startingTitle: "Starting Linger",
  starting: "Linger is starting on this computer. This takes about a minute.",
  failedTitle: "Linger couldn't start on this computer",
  setupTitle: "Connect to Linger",
  setup: "Enter your team's server address, then sign in.",
  backToSetup: "Back to Setup",
  retrying: "Retrying in {seconds}s",
});
