// Markdown rendered as native text (react-native-enriched-markdown needs
// Fabric, which Expo 58 always runs). Links open outside the app; there are
// no web views.
import { Linking } from "react-native";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from "react-native-enriched-markdown";

import { colors } from "../theme";

/** The design system's document scale: H1 26, H2 22, H3 18, body 15. */
const documentStyle: MarkdownStyle = {
  paragraph: {
    fontFamily: "Geist-Regular",
    fontSize: 15,
    lineHeight: 24,
    color: colors.body,
    marginBottom: 10,
  },
  h1: {
    fontFamily: "Geist-SemiBold",
    fontSize: 26,
    fontWeight: "600",
    color: colors.ink,
    marginTop: 12,
    marginBottom: 8,
  },
  h2: {
    fontFamily: "Geist-SemiBold",
    fontSize: 22,
    fontWeight: "600",
    color: colors.ink,
    marginTop: 10,
    marginBottom: 6,
  },
  h3: {
    fontFamily: "Geist-SemiBold",
    fontSize: 18,
    fontWeight: "600",
    color: colors.ink,
    marginTop: 8,
    marginBottom: 4,
  },
  link: { color: colors.link },
  list: { fontFamily: "Geist-Regular", fontSize: 15, color: colors.body },
  code: { color: colors.secondary, backgroundColor: colors.surfaceSoft },
  codeBlock: {
    fontSize: 13,
    color: colors.secondary,
    backgroundColor: colors.surfaceSoft,
  },
  blockquote: { color: colors.secondary, borderColor: colors.borderStrong },
};

/** Inside a chat bubble: message text 15/22, headings only a step up. */
const chatStyle: MarkdownStyle = {
  ...documentStyle,
  paragraph: {
    fontFamily: "Geist-Regular",
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
    marginBottom: 6,
  },
  h1: {
    fontFamily: "Geist-SemiBold",
    fontSize: 18,
    fontWeight: "600",
    color: colors.ink,
    marginTop: 4,
    marginBottom: 4,
  },
  h2: {
    fontFamily: "Geist-SemiBold",
    fontSize: 16,
    fontWeight: "600",
    color: colors.ink,
    marginTop: 4,
    marginBottom: 4,
  },
  h3: {
    fontFamily: "Geist-SemiBold",
    fontSize: 15,
    fontWeight: "600",
    color: colors.ink,
    marginTop: 4,
    marginBottom: 2,
  },
};

function openLink(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void Linking.openURL(url);
}

export function Markdown(props: {
  readonly text: string;
  readonly variant?: "document" | "chat";
}) {
  return (
    <EnrichedMarkdownText
      markdown={props.text}
      markdownStyle={props.variant === "chat" ? chatStyle : documentStyle}
      onLinkPress={(event) => openLink(event.url)}
      selectable
      allowTrailingMargin={false}
    />
  );
}
