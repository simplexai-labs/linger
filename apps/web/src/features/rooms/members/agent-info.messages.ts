import { defineMessages } from "@/i18n/messages";

import { UNSET_AGENT_INSTRUCTIONS } from "./agent-instruction-text";

/** The Agent info panel, its edit dialogs, and a Human's profile panel. */
export const agentInfoMessages = defineMessages("agentInfo", {
  // The panel's tabs and the identity header.
  settingsTabs: "Agent settings",
  tabDetails: "Details",
  tabRoutines: "Routines",
  tabConnectors: "Connectors",
  routinesNeedRoom: "Open this Agent from a Room to see its routines there.",
  editAvatar: "Edit avatar",
  agentName: "Agent name",
  editName: "Edit name {name}",

  // The status line and the avatar's status popover.
  online: "Online",
  tasksInProgress: {
    one: "{count} task in progress",
    other: "{count} tasks in progress",
  },
  openStatus: "Open {name} status",
  openProfile: "Open {name} profile",
  viewActivity: "View activity",

  // Instructions.
  instructions: "Instructions",
  agentInstructions: "Agent instructions",
  editInstructions: "Edit instructions",
  instructionsContent: "Instructions content",
  instructionsUnset: UNSET_AGENT_INSTRUCTIONS,
  showMore: "Show more",
  showLess: "Show less",

  // Where the Agent runs.
  runtimeConfiguration: "Runtime configuration",
  runsOn: "Runs on",
  runsOnLocal: "Local · {computer}",
  runsOnLocalOnline: "Local · {computer} · Online",
  runsOnLocalOffline: "Local · {computer} · Offline",
  localComputer: "Local Computer",
  modelWithEffort: "{model} · {effort}",
  runtimeDetails: "Runtime details",
  runtimeStatus: "<term>Status:</term> <value>{status}</value>",
  runtimeVersion: "<term>Version:</term> <value>{version}</value>",
  runtimeBusy: "Runtime settings can't change while this Agent is working.",
  agentActions: "Agent actions",
  profileUnavailable: "Agent profile is unavailable.",

  // The avatar editor and the profile dialog.
  chooseAvatar: "Choose avatar",
  avatars: "Avatars",
  avatarOption: "Avatar {number}",
  uploadImage: "Upload image",
  avatarImageFile: "Avatar image file",
  avatarBackgroundColor: "Avatar background color",
  avatarUnusable: "This image could not be used. Try a JPEG, PNG, or WebP.",
  editProfile: "Edit profile",
  editAgentName: "Edit agent name",
  avatarSaveFailed: "The avatar could not be saved. Try again.",

  // The Agent's activity list in the side panel.
  activityHistory: "Agent activity history",
  recentActivity: "Recent activity in this conversation",
  viewAgentActivity: "View {name} activity: {prompt}",
  noRecentActivity: "No recent activity",
  activityPages: "Activity pages",
  previous: "Previous",
  next: "Next",

  // A Human's profile panel.
  profileLabel: "{name} profile",
  closeProfile: "Close profile",
  noPublicHandle: "No public handle",
  handleMember: "{handle} · Member",
  human: "Human",
  agent: "Agent",
  noDescription: "No description",
  role: "Role",
  joined: "Joined",
  createdAgents: "Created Agents",
  noCreatedAgents: "No created Agents.",
});
