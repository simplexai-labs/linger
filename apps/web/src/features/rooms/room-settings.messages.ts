import { defineMessages } from "@/i18n/messages";

/**
 * Room settings in the side panel: the Room's details, its members, adding
 * members after creating a Room, sharing a conversation and leaving.
 */
export const roomSettingsMessages = defineMessages("roomSettings", {
  loading: "Loading Room settings...",
  loadFailed: "Room settings could not be loaded.",
  editDetails: "Edit Room details",
  members: "Members",
  loadingMembers: "Loading members...",
  shareConversation: "Share conversation",
  leaveRoom: "Leave Room",
  leaveDescription:
    "You will stop receiving messages from this room and cannot send messages until you rejoin. Your role, existing access and message history stay the same. You can rejoin at any time.",
  leave: "Leave",

  name: "Name",
  description: "Description",
  roomDescription: "Room description",
  descriptionPlaceholder: "What is this Room for?",
  saveChanges: "Save changes",
  deleteDescription: "Deleting this Room revokes access for every member.",
  saveUnconfirmed:
    "TeamHub did not confirm whether these Room changes were committed. Check the Room settings before you retry.",

  roomMembers: "Room members",
  // The tag on an Agent the person looking at the list created.
  yours: "Yours",
  roleOwner: "owner",
  roleMember: "member",
  removeMember: "Remove {name}",
  removeMemberTitle: "Remove {name}?",
  removeMemberDescription: "They will lose access to this Room.",
  addMember: "Add member",
  addRoomMember: "Add Room member",
  agentsUnavailable: "Your agents are unavailable",
  loadingAgents: "Loading your agents...",
  everyoneAdded: "Every Tenant Actor is already in this Room.",

  addRoomMembers: "Add Room members",
  skipForNow: "Skip for now",
  addMembers: "Add members",
  addFailed:
    "Could not add {names}. Retry these members; successful additions are already saved.",

  chooseExisting: "Choose existing members",
  roomOwner: "Room owner",
  // Read out after the owner's name in the list of chosen members.
  youOwner: "(you, owner)",
  chooseMembers: "Choose members",
  searchMembers: "Search members",
  searchMembersPlaceholder: "Search members...",
  membersLoadFailed: "Some members could not be loaded.",
  noMatchingMembers: "No matching members.",

  shareNotice:
    "Anyone with the link can read messages sent up to now, without signing in. New messages and later changes are not included. Files appear as cards; source documents stay private.",
  conversationLink: "Conversation link",
  copyConversationLink: "Copy conversation link",
  selectToCopy: "Select the link above to copy it.",
  creatingSnapshot: "Creating snapshot...",
  createShareLink: "Create share link",
  sharedSnapshots: "Shared snapshots",
  sharedSnapshotsHint:
    "Each item is a frozen copy of the conversation at that time.",
  loadingSnapshots: "Loading shared snapshots...",
  snapshotsLoadFailed: "Shared snapshots could not be loaded.",
  messageCount: { one: "{count} message", other: "{count} messages" },
  openSharedLink: "Open shared link",
  openSharedLinkFrom: "Open shared link from {date}",
  revoke: "Revoke",
  revoked: "Revoked",
});
