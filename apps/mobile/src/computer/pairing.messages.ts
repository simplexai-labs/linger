import { defineMessages } from "../i18n/messages";

export const computerPairingMessages = defineMessages("computerPairing", {
  inviteInvalid:
    "This pairing code was already used or is not valid. Create a new code on your computer.",
  expired: "This pairing code expired. Create a new code on your computer.",
  rateLimited: "Too many pairing attempts. Wait a minute and try again.",
  badHello:
    "Your computer did not accept this phone's request. Update Linger on both devices and try again.",
  unavailable: "Your computer could not pair right now. Try again in a moment.",
  notApproved:
    "Your computer did not approve this phone. Create a new code to try again.",
  unreachable:
    "Could not reach your computer. Check that it is on and that this phone is on the same Wi-Fi, or that Linger's relay is set up.",
});
