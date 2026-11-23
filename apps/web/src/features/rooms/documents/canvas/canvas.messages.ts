import { defineMessages } from "@/i18n/messages";

export const canvasMessages = defineMessages("canvas", {
  // Header.
  canvasLabel: "{target} canvas",
  agentEditing: "Agent is editing…",
  subject: "Subject",
  from: "From",
  to: "To",
  cc: "Cc",
  addRecipients: "Add recipients",
  sent: "Sent",
  draftSaved: "Draft saved",
  none: "None",

  // Email status and sender.
  emailStatus: "Email status",
  saved: "Saved",
  drafting: "Drafting",
  connectedMailAccount: "Connected {app} account",
  mailAccount: "{app} account",

  // Sending.
  preparing: "Preparing…",
  uploadingToMail: "Uploading to {app}…",
  sending: "Sending…",
  connectMailBeforeSending: "Connect {app} before sending.",
  emailStillLoading: "The email is still loading.",
  emailChanged: "The email changed. Review it and send again.",
  connectMailToSend: "Connect {app} to send",
  saving: "Saving…",

  // Attachments.
  emailAttachments: "Email attachments",
  chooseAttachments: "Choose attachments",
  addAttachments: "Add attachments",
  attachment: "Attachment",
  removeAttachment: "Remove {name}",
  removeUnnamedAttachment: "Remove attachment",
  uploadingAttachments: "Uploading attachments…",
  emptyAttachment: "Empty files cannot be attached.",
  attachmentsTooLarge: "Attachments must total {megabytes} MB or less.",
  emailNotEditable: "The email is no longer available for editing.",
  attachFailed: "Could not attach the file. Try again.",
  attachmentUnavailable: "The attachment is not available for download.",
  attachmentDownloadFailed: "Could not download the attachment.",
});
