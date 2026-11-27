// The Library screens under app/(main)/library; kept here because every file
// in the app directory is a route.
import { defineMessages } from "../i18n/messages";

export const libraryScreenMessages = defineMessages("libraryScreen", {
  library: "Library",
  meeting: "Meeting",
  meetings: "Meetings",
  documents: "Documents",
  wiki: "Wiki",
  listFailed: "This list did not load",
  tryAgain: "Try again",
  waitingForComputer: "Waiting for your computer",
  noMeetings: "No meetings yet",
  noMeetingsBody:
    "Meetings you record appear here with their summary and transcript.",
  noDocuments: "No documents yet",
  noDocumentsBody: "Files and documents from your chats appear here.",
  noWikiPages: "Your wiki has no pages yet",
  noWikiPagesBody:
    "Pages about your projects, topics and people appear here as Linger learns them.",
});

export const meetingsDetailMessages = defineMessages("meetingsDetail", {
  meeting: "Meeting",
  summary: "Summary",
  transcript: "Transcript",
  transcriptFailed: "The transcript did not load",
  meetingFailed: "This meeting did not load",
  tryAgain: "Try again",
  summaryPending: "The summary is still being written.",
  noTranscript: "This meeting has no transcript.",
});
