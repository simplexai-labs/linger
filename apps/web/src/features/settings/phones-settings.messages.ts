import { defineMessages } from "@/i18n/messages";

export const phonesMessages = defineMessages("phones", {
  description:
    "Use Linger on your phone. Your phone talks to this computer directly at home and through a Relay node elsewhere; your data stays on this computer.",
  pairPhone: "Pair a phone",
  listLabel: "Paired phones",
  empty: "No phones yet.",
  iphone: "iPhone",
  android: "Android",
  connectedNow: "Connected now",
  lastSeen: "Last seen {time}",
  pushOn: "Push on",
  pushOff: "Push off",
  removePhone: "Remove {name}",
  removeTitle: "Remove {name}?",
  removeDescription: "It disconnects at once and must be paired again.",
  paired: "{name} is paired.",
  creatingCode: "Creating a pairing code",
  qrLabel: "Pairing code",
  scanHint:
    "Open Linger on your phone and scan this code. The code works once and for 10 minutes.",
  computer: "Pairs with {name}",
  expiresIn: "Expires in {time}",
  expired: "This code has expired.",
  newCode: "New code",
  noRelay:
    "No relay is set up, so your phone can reach this computer only on the same Wi‑Fi.",
  unreachable: "This computer cannot accept phones right now.",
  mobileUnavailable: "Phones need a private secret seed on this server.",
  copyLink: "Copy pairing link",
  linkCopied: "Link copied",
  confirmTitle: "Is this your phone?",
  confirmHint:
    "Approve only if your phone shows the same code. Until then it can do nothing.",
  confirmCodeLabel: "Confirmation code",
  approve: "Approve",
  reject: "Not my phone",
  waitingApproval: "Waiting for approval",
  keepOpenHint:
    "Keep Linger set to open at login so your phone can reach this computer after a restart.",
  relaysTitle: "Relay nodes",
  relaysDescription:
    "Away from this computer's network, phones connect through a Relay node and pick the fastest one themselves. This computer links to every node that is on; each forwards only end-to-end encrypted data.",
  relayOfficial: "Official",
  relayCustom: "Custom",
  relayConnected: "Linked",
  relayConnecting: "Linking",
  relayOff: "Off",
  relayToggle: "Use {name}",
  removeRelay: "Remove {name}",
  relayUrlLabel: "Add a node",
  addRelay: "Add",
  invalidRelayUrl:
    "Enter a ws:// or wss:// address with no path, such as ws://203.0.113.7:7787.",
  relayExists: "This node is already listed.",
  tooManyRelays: "Remove a node you added before adding another.",
  relayLinksOff:
    "This computer keeps no Relay link: TEAMHUB_MOBILE_RELAY_URL is set empty, or it runs on the public development seed. Phones reach it on the same Wi-Fi only.",
});
