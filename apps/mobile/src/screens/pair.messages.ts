import { defineMessages } from "../i18n/messages";

export const pairMessages = defineMessages("pair", {
  newerVersion:
    "This pairing code is from a newer Linger. Update this app and try again.",
  notAPairingCode:
    "That is not a Linger pairing code. Open Settings, then Phones on your computer to show one.",
  unreadable: "That code could not be read. Try scanning it again.",
  stoppedUnexpectedly: "Pairing stopped unexpectedly. Try again.",
  cancel: "Cancel",
  title: "Pair with your computer",
  lead: "Linger on this phone talks to your own computer, end-to-end encrypted.",
  stepOpenSettings:
    "On your computer, open Linger, then Settings, then Phones.",
  stepPairPhone: "Choose Pair a phone.",
  stepPoint: "Point this phone at the code it shows.",
  viewfinder: "Camera viewfinder for the pairing code",
  cameraOff:
    "Camera access is off for Linger. Turn it on in the system settings to scan the code.",
  cameraUse: "Linger uses the camera only to scan the pairing code.",
  allowCamera: "Allow camera",
  connecting: "Connecting to {name}…",
  confirmationCode: "Confirmation code",
  confirmationCodeSpoken: "Confirmation code {digits}",
  checkCode:
    "Check that your computer shows the same code, then approve this phone there.",
  paired: "Paired.",
  reconnecting: "Reconnecting to {name}…",
  opening: "Paired. Opening Linger…",
  scanAgain: "Scan again",
  linkToggle: "Can't scan? Use a pairing link",
  linkHelp:
    "Under the code on your computer, choose Copy pairing link. Open the link on this phone, or paste it here.",
  linkLabel: "Pairing link",
  pair: "Pair",
});
