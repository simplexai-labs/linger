import { defineMessages } from "../i18n/messages";

export const voiceAudioMessages = defineMessages("voiceAudio", {
  permissionTitle: "Allow the microphone",
  permissionBody:
    "Linger sends what you say through the encrypted session to your own computer, which transcribes it. The phone keeps a meeting recording only until your computer has it.",
  notNow: "Not now",
  continue: "Continue",
  deniedTitle: "Microphone access is off",
  deniedBody:
    "Turn on microphone access for Linger in Settings to dictate, talk live or record meetings.",
  cancel: "Cancel",
  openSettings: "Open Settings",
  notificationTitle: "Linger is recording",
  notificationBody: "The meeting goes to your computer as you speak.",
});
