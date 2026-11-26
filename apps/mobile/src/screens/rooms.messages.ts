import { defineMessages } from "../i18n/messages";

export const roomsMessages = defineMessages("rooms", {
  messagePlaceholder: "Message {name}",
  anotherMeEmpty: "What can {name} take off your plate?",
  waiting: "Waiting for your computer",
  couldNotLoad: "{name} could not be loaded",
  tryAgain: "Try again",
  gettingReady: "{name} is getting ready",
  gettingReadyBody: "It appears here once Linger has started on your computer.",
  messages: "Messages",
  noMessages: "No messages yet",
  room: "Room",
  anotherMeLabel: "{name}, your Another Me",
  anotherMeUnread: {
    one: "{name}, your Another Me, {count} unread",
    other: "{name}, your Another Me, {count} unread",
  },
  roomUnread: {
    one: "{title}, {count} unread",
    other: "{title}, {count} unread",
  },
});
