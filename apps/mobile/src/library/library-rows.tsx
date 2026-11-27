// The Library's rows, one shape per kind of content and the design system's
// navigation row for all of them: at least 56 high, r8, a 36px leading tile,
// flat on the canvas with the muted fill only while pressed.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import type { MemoryEntry, TeamHubDocument } from "../api/types";
import { FileTile } from "../chat/file-card";
import { useTranslation } from "../i18n/use-translation";
import { colors, radius, space, type } from "../theme";
import { Icon, type IconName } from "../ui/icon";
import { Text } from "../ui/text";
import { fileTypeLabel } from "./file-kind";
import { documentFileName, documentTitle, shortWhen } from "./library-items";
import { libraryRowsMessages as m } from "./library-rows.messages";
import type { WikiEntry } from "./wiki-pages";

const TILE = 36;

function GlyphTile(props: { readonly icon: IconName }) {
  return (
    <View style={styles.glyph}>
      <Icon name={props.icon} size={20} color={colors.secondary} />
    </View>
  );
}

function LibraryRow(props: {
  readonly leading: ReactNode;
  readonly title: string;
  readonly meta?: string;
  readonly snippet?: string;
  readonly trailing?: string;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {props.leading}
      <View style={styles.text}>
        <View style={styles.titleLine}>
          <Text style={styles.title} numberOfLines={1}>
            {props.title}
          </Text>
          {props.trailing ? (
            <Text style={styles.trailing}>{props.trailing}</Text>
          ) : null}
        </View>
        {props.meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {props.meta}
          </Text>
        ) : null}
        {props.snippet ? (
          <Text style={styles.meta} numberOfLines={1}>
            {props.snippet}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A recorded meeting: its title, the time it began and its summary's gist. */
export function MeetingRow(props: {
  readonly entry: MemoryEntry;
  readonly onPress: () => void;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const { entry } = props;
  const title = entry.title || t(m.meeting);
  const when = shortWhen(
    entry.meeting?.started_at ?? entry.updated_at,
    translation,
  );
  const snippet =
    entry.meeting && !entry.meeting.summary_ready
      ? t(m.writingSummary)
      : entry.summary.trim() || undefined;
  return (
    <LibraryRow
      leading={<GlyphTile icon="record" />}
      title={title}
      trailing={when}
      snippet={snippet}
      accessibilityLabel={[title, when, snippet].filter(Boolean).join(", ")}
      onPress={props.onPress}
    />
  );
}

/** A file or Document: its kind's tile in the category color, type and update. */
export function DocumentRow(props: {
  readonly document: TeamHubDocument;
  readonly onPress: () => void;
}) {
  const translation = useTranslation();
  const { document } = props;
  const filename = documentFileName(document, translation.t);
  const title = documentTitle(document, translation.t);
  const meta = `${fileTypeLabel(translation.t, filename)} · ${shortWhen(document.updated_at, translation)}`;
  return (
    <LibraryRow
      leading={<FileTile filename={filename} size={TILE} />}
      title={title}
      meta={meta}
      accessibilityLabel={`${title}, ${meta}`}
      onPress={props.onPress}
    />
  );
}

function sessionDay(date: string, language: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString(
    language,
    { weekday: "short", month: "short", day: "numeric" },
  );
}

/** A Wiki page: a page glyph, its reader title, and when it last changed. */
export function WikiRow(props: {
  readonly entry: WikiEntry;
  readonly onPress: () => void;
}) {
  const translation = useTranslation();
  const { entry } = props;
  const meta = entry.sessionDate
    ? sessionDay(entry.sessionDate, translation.language)
    : translation.t(m.updated, {
        when: shortWhen(entry.document.updated_at, translation),
      });
  return (
    <LibraryRow
      leading={<GlyphTile icon="page" />}
      title={entry.title}
      meta={meta}
      accessibilityLabel={`${entry.title}, ${meta}`}
      onPress={props.onPress}
    />
  );
}

export function LibrarySectionHeader(props: { readonly title: string }) {
  return (
    <Text style={styles.section} accessibilityRole="header">
      {props.title}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm + 2,
    borderRadius: radius.lg,
  },
  pressed: { backgroundColor: colors.surfaceSoft },
  glyph: {
    width: TILE,
    height: TILE,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  title: { ...StyleSheet.flatten(type.label), flex: 1 },
  trailing: { ...StyleSheet.flatten(type.caption) },
  meta: { ...StyleSheet.flatten(type.chatMeta) },
  section: {
    ...StyleSheet.flatten(type.sectionLabel),
    paddingHorizontal: space.sm,
    paddingTop: space.lg,
    paddingBottom: space.xs,
    backgroundColor: colors.canvas,
  },
});
