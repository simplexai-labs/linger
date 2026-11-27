import { defineMessages } from "@linger/service-kit/messages";

// The status line at the top of the tray menu and in the title bar.
export const statusMessages = defineMessages("status", {
  notConnected: "Not Connected",
  signInExpired: "Sign-in Expired · Reconnect This Computer",
  identityConflict: "Computer Identity Conflict · Reconnect This Computer",
  updateRequired: "Update Required",
  runtimeError: "Runtime Error · Restarting",
  starting: "Starting…",
  offline: "Offline · Reconnecting",
  running: { one: "Running {count} Task", other: "Running {count} Tasks" },
  idle: "Online · Idle",
});

// The tray menu, its tooltip and the update notifications.
export const trayMessages = defineMessages("tray", {
  tooltip: "Linger · {status}",
  open: "Open Linger",
  reconnect: "Reconnect This Computer",
  connect: "Connect This Computer…",
  preventSleep: "Prevent Sleep",
  showLogs: "Show Logs",
  saveDiagnostics: "Save Diagnostics…",
  sendDiagnostics: "Send Diagnostics…",
  quit: "Quit Linger",
  downloading: "Downloading Update {version}…",
  restartToUpdate: "Restart to Update ({version})",
  waiting: "Updating to {version} When Tasks Finish",
  download: "Download Linger {version}…",
  serviceDownloading: "Downloading Service Update…",
  updateServices: "Update Services",
  serviceWaiting: "Will Update Services When Tasks Finish",
  serviceInstalling: "Updating Services…",
  updateFailed: "Update Failed: {reason}",
  tryUpdatingAgain: "Try Updating Again",
  availableTitle: "Update available",
  available: "Linger {version} is available. Click to open its download page.",
  readyTitle: "Update ready",
  ready: "Linger {version} is downloaded. Click to restart Linger and update.",
  signInFirst: "Sign in first",
  signInFirstDetail:
    "Sign in to Linger in the window, then choose Connect This Computer again.",
  enrollFailed: "Couldn't connect this computer",
});
