import { defineMessages } from "@/i18n/messages";

export const accountMenuMessages = defineMessages("accountMenu", {
  label: "Account menu",
  settings: "Settings",
  logOut: "Log out",
  loggingOut: "Logging out...",
  version: "Version {version}",
  checking: "Checking for updates…",
  downloading: "Downloading Linger {version}…",
  ready: "Linger {version} is ready to install",
  restartToUpdate: "Restart to Update",
  waiting: "Updating to {version} when tasks finish",
  installing: "Updating to {version}…",
  serviceDownloading: "Downloading service update…",
  serviceReady: "Service update available",
  updateServices: "Update Services",
  serviceWaiting: "Will update services when tasks finish",
  serviceInstalling: "Updating services…",
  available: "Linger {version} is available",
  downloadUpdate: "Download Update",
  failed: "Update failed: {error}",
  tryAgain: "Try Again",
});
