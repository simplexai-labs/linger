// Geist, the web's interface face, at the design system's four weights
// (scripts/export-fonts.py pins them from the web's variable font). Each
// weight is its own family so no platform fakes a bold.
/* eslint-disable @typescript-eslint/no-require-imports */
export const GEIST_FONTS = {
  "Geist-Regular": require("../../assets/fonts/Geist-Regular.ttf"),
  "Geist-Medium": require("../../assets/fonts/Geist-Medium.ttf"),
  "Geist-SemiBold": require("../../assets/fonts/Geist-SemiBold.ttf"),
  "Geist-Bold": require("../../assets/fonts/Geist-Bold.ttf"),
};
