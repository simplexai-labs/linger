import { defineMessages } from "@linger/service-kit/messages";

// The texts the iMessage bridge itself sends to the person's phone.
export const imessageMessages = defineMessages("imessage", {
  replyWithNumber: "Reply with a number.",
  replyWithNumbers: "Reply with numbers, e.g. 1,3.",
  openToAnswer: "Open Linger to answer: {link}",
  answerChanged:
    "This question was already answered or changed. Open Linger to see it.",
  answerFailed: "Couldn't submit this answer. Open Linger to answer: {link}",
  openDocument: "{name} — open in Linger: {link}",
});
