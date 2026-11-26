import { defineMessages } from "@/i18n/messages";

/**
 * The web search key field, shared by Connectors and the chat's search key
 * card. Backend names are brands and stay as TeamHub sends them; their
 * descriptions are worded in web-search-backend-text.ts.
 */
export const webSearchMessages = defineMessages("webSearch", {
  apiKey: "{backend} API key",
  checkingKey: "Checking key...",
  saveKey: "Save key",
  // {site} is the key page as host and path, such as tavily.com/keys.
  getKeyAt: "Get a key at <link>{site}</link>",
  keyRejectedAt:
    "{backend} rejected this key. Check it at {site} and paste it again.",
  keyRejected: "{backend} rejected this key. Check it and paste it again.",
  keysUnavailable:
    "This server cannot store web search keys. Set <code>TEAMHUB_SECRET_ENCRYPTION_KEY</code> where it runs, then add the key here.",
});
