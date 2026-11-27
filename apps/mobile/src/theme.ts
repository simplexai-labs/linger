// The Linger design system (apps/web/src/app/visual-theme.css and
// globals.css): cream canvas, white cards, warm gray sidebar, near-black ink,
// layered with hairlines and faint shadows only where something floats.
// Color carries meaning only: links and mentions are info blue, states use
// their own colors, file kinds the category palette.
import { Platform, StyleSheet } from "react-native";

export const colors = {
  canvas: "#fdfdfc",
  surface: "#ffffff",
  surfaceSoft: "#f4f4f0",
  sidebar: "#f7f8f4",
  sidebarMuted: "#edeee8",
  ink: "#1a1a16",
  body: "#1a1a16",
  secondary: "#414038",
  muted: "#737266",
  placeholder: "rgba(26, 26, 22, 0.4)",
  border: "#ecece9",
  borderStrong: "#dbdcd5",
  /** Links, mentions, connect and authorize (--town-info). */
  accent: "#0975ce",
  accentPressed: "#08619f",
  accentSoft: "rgba(9, 117, 206, 0.12)",
  onAccent: "#ffffff",
  /** The gray pill behind small buttons (--secondary). */
  pill: "#f4f4f5",
  /** An Agent's reply: muted at 70% on the canvas (--chat-bubble-bg). */
  agentBubble: "#f7f7f4",
  action: "#1a1a16",
  onAction: "#ffffff",
  link: "#0975ce",
  danger: "#c6370c",
  dangerSoft: "rgba(198, 55, 12, 0.08)",
  warning: "#c77b00",
  warningSoft: "rgba(199, 123, 0, 0.1)",
  success: "#4e842e",
  successSoft: "rgba(78, 132, 46, 0.1)",
  info: "#0975ce",
  infoSoft: "rgba(9, 117, 206, 0.06)",
  /** The Linger mark's amber dot and its highlight: brand moments only. */
  brand: "#fda946",
  brandLight: "#ffc47e",
} as const;

/**
 * The Live stage, the one dark screen: a night canvas with white ink, quiet
 * white fills for controls and the Human's words.
 */
export const night = {
  canvas: "#1d2030",
  ink: "#ffffff",
  body: "rgba(255, 255, 255, 0.88)",
  muted: "rgba(255, 255, 255, 0.6)",
  faint: "rgba(255, 255, 255, 0.55)",
  fill: "rgba(255, 255, 255, 0.12)",
  ring: "rgba(255, 255, 255, 0.16)",
  danger: "#ff9a7a",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** 4 · 6 · 8 · 12 · 16 · pill; an inner radius never exceeds its outer one. */
export const radius = {
  /** Badges, menu items, inline code. */
  sm: 4,
  /** Inputs, default buttons, menus. */
  md: 6,
  /** Icon and large buttons, dialogs, navigation rows. */
  lg: 8,
  /** Cards, setting groups, bubbles, toasts. */
  xl: 12,
  /** Panels and the composer. */
  xxl: 16,
  pill: 999,
} as const;

/**
 * Only layers that float over content cast a shadow, bigger the higher they
 * sit; resting rows and containers use hairlines and fills.
 */
export const shadow = StyleSheet.create({
  /** Chat cards, lifted just off the conversation. */
  chatCard: {
    shadowColor: "#1a1a16",
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  /** Menus, dropdowns and the composer. */
  md: {
    shadowColor: "#1a1a16",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  /** Dialogs, toasts, the focused composer. */
  lg: {
    shadowColor: "#1a1a16",
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
});

/** The smallest comfortable touch target. */
export const touchTarget = 44;

export const type = StyleSheet.create({
  /** Page titles: 24 at 580, tightened. */
  title: {
    fontSize: 24,
    lineHeight: 34,
    fontWeight: "600",
    color: colors.ink,
    letterSpacing: -0.6,
  },
  heading: { fontSize: 20, fontWeight: "600", color: colors.ink },
  /** A screen's bar title, the Agent's name on its stage. */
  headline: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: colors.ink,
  },
  /** Controls, tabs and dialog text (text-sm). */
  ui: { fontSize: 14, lineHeight: 20, color: colors.secondary },
  /** A group's label above its rows. */
  sectionLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    color: colors.muted,
  },
  /** Messages and a card's main text (--chat-card-text-size). */
  chat: { fontSize: 15, lineHeight: 22, color: colors.body },
  /** A card's secondary line and quotes (--chat-card-meta-size). */
  chatMeta: { fontSize: 13, lineHeight: 18, color: colors.muted },
  body: { fontSize: 16, lineHeight: 23, color: colors.body },
  label: { fontSize: 15, fontWeight: "500", color: colors.ink },
  small: { fontSize: 13, lineHeight: 18, color: colors.muted },
  caption: { fontSize: 12, color: colors.muted },
  mono: {
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 13,
    lineHeight: 18,
    color: colors.secondary,
  },
});
