import { defineMessages } from "@/i18n/messages";

/** Settings › Channels: network IM channel connections for Another Me. */
export const channelsMessages = defineMessages("channels", {
  title: "Channels",
  description:
    "Chat with Another Me from your messaging apps. Each channel syncs in its own isolated Room.",
  unavailable:
    "Server-side channels (such as WeChat) are unavailable in this deployment. Configure LINGER_SECRET_SEED and start Node Services with the channels role.",
  loadFailed: "Could not load channel settings. Refresh to try again.",
  wechatName: "WeChat",
  wechatDescription:
    "Connect your personal WeChat through ClawBot (iLink). Supports text messages, WeChat voice transcripts, and numbered question replies.",
  upcomingTitle: "More channels",
  upcomingDescription:
    "WhatsApp Agents, Telegram, Discord, and Slack share the same server-side channel runtime and can be added here next.",
  connectWeChat: "Connect WeChat",
  reconnectWeChat: "Reconnect",
  disconnect: "Disconnect",
  disconnecting: "Disconnecting…",
  pause: "Pause",
  resume: "Resume",
  statusConnected: "Connected",
  statusStarting: "Connecting…",
  statusCooldown: "Paused (rate limit)",
  statusConflict: "Connection conflict",
  statusAuthExpired: "Sign-in expired",
  statusDisconnected: "Paused",
  statusError: "Connection error",
  statusNotConnected: "Not connected",
  accountLabel: "Linked account: {id}",
  errorCooldown:
    "WeChat paused this session for one hour (errcode -14). Linger will resume automatically.",
  errorConflict:
    "Another client is polling the same WeChat bot token. Stop other instances or reconnect.",
  errorNoAnotherMe: "Create your Another Me first before chatting from WeChat.",
  errorGeneric: "WeChat connection hit an error. Reconnect if it persists.",
  actionFailed: "That channel action could not be completed. Try again.",
  pairingTitle: "Connect WeChat",
  pairingDescription:
    "Scan this QR code with WeChat on your phone to link your personal ClawBot to Another Me.",
  pairingStarting: "Generating WeChat QR code…",
  pairingWaitingScan: "Waiting for you to scan the QR code in WeChat…",
  pairingScanned: "Scanned. Confirm the connection on your phone…",
  pairingNeedVerifyCode:
    "Enter the verification code shown in WeChat on your phone:",
  pairingVerifyPlaceholder: "Verification code",
  pairingVerifySubmit: "Verify",
  pairingVerifySubmitting: "Verifying…",
  pairingVerifyBlocked:
    "Too many invalid codes. Generate a fresh QR code to try again.",
  pairingExpired: "The QR code expired.",
  pairingFailed:
    "Could not finish WeChat pairing. Try generating a new QR code.",
  pairingConfirmed: "WeChat connected.",
  pairingAlreadyConnected: "This WeChat bot is already connected.",
  pairingRefresh: "Refresh QR code",
  pairingCopyLink: "Copy pairing link",
  pairingLinkCopied: "Copied",
  qrAlt: "WeChat pairing QR code",
  close: "Close",
});
