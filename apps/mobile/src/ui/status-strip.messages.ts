import { defineMessages } from "../i18n/messages";

export const statusStripMessages = defineMessages("statusStrip", {
  yourComputer: "Your computer",
  offline: "{name} is offline. Linger keeps trying.",
  retry: "Retry",
  connecting: "Connecting to {name}…",
  approve: "Approve this phone on {name} to continue.",
  cannotRunTasks: "Your computer can't run tasks right now.",
});
