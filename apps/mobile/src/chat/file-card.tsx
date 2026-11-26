// A file in a message, drawn like the desktop's: a tile in the file kind's
// color, the name, its type and size, and a chevron that says it opens. An
// image shows itself instead.
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";

import { downloadDocumentVersion } from "../api/teamhub";
import type { MessageAttachment } from "../api/types";
import {
  fileKind,
  fileSize,
  fileTypeLabel,
  viewerFor,
  type FileKind,
} from "../library/file-kind";
import { useTranslation } from "../i18n/use-translation";
import { toBase64 } from "../lib/bytes";
import { teamHubKey, useTeamHub } from "../state/queries";
import { colors, radius, shadow, space, type } from "../theme";
import { PressScale } from "../ui/press-scale";
import { Icon, type IconName, type IconSize } from "../ui/icon";
import { Text } from "../ui/text";
import { chatFileMessages as m } from "./file-card.messages";

/**
 * The web's file type icons and category colors
 * (apps/web/src/features/library/workspace-file-icon.tsx): the 500 shade
 * for the icon, the same color at 15% behind it where a tile is drawn.
 */
const tones: Record<FileKind, { icon: IconName; color: string; tint: string }> =
  {
    pdf: { icon: "filePdf", color: "#d95b31", tint: "rgba(217,91,49,0.15)" },
    presentation: {
      icon: "fileSlides",
      color: "#b88022",
      tint: "rgba(184,128,34,0.15)",
    },
    document: {
      icon: "fileDoc",
      color: "#698cc7",
      tint: "rgba(105,140,199,0.15)",
    },
    spreadsheet: {
      icon: "fileSheet",
      color: "#5e9662",
      tint: "rgba(94,150,98,0.15)",
    },
    code: {
      icon: "fileCode",
      color: "#a17cb9",
      tint: "rgba(161,124,185,0.15)",
    },
    markdown: {
      icon: "fileCode",
      color: "#a17cb9",
      tint: "rgba(161,124,185,0.15)",
    },
    html: {
      icon: "fileCode",
      color: "#a17cb9",
      tint: "rgba(161,124,185,0.15)",
    },
    image: {
      icon: "fileImage",
      color: "#df5583",
      tint: "rgba(223,85,131,0.15)",
    },
    audio: {
      icon: "fileAudio",
      color: "#509578",
      tint: "rgba(80,149,120,0.15)",
    },
    video: {
      icon: "fileVideo",
      color: "#4e9ba2",
      tint: "rgba(78,155,162,0.15)",
    },
    archive: {
      icon: "fileArchive",
      color: "#a08e00",
      tint: "rgba(160,142,0,0.15)",
    },
    text: { icon: "file", color: colors.muted, tint: colors.surfaceSoft },
  };

/** Images up to this size show in the chat; larger ones are a card. */
const INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

function open(attachment: MessageAttachment) {
  router.push({
    pathname: "/document/[documentId]",
    params: {
      documentId: attachment.document_id,
      versionId: attachment.document_version_id,
      filename: attachment.filename,
      mediaType: attachment.media_type ?? "",
    },
  });
}

/** The file kind's icon in its color, bare as in the chat's file card. */
export function FileIcon(props: {
  readonly filename: string;
  readonly mediaType?: string;
  readonly size?: IconSize;
}) {
  const tone = tones[fileKind(props.filename, props.mediaType)];
  return <Icon name={tone.icon} size={props.size ?? 24} color={tone.color} />;
}

/** The file kind's icon on a tile of its color, for a file shown on its own. */
export function FileTile(props: {
  readonly filename: string;
  readonly mediaType?: string;
  readonly size?: number;
}) {
  const tone = tones[fileKind(props.filename, props.mediaType)];
  const size = props.size ?? 44;
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: size >= 48 ? radius.xxl : radius.lg,
          backgroundColor: tone.tint,
        },
      ]}
    >
      <Icon name={tone.icon} size={size >= 48 ? 24 : 20} color={tone.color} />
    </View>
  );
}

function InlineImage(props: { readonly attachment: MessageAttachment }) {
  const { t } = useTranslation();
  const { attachment } = props;
  const teamHub = useTeamHub();
  const [ratio, setRatio] = useState(4 / 3);
  const image = useQuery({
    queryKey: teamHubKey(
      teamHub.hostId,
      "inline-image",
      attachment.document_version_id,
    ),
    enabled: teamHub.connected,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    queryFn: async () => {
      const file = await teamHub.run((session) =>
        downloadDocumentVersion(session, attachment.document_version_id),
      );
      return `data:${file.contentType};base64,${toBase64(file.bytes)}`;
    },
  });
  return (
    <PressScale
      accessibilityRole="imagebutton"
      accessibilityLabel={t(m.open, { name: attachment.filename })}
      onPress={() => open(attachment)}
      style={[styles.image, { aspectRatio: ratio }]}
    >
      {image.data ? (
        <Image
          source={{ uri: image.data }}
          resizeMode="cover"
          style={StyleSheet.absoluteFill}
          onLoad={(event) => {
            const { width, height } = event.nativeEvent.source;
            if (width > 0 && height > 0)
              setRatio(Math.max(0.6, Math.min(1.8, width / height)));
          }}
        />
      ) : (
        <View style={styles.imageWait}>
          <FileIcon filename={attachment.filename} />
        </View>
      )}
    </PressScale>
  );
}

export function FileCard(props: {
  readonly attachment: MessageAttachment;
  readonly mine: boolean;
}) {
  const { t } = useTranslation();
  const { attachment } = props;
  const media = attachment.media_type ?? "";
  if (
    attachment.available &&
    viewerFor(attachment.filename, media) === "image" &&
    attachment.size_bytes <= INLINE_IMAGE_BYTES
  )
    return (
      <View style={props.mine ? styles.alignEnd : styles.alignStart}>
        <InlineImage attachment={attachment} />
      </View>
    );
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={t(m.open, { name: attachment.filename })}
      disabled={!attachment.available}
      onPress={() => open(attachment)}
      containerStyle={props.mine ? styles.alignEnd : styles.alignStart}
      style={[styles.card, !attachment.available && styles.gone]}
    >
      <FileIcon filename={attachment.filename} mediaType={media} />
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
          {attachment.filename}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {attachment.available
            ? t(m.details, {
                type: fileTypeLabel(t, attachment.filename, media),
                size: fileSize(attachment.size_bytes),
              })
            : t(m.unavailable)}
        </Text>
      </View>
      {attachment.available ? (
        <Icon name="chevron" size={16} color={colors.muted} />
      ) : null}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center" },
  // The chat's file card (--chat-file-width 360): the whole card opens.
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    width: 360,
    maxWidth: "92%",
    padding: space.md,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.chatCard,
  },
  alignStart: { alignSelf: "flex-start" },
  alignEnd: { alignSelf: "flex-end" },
  gone: { opacity: 0.55 },
  text: { flex: 1, gap: 2 },
  name: {
    ...StyleSheet.flatten(type.chat),
    fontWeight: "600",
    color: colors.ink,
  },
  detail: { ...StyleSheet.flatten(type.chatMeta) },
  image: {
    width: 240,
    borderRadius: radius.xl,
    overflow: "hidden",
    backgroundColor: colors.surfaceSoft,
  },
  imageWait: { flex: 1, alignItems: "center", justifyContent: "center" },
});
