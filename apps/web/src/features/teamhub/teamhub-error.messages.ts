import { defineMessages } from "@/i18n/messages";

/**
 * What a failed TeamHub request tells the person when TeamHub's code or the
 * response status says all there is to say. Other codes keep TeamHub's own
 * message.
 */
export const teamHubErrorMessages = defineMessages("teamHubErrors", {
  invalidCredentials: "Email or password is incorrect.",
  unauthenticated: "Your sign-in has expired. Sign in again.",
  rateLimited: "Too many requests. Wait a moment and try again.",
  unavailable: "The server is temporarily unavailable. Try again shortly.",
  internal: "Something went wrong on the server. Try again.",
  computerOffline: "The computer is offline.",
  refused: "The server refused this request. Reload the page and try again.",
  notCompleted:
    "The server could not complete this request ({status}). Try again.",
  unreachable:
    "Couldn't reach the server. Check your connection and try again.",
});
