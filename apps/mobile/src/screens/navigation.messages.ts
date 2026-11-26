import { defineMessages } from "../i18n/messages";

export const navigationMessages = defineMessages("navigation", {
  throughRelay: "Through a Relay",
  sameWifi: "Same Wi-Fi",
  waitingApproval: "Waiting for approval",
  offline: "Offline",
  removed: "Removed this phone",
  needsPairing: "Needs pairing again",
  connecting: "Connecting…",
  anotherMeLabel: "{name}, your Another Me",
  chatUnread: {
    one: "{title}, {count} unread",
    other: "{title}, {count} unread",
  },
  messages: "Messages",
  library: "Library",
  libraryDetail: "Meetings, documents and wiki",
  chat: "Chat",
  room: "Room",
  settings: "Settings",
  yourComputer: "Your computer",
  keyChangedTitle: "{name} needs pairing again",
  keyChangedBody:
    "It no longer answers to the key this phone paired with. If you reset Linger on it, pair this phone again. Otherwise, do not pair until you know why it changed.",
  pairAgain: "Pair again",
  switchTo: "Switch to {name}",
});
