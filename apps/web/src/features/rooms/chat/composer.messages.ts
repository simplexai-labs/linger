import { defineMessages } from "@/i18n/messages";

/** The message composer, its pickers and notices, and the errors of sending. */
export const composerMessages = defineMessages("composer", {
  // The input itself.
  messageRoom: "Message Room",
  messageThisRoom: "Message this Room",
  messagePeer: "Message {name}",
  sendMessage: "Send message",
  lengthCount: "{count} / {limit}",
  historyPosition: "History {index}/{total}",
  messageTooLong: "Message must be {limit} characters or fewer.",
  messageNotSent: "Message could not be sent",
  listSeparator: ", ",

  // Document contexts, references and the reply context above the input.
  artifactContexts: "Artifact contexts",
  openContextVersion: "Open {filename} Version {version}",
  contextVersion: "Version {version} · {room}",
  removeContextVersion: "Remove {filename} Version {version}",
  removeContext: "Remove context",
  composerReferences: "Composer references",
  openProfile: "Open {name} profile",
  openDocument: "Open {name}",
  replyContext: "Selected reply context",
  removeFromReplyContext: "Remove {name} from reply context",
  removeReplyContext: "Remove reply context",

  // Attachments.
  attachFile: "Attach file",
  chooseAttachments: "Choose message attachments",
  pendingAttachments: "Pending attachments",
  previewFile: "Preview {name}",
  removeFile: "Remove {name}",
  uploadingFile: "Uploading {name}",
  uploadingPercent: "Uploading {percent}%",
  retryUpload: "Retry upload {name}",
  downloadFile: "Download {name}",
  closeImagePreview: "Close image preview",
  fileError: "{name}: {error}",
  uploadFailed: "Upload failed.",
  attachmentTooLarge:
    "Attachments can be up to {limit}, and this file is {size}.",
  attachmentLimit: "Attach up to {limit} files at a time.",
  attachmentCleanupFailed: "Attachment cleanup failed.",
  attachmentCleanupFailedDetail: "Attachment cleanup failed: {detail}",
  dropFilesTitle: "Release to add to the current message",
  dropFilesLimit: "Up to 5 files",

  // The mention picker.
  mentionPicker: "Mention people or documents",
  mentionTabAll: "all",
  mentionTabPeople: "people",
  mentionTabDocs: "docs",
  noMatchingResults: "No matching results",
  noMatchingPeople: "No matching people",
  noMatchingDocuments: "No matching documents",
  agent: "Agent",
  person: "Person",
  doc: "Doc",
  updatedRecently: "Updated recently",
  updatedToday: "Updated today {time}",
  updatedYesterday: "Updated yesterday {time}",
  updatedDaysAgo: "Updated {days}d ago {time}",
  updatedOn: "Updated {date} {time}",

  // The Skill picker.
  skill: "Skill",
  skillToken: "Skill {token}",
  skillsFor: "Skills for {name}",
  skillsForAgent: "Skills for <agent>{name}</agent>",
  noMatchingSkills: "No matching skills for {name}",
  selectedSkillDescription: "Selected Skill description",
  selectSkill: "Select a Skill.",
  noDescription: "No description available.",

  // Documents and mentions that cannot be sent as written.
  documentFallbackName: "Document",
  documentCannotBeShared: "Document cannot be shared in this Room.",
  documentShareFailed:
    "Document could not be shared in this Room. Check your access and try again.",
  documentLinkLoading: "Document link is still loading.",
  documentReferencesUnavailable:
    "Document references are unavailable in this conversation.",
  documentsOutsideRoomFailed:
    "Documents outside this Room could not be loaded.",
  referencesLoadingRetry: "Message references are still loading. Try again.",
  referencesLoadingReview:
    "Message references are still loading. Exit to review the draft.",
  unavailableMentionsRemove: {
    one: "{names} is not available in this Room. Remove the mention to send.",
    other:
      "{names} are not available in this Room. Remove the mentions to send.",
  },
  unavailableMentionsReview: {
    one: "{names} is not available in this Room. Exit to review the draft.",
    other: "{names} are not available in this Room. Exit to review the draft.",
  },

  // Thinking effort, shown on the model pill and in the Agent's settings.
  effortNone: "None",
  effortLow: "Low",
  effortMedium: "Medium",
  effortHigh: "High",
  effortExtraHigh: "Extra high",
  effortMaximum: "Maximum",
  effortUltra: "Ultra",
  loadingSettings: "Loading settings…",

  // Notices above the input.
  agentsUnavailable: "Your agents are unavailable",
  localAgentStatusUnavailable: "Can't check this Agent's status right now.",
  agentStatusUnavailable: "Can't load this Agent right now.",
  agentDeleted: "This Agent was deleted.",
  lastConfirmedAt: "Last confirmed at {time}",
  reconnectingLocalComputer: "Reconnecting to {computer}…",
  checkingLocalComputer: "Checking {computer}…",
  checkLocalRuntime: "This Agent can't reply right now.",
  signInHint: "Run <code>{command}</code> there.",
  dismissAgentAvatar: "Dismiss {name} avatar",

  // Delivery: what a Message that did not go through says.
  outboxRestoreFailed:
    "Couldn't restore unsent messages. Check browser storage, then reload.",
  outboxRestoreFailedDetail:
    "Couldn't restore unsent messages: {detail} Check browser storage, then reload.",
  outboxNormalizationFailed:
    "Some unsent messages couldn't be restored. Check browser storage, then retry.",
  outboxNormalizationFailedDetail:
    "Some unsent messages couldn't be restored: {detail} Check browser storage, then retry.",
  outboxCleanupFailed: "Sent, but not cleared from this browser. Retry.",
  outboxCleanupFailedDetail:
    "Sent, but not cleared from this browser: {detail} Retry.",
  outboxCancelFailed:
    "Canceled, but not cleared from this browser. Cancel again.",
  outboxCancelFailedDetail:
    "Canceled, but not cleared from this browser: {detail} Cancel again.",
  deliveryUnconfirmed: "It may have sent. Retry won't send it twice.",
  deliveryInterrupted: "Interrupted. Retry won't send it twice.",
  saveLocallyStorageFull: "Browser storage is full. Free some space and retry.",
  saveLocallyFailed:
    "This Message could not be saved locally. Check browser storage and retry.",
  saveLocallyFailedDetail: "This Message could not be saved locally: {detail}",

  // The microphone when the composer starts voice input.
  microphoneInUse: "Another voice input is using the microphone",
  microphoneHardwareRecording: "Hardware recording is using the microphone",
  microphoneOtherTab: "The microphone is active in another tab",
});
