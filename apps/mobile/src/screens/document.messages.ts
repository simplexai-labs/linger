import { defineMessages } from "../i18n/messages";

export const documentMessages = defineMessages("document", {
  title: "Document",
  back: "Back",
  openInAnotherApp: "Open in another app",
  truncatedRows: {
    one: "Showing the first {count} row. Open the file on your computer for all of it.",
    other:
      "Showing the first {count} rows. Open the file on your computer for all of it.",
  },
  gettingOf: "Getting it… {received} of {total}",
  getting: "Getting it… {received}",
  gettingFromComputer: "Getting it from your computer…",
  open: "Open",
  opensInViewer: "Opens in the phone's viewer.",
  couldNotShow:
    "Linger could not show this file. It opens in the phone's viewer.",
  noApp:
    "No app on this phone opens this kind of file. Open it in Linger on your computer.",
  didNotDownload: "The file did not download.",
  tryAgain: "Try again",
  didNotLoad: "The document did not load",
  cannotRead: "You cannot read this here",
  notShared: "It is not shared with you, or it was deleted.",
  waiting: "Waiting for your computer",
});
