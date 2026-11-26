import { defineMessages } from "@/i18n/messages";

/** Shared UI controls: color palette sliders, secret field toggle, and unsaved changes guard. */
export const uiExtrasMessages = defineMessages("uiExtras", {
  // {name} is the palette's own name, such as Avatar background color.
  paletteField: "{name} saturation and brightness",
  paletteFieldValue: "{saturation}% saturation, {brightness}% brightness",
  paletteHue: "{name} hue",
  showValue: "Show value",
  maskValue: "Mask value",
  discardUnsavedTitle: "Discard unsaved changes?",
  discardUnsavedDescription:
    "You have unsaved changes. Leave this page and discard them?",
  discardChanges: "Discard",
});
