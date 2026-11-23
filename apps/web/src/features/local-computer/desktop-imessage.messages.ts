import { defineMessages } from "@/i18n/messages";

/** Settings › Computers: chatting with Another Me from Messages on this Mac. */
export const desktopIMessageMessages = defineMessages("desktopIMessage", {
  label: "iMessage",
  footer: "Chat with Another Me from Messages on this Mac.",
  useIMessage: "Use iMessage",

  // The bridge's state, under the switch.
  connecting: "Connecting…",
  connected: "Connected",
  signedOut: "Sign in to Linger to use iMessage",
  noAnotherMe: "Another Me is not set up yet",
  otherAccount:
    "Signed in to a different account. Turn iMessage off and on to use it with this account.",
  unreachable: "Cannot reach Linger. Trying again…",
  finishSetup: "Finish setup below",

  // The person's own handles.
  handlesLabel: "Your handles",
  handlesFooter:
    "The phone numbers and Apple ID emails you message from. Messages from anyone else are ignored.",
  remove: "Remove",
  handleInput: "Phone number or email",
  handlePlaceholder: "+1 415 555 0100 or name@icloud.com",
  add: "Add",
  invalidHandle:
    "Enter a phone number with its country code (+…) or an email address.",
  tooManyHandles: "Add at most 10 phone numbers or emails.",
  failed: "Something went wrong. Try again.",

  // The setup checklist.
  setup: "Setup",
  component: "iMessage component",
  installed: "Installed",
  installing: "Installing…",
  installsWhenOn: "Installs when you turn on iMessage",
  downloadFailed: "The download failed. Check your network and retry.",
  checksumMismatch: "The download was damaged. Retry.",
  extractFailed: "The download could not be unpacked. Retry.",
  executableMissing: "The download is incomplete. Retry.",
  retry: "Retry",
  fullDisk: "Full Disk Access",
  allowed: "Allowed",
  messagesNotSetUp: "Open Messages on this Mac once, then check again",
  fullDiskHint: "Lets Linger read your messages",
  openSettings: "Open Settings",
  controlMessages: "Control Messages",
  automationDenied: "Turn on Messages for Linger under Automation",
  automationHint: "Lets Linger send replies",
  allow: "Allow",
  signedIn: "Signed in to iMessage",
  signedInYes: "Signed in",
  signedInNo: "Sign in to iMessage in the Messages app",
  signedInUnknown: "Checked once Linger can control Messages",
});
