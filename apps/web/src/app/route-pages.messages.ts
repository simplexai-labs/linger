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
  backToRooms: "Back to my Rooms",
  roomRestrictedTitle: "This Room is not available to you",
  pageRestrictedTitle: "This page is not available to you",
  restrictedBody: "You may not have access, or it was deleted.",
  loadFailedBody: "Check your connection and try again.",
  teamHubUnavailableTitle: "Can't reach Linger",
  viewLoadFailedTitle: "Couldn't load this page",
});
