import { defineMessages } from "@linger/service-kit/messages";

// The texts the iMessage bridge itself sends to the person's phone.
export const imessageMessages = defineMessages("imessage", {
  replyWithNumber: "Reply with a number.",
  replyWithNumbers: "Reply with numbers, e.g. 1,3.",
  replyRadioOrOther: "Reply with a number, or type your own answer.",
  replyCheckboxOrOther:
    "Reply with numbers (e.g. 1,3), or type your own answer.",
  approveOption: "Approve",
  denyOption: "Deny",
  replyApproveOrDeny: "Reply 1 to approve or 2 to deny.",
  openToAnswer: "Open Linger to answer: {link}",
  openToAnswerInApp: "Open Linger on your computer to review: {title}",
  answerChanged:
    "This question was already answered or changed. Open Linger to see it.",
  answerFailed: "Couldn't submit this answer. Open Linger to answer: {link}",
  answerFailedInApp:
    "Couldn't submit this answer. Open Linger on your computer to complete it.",
  openDocument: "{name} — open in Linger: {link}",
  openDocumentInApp: "{name} — open Linger on your computer to view it.",
});
