import { defineMessages } from "@/i18n/messages";

export const authMessages = defineMessages("auth", {
  loginTitle: "Log in",
  loginSubtitle: "Welcome back to Linger.",
  interfaceLanguage: "Interface language",
  sessionExpired: "Your session has expired. Sign in again to continue.",
  localAccountSignIn: "Sign in with this computer's account",
  or: "or",
  email: "Email",
  password: "Password",
  showPassword: "Show password",
  hidePassword: "Hide password",
  signIn: "Sign in",
  logIn: "Log in",
  working: "Working...",
  artTitleFirst: "Your personal AI.",
  artTitleSecond: "A step ahead.",
  artLede:
    "Linger runs on your own computer, keeps track of your work, and reaches out before anything slips.",
  nudgeMorningTime: "9:00 AM",
  nudgeMorning: "Demo is tomorrow. I drafted the brief.",
  nudgeMiddayTime: "1:30 PM",
  nudgeMidday: "I reviewed the code. Two notes.",
  nudgeEveningTime: "5:00 PM",
  nudgeEvening: "Before you go: the deck is ready.",
  timedOut:
    "This step timed out. Try again. Your previous request may have completed.",
  sessionNotEstablished:
    "Linger could not establish a browser session. Use the secure workspace address or contact your workspace administrator.",
  invalidEmail: "Enter a valid email address.",
  desktopAccountUnavailable:
    "This computer's account could not be used. Log in with your email and password.",
  teamHubUnreachable: "TeamHub could not be reached. Try again.",
  logoutUnconfirmed: "Could not confirm logout. Please retry.",
  logoutUnsavedDocuments:
    "Some Document edits are not saved yet. Log out and discard them?",
});
