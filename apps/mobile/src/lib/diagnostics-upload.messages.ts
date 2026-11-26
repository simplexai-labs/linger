import { defineMessages } from "../i18n/messages";

export const diagnosticsUploadMessages = defineMessages("diagnosticsUpload", {
  tooLarge: "The diagnostics are too large to send.",
  unreachable: "The receiver could not be reached.",
  redirected: "The receiver sent the report somewhere else.",
  answered: "The receiver answered {status}.",
  unusableAnswer: "The receiver sent an unusable answer.",
  uploadUnfinished: "The upload did not finish.",
  uploadRefused: "The upload was refused.",
  shareTitle: "Linger phone log",
});
