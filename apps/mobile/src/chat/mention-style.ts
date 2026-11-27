// How a mention reads in text, after the desktop's composer reference: the
// info blue on a faint tint of itself.
import { StyleSheet } from "react-native";

import { colors } from "../theme";

export const mentionStyle = StyleSheet.create({
  mention: {
    color: colors.info,
    backgroundColor: "rgba(9, 117, 206, 0.12)",
    fontWeight: "600",
  },
}).mention;

/** On the Human's own ink bubble the tint would vanish; a light blue reads. */
export const mentionOnInkStyle = StyleSheet.create({
  mention: { color: "#8cc4ff", fontWeight: "600" },
}).mention;
