import { defineMessages } from "@/i18n/messages";

/**
 * The Document page: header, body, save status, actions menu, title, page
 * history, Version preview and presence. Document titles, owner names and
 * error messages TeamHub sends are data and are shown as they arrive.
 */
export const documentPageMessages = defineMessages("documentPage", {
  // The name of a Document that has no title yet, and the header label.
  document: "Document",
  openLibraryPages: "Open Library pages",
  libraryPages: "Library pages",
  mail: "Mail",
  comments: "Comments",
  breadcrumb: "Breadcrumb",
  // Where a Document comes from, when it is not in the Library tree.
  contextRoom: "Room",
  contextWorkItem: "Work Item",
  contextDocuments: "Documents",
  documentMode: "Document mode",
  read: "Read",
  currentMode: "Current mode",
  editMode: "Edit mode",
  readMode: "Read mode",
  moreActions: "More Document actions",
  pageHistory: "Page history",

  openingWikiPage: "Opening Wiki page...",
  byOwner: "By {name}",
  openingDocument: "Opening document",
  openingDocumentStatus: "Opening document...",
  downloadRecoveryCopy: "Download recovery copy",
  recoveryCopy: "Recovery copy",
  connectionStatus: "Document connection status",
  connectionFailed: "Connection failed",
  retryConnection: "Retry connection",
  accessMode: "Document access mode",
  readOnly: "Read only",
  saveStatus: "Document save status",
  saved: "Saved",
  saveProtocolError: "Couldn't save. Reload to retry.",
  offlineChangesPending: "Offline changes pending",
  offline: "Offline",
  connecting: "Connecting...",
  saving: "Saving...",

  titleUpdateFailed: "The title could not be updated.",
  renameDocument: "Rename document",
  documentTitle: "Document title",
  trashFailed: "The Document could not be moved to trash.",
  exportFailed: "The Document could not be exported.",
  duplicateFailed: "The Document could not be duplicated.",
  resizeComments: "Resize Document comments",

  closePageHistory: "Close Page history",
  noPageHistory: "No page history saved yet.",
  loadingTimeline: "Loading timeline...",
  historyPreview: "History preview",
  highlightChanges: "Highlight changes",
  selectCheckpoint: "Select a checkpoint to preview it.",
  loadingCheckpoint: "Loading checkpoint...",
  historicalContent: "Historical Document content",
  checkpointIdentical:
    "This checkpoint is identical to the previous checkpoint.",
  checkpointEmpty: "This checkpoint has no content.",
  restoreCheckpoint: "Restore checkpoint",
  alreadyCurrent: "Already current.",
  restored: "Restored.",
  revisionInconsistent: "History Revision identity is inconsistent.",
  revisionIntegrityFailed: "This version couldn't be loaded.",
  revisionInvalid: "History Revision bytes are invalid.",
  // Joins names in a list, such as the people who changed a checkpoint.
  listSeparator: ", ",

  noPublishedVersion: "This Document has no published Version.",
  previewLoadFailed: "Document preview could not be loaded.",
  downloadFailed: "Document download failed.",
  retryPreview: "Retry preview",
  loadingPreview: "Loading preview…",
  previewUnavailable: "Preview is unavailable for this Version.",

  metadataUnavailable: "Document metadata is unavailable.",
  documentUnavailable: "Document is unavailable.",
  collaborationOpenFailed: "Document collaboration could not be opened.",

  // {names} is the list of people, joined with listSeparator.
  peopleInDocument: "{count} people in this document: {names}",
  peopleViewing: {
    one: "{count} person viewing",
    other: "{count} people viewing",
  },
  nameYou: "{name} (you)",
  collaborator: "Collaborator",
  cursor: "{name} cursor",
});
