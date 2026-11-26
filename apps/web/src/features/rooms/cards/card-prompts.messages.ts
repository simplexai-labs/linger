import { defineMessages } from "@/i18n/messages";

/**
 * The asks TeamHub writes on the cards it posts for an Agent, worded on the
 * client from the card's kind and fields.
 */
export const cardPromptsMessages = defineMessages("cardPrompts", {
  profileSetupApps:
    "Before I help with replies and follow-ups, I'd like to get to know you. The quickest way is to let me see where you talk about work — one account is enough.",
  profileSetupSources:
    "Do you have a personal website or portfolio? Paste a link, or upload your resume and work samples.",
  connectionAuth:
    "Please connect and authorize your {app} account so I can continue.",
  connectionAuthAccount:
    "Please connect and authorize the {app} account {account} so I can continue.",
  providerKey: "Please add a Composio API key so I can use connected apps.",
  providerKeyApp: "Please add a Composio API key so I can connect {app}.",
  searchKeyMissing: "Please add a {backend} API key so I can search the web.",
  searchKeyRejected:
    "{backend} refused the saved API key. Please add a new key so I can search the web.",
  searchKeyFreeLimit:
    "The free {backend} trial is used up. Please add a {backend} API key so I can keep searching.",
  searchKeyFreeLimitSuggested:
    "The free web search trial is used up. Please add a web search API key so I can keep searching; {backend} is suggested.",
  browserConnection:
    "Please connect your everyday Chrome so I can continue the browser task. The extension token goes only to your Computer.",
  computerPermission: "System permission needed on your Mac",
  roomCreation: "Request to create a collaboration Room: {name}",
  agentCreate: "Create Agent “{name}”",
  agentChange: "Change Agent “{name}”",
});
