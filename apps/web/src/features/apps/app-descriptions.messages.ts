import { defineMessages } from "@/i18n/messages";

/**
 * TeamHub's longer description of each catalog app, worded by app key for
 * the manage dialog, where import limits and scope matter.
 */
export const appDescriptionMessages = defineMessages("appDescriptions", {
  mail: "Import the last six months, up to 3,000 messages, for Profile and Wiki.",
  googleDrive: "Let Agents work with your Drive files.",
  slack: "Connect workspaces and selected channels.",
  discord: "Connect one installed Discord server and selected channels.",
  facebook: "Connect supported Facebook content.",
  github:
    "Import a public profile and selected owned repositories, and let authorized Agents read repositories, issues, and pull requests.",
  googleMeet: "Connect available Google Meet records.",
  googleCalendar: "Connect calendars and import selected events.",
  notion:
    "Connect Notion to generate your profile and let authorized Agents use shared pages and databases.",
  linear: "Let Agents work with your Linear issues and projects.",
  figma: "Let Agents work with your Figma files.",
  canva: "Let Agents work with your Canva designs.",
  higgsfield: "Let Agents generate images and videos with Higgsfield.",
  falAi: "Let Agents run generative media models on fal.ai.",
  granola: "Let Agents read your Granola meeting notes and transcripts.",
  calendly:
    "Let Agents work with your Calendly event types and scheduled events.",
  outlookCalendar: "Let Agents work with your Outlook calendars and events.",
  feishuMail:
    "Let your Another Me read and send your Feishu or Lark mail through lark-cli on your Computer; new mail syncs to your Wiki each night.",
});
