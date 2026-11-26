import { defineMessages } from "@/i18n/messages";

/** The dialogs the Messages list opens: create a Room, delete a Room, remove an Agent. */
export const roomDialogMessages = defineMessages("roomDialogs", {
  createRoom: "Create Room",
  defaultRoomName: "New Room",
  defaultRoomNameNumbered: "New Room {number}",
  createFailed: "Couldn't create the Room",
  defaultNamesTaken:
    "Every default Room name is in use. Rename a Room called New Room, then try again.",
  nameTaken: "You already have a Room with this name. Choose a different name.",
  createUnconfirmed:
    "TeamHub did not confirm whether this Room was created. Check your Rooms before you retry.",
  deleteRoom: "Delete Room",
  deleteRoomDescription:
    "<name>{name}</name> will be deleted. Every member will lose access to this Room. Its messages, files, and history will no longer be available.",
  deleteDirectRoomDescription:
    "<name>{name}</name> will be deleted. Its messages, files, and history will no longer be available.",
  deleteUnconfirmed:
    "TeamHub did not confirm whether this Room was deleted. Check your Rooms before you retry.",
  removeAgentTitle: "Remove {name}?",
  removeAgentDescription:
    "The Agent will be removed from every Room and your direct chat with it will be deleted. Messages in shared Rooms stay available.",
  removeAgent: "Remove Agent",
});
