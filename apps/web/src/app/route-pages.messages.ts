import { defineMessages } from "@/i18n/messages";

/** Pages a route falls back to: the unknown address and the loading error. */
export const routePagesMessages = defineMessages("routePages", {
  loadingLinger: "Loading Linger…",
  notFoundTitle: "Page not found",
  openMessages: "Open Messages",
  goToLogin: "Go to Log in",
  loadingError: "TeamHub loading error",
  rooms: "Rooms",
  roomNavigation: "Room navigation",
  backToRoomsHint: "Use “Back to my Rooms” to return to your conversations.",
  backToRooms: "Back to my Rooms",
  roomRestrictedTitle: "This Room is not available to you",
  pageRestrictedTitle: "This page is not available to you",
  restrictedBody:
    "You may not have access, or it may have been deleted. Check that you are signed in to the right account, or ask the person who shared this link to invite you.",
  loadFailedBody: "The requested TeamHub data could not be loaded.",
  teamHubUnavailableTitle: "TeamHub unavailable",
  viewLoadFailedTitle: "This view could not be loaded",
});
