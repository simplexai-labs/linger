import { defineMessages } from "@/i18n/messages";

/**
 * The frame of the Room side panel: its tab strip, the "Add panel view" menu,
 * the launcher shown when no tab is open, and the loading and error states
 * around a panel. What each panel shows inside is declared with that panel.
 */
export const sidePanelMessages = defineMessages("sidePanel", {
  panelSidebar: "Panel sidebar",
  resizeSidebar: "Resize sidebar",
  dragToResize: "Drag to resize",
  panelTabs: "Panel tabs",
  addPanelView: "Add panel view",
  maximizeSidebar: "Maximize sidebar",
  restoreSidebar: "Restore sidebar",
  reopenClosedTab: "Reopen closed tab",
  closeTab: "Close {title}",
  // Tab titles. A tab is saved with a name only; these word it on screen.
  agentTab: "Agent · {name}",
  activityTab: "Activity · {name}",
  agentFallbackName: "Agent",
  filesTab: "Files",
  roomInfo: "Room info",
  collaboration: "Collaboration",
  untitledTab: "Untitled",
  // The "Add panel view" menu and the launcher.
  documents: "Documents",
  agentInfo: "Agent info",
  launcherTitle: "Conversation details",
  launcherBodyWithAgent:
    "Agent settings, routines, activity, and shared documents — alongside your chat.",
  launcherBody: "Shared documents and message threads — alongside your chat.",
  agentInfoHint: "{name} · Settings & activity",
  sharedDocumentCount: {
    one: "{count} shared document",
    other: "{count} shared documents",
  },
  browseSharedFiles: "Browse files shared in this conversation",
  collaborationHint: "Agent responsibilities and relationships",
  launcherFooter:
    "Open a message thread, document, or routine to view it here. Your chat stays in place.",
  // Loading and error states around a panel.
  loadingTask: "Loading task",
  loadingCollaboration: "Loading collaboration",
  loadingFile: "Loading file",
  loadingActivity: "Loading activity",
  taskLoadFailedTitle: "Task could not be loaded",
  taskLoadFailedBody: "The complete Room history could not be loaded.",
  taskLoadingTitle: "Loading Task",
  taskLoadingBody: "Looking through the Room history...",
  messageGoneTitle: "This message no longer exists",
  messageGoneBody: "This Message is not available in the current Room history.",
  activityLoadFailed: "Activity history could not be loaded.",
  agentActivityRegion: "{name} activity",
  backToActivity: "Back to Activity",
  loadEarlierActivity: "Load earlier activity",
  retryEarlierActivity: "Retry loading earlier activity",
  // The Anotherme draft panel.
  greeting: "Good afternoon",
  greetingWithName: "Good afternoon, {name}",
  attachToAnotherme: "Attach to Anotherme message",
  attach: "Attach",
  messageAnotherme: "Message Anotherme",
  sendAnothermeMessage: "Send Anotherme message",
  send: "Send",
  // Room info. The section and kind names are capitalized by the style sheet.
  editRoom: "Edit Room",
  memberCount: { one: "{count} member", other: "{count} members" },
  roomInfoSections: "Room info sections",
  sectionAgents: "agents",
  sectionFiles: "files",
  kindAgent: "agent",
  kindHuman: "human",
  noMembers: "No members",
  noRoomFiles: "No Room files",
});
