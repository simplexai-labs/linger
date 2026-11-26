import { defineMessages } from "@/i18n/messages";

/** An Agent's Runtime settings, and what moving it to another Computer does. */
export const agentRuntimeMessages = defineMessages("agentRuntime", {
  title: "Runtime settings",
  moveAgent: "Move Agent",
  saveRuntime: "Save Runtime",
  computer: "Computer",
  computerLabel: "Agent computer",
  chooseComputer: "Choose a computer",
  computerOnline: "{name} · Online",
  computerOffline: "{name} · Offline",
  computerOnlineUpgrade: "{name} · Online · Upgrade required",
  computerOfflineUpgrade: "{name} · Offline · Upgrade required",
  runtime: "Runtime",
  runtimeLabel: "Agent runtime",
  chooseRuntime: "Choose a runtime",
  runtimeNotReady: "{runtime} · {status}",
  model: "Model",
  modelLabel: "Agent model",
  noModels: "No models available",
  unavailableOption: "{name} · Unavailable",
  reasoning: "Reasoning",
  reasoningLabel: "Agent reasoning effort",
  waitForAgent: "Wait for this Agent to finish before saving changes.",
  moveHint: "Local files stay on the old computer.",
  noWritableWorkspace:
    "This computer has no writable workspace. Choose another computer.",
  currentModelUnavailable:
    "The current model is unavailable. Choose another model.",
  noRuntimeModels: "No models are available for this runtime.",
  optionsUnavailable: "Runtime options are unavailable.",
  installAndSignIn:
    "Install and sign in to this runtime on the computer, then wait for it to become ready.",
  missingDefault:
    "{runtime} isn't ready on {computer}. Choose another Runtime.",
  missingDefaultAnywhere:
    "{runtime} isn't ready on any other computer. Choose another Runtime.",
  targetKeeps: "Keeps {summary}.",
  targetUses: "Uses {summary}.",
  targetUsesModelMissing: "Uses {summary}. {model} isn't available there.",
  targetUsesReasoningWas: "Uses {summary}. Reasoning was {effort}.",
});
