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
  localAgentStatusUnavailable:
    "Local Agent status is unavailable. You can still send messages; replies may be delayed.",
  agentStatusUnavailable:
    "Agent status is unavailable. Messages remain read-only.",
  agentDeleted:
    "This Agent has been deleted. Message and Run history remain available.",
  lastConfirmedAt: "Last confirmed at {time}",
  reconnectingLocalComputer: "Reconnecting to Local Computer…",
  checkingLocalComputer: "Checking Local Computer status…",
  keepSending: "You can keep sending messages.",
  agentUnavailable: "Agent unavailable",
  checkLocalRuntime: "Check the Local Computer Runtime and try again.",
  agentCannotReply:
    "You can still send messages. This Agent cannot reply until its Runtime recovers.",
  dismissAgentAvatar: "Dismiss {name} avatar",

  // Delivery: what a Message that did not go through says.
  outboxRestoreFailed:
    "Saved Messages could not be restored from browser storage. Reload or check browser storage before sending.",
  outboxRestoreFailedDetail:
    "Saved Messages could not be restored from browser storage: {detail} Reload or check browser storage before sending.",
  outboxNormalizationFailed:
    "Saved Messages were restored, but their interrupted delivery state could not be updated. They remain available in this tab; retry after checking browser storage.",
  outboxNormalizationFailedDetail:
    "Saved Messages were restored, but their interrupted delivery state could not be updated: {detail} They remain available in this tab; retry after checking browser storage.",
  outboxCleanupFailed:
    "This Message was sent, but its local retry record could not be cleared. Retry to reconcile it safely.",
  outboxCleanupFailedDetail:
    "This Message was sent, but its local retry record could not be cleared: {detail} Retry to reconcile it safely.",
  outboxCancelFailed:
    "Delivery was canceled, but its local retry record could not be cleared. Try cancel again.",
  outboxCancelFailedDetail:
    "Delivery was canceled, but its local retry record could not be cleared: {detail} Try cancel again.",
  deliveryMayHaveReached:
    "Delivery may already have reached TeamHub. Retry with the same idempotency key to reconcile it safely.",
  deliveryUnconfirmed:
    "TeamHub did not confirm whether this Message was committed. Retry checks the same intent.",
  deliveryInterrupted:
    "Delivery was interrupted. Retry to confirm whether this Message was sent.",
  saveLocallyStorageFull:
    "This Message could not be saved locally because browser storage is full. Free storage and retry.",
  saveLocallyFailed:
    "This Message could not be saved locally. Check browser storage and retry.",
  saveLocallyFailedDetail: "This Message could not be saved locally: {detail}",

  // The microphone when the composer starts voice input.
  microphoneInUse: "Another voice input is using the microphone",
  microphoneHardwareRecording: "Hardware recording is using the microphone",
  microphoneOtherTab: "The microphone is active in another tab",

  // External channel rooms synced from outside Linger (e.g. iMessage, WeChat).
  channelViewOnlyTitle: "View only",
  channelViewOnlyDescription:
    "Messages are synced from {channel}. Continue this conversation in {channel}.",
  channelIMessage: "iMessage",
  channelWeChat: "WeChat",
});
