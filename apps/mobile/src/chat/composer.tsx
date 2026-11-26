// Text, attachments and the voice entry points. Files upload as soon as they
// are picked, so the message itself only names the upload ids and its send
// can be repeated byte for byte from the outbox.
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect } from "expo-router";
import { File } from "expo-file-system";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import {
  deleteAttachmentUpload,
  newIdempotencyKey,
  uploadAttachment,
} from "../api/teamhub";
import type { MessageAttachmentUpload } from "../api/types";
import { HttpError } from "../session/http";
import { SessionClosed } from "../session/session";
import {
  NotConnected,
  useDirectAgent,
  useIdentity,
  useRoomMembers,
  useTeamHub,
} from "../state/queries";
import { ActorAvatar } from "../ui/avatar";
import { colors, radius, shadow, space, type } from "../theme";
import { tap } from "../ui/haptics";
import { PressScale } from "../ui/press-scale";
import { Icon, type IconName } from "../ui/icon";
import {
  insertMention,
  mentionQuery,
  mentionToken,
  messageSegments,
  type Mentionable,
} from "./compose-message";
import { mentionStyle } from "./mention-style";
import { sendRetryingOnce } from "./upload-retry";
import { AttachMenu, type AttachSource } from "./attach-menu";
import { armLive } from "../voice";
import type { Translate } from "../i18n/language";
import { useTranslation } from "../i18n/use-translation";
import { chatComposerMessages as m } from "./composer.messages";
import { useOutbox } from "./outbox-context";
import { Text, TextInput } from "../ui/text";

/** The session buffers a whole upload in memory, so phones send modest files. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface Pending {
  readonly localId: string;
  readonly name: string;
  readonly upload?: MessageAttachmentUpload;
}

export function Composer(props: {
  readonly roomId: string;
  readonly placeholder: string;
}) {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const outbox = useOutbox();
  const directAgent = useDirectAgent(props.roomId);
  const myActorId = useIdentity().data?.actorId;
  const members = useRoomMembers(props.roomId).data;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentions, setMentions] = useState<readonly Mentionable[]>([]);
  const nextSelection = useRef<{ start: number; end: number } | undefined>(
    undefined,
  );
  const [files, setFiles] = useState<readonly Pending[]>([]);
  const [problem, setProblem] = useState<string | undefined>();
  const query = mentionQuery(text, caret);
  const suggestions = useMemo(() => {
    if (!query || !members) return [];
    const needle = query.query.toLowerCase();
    return members
      .map((member) => member.actor)
      .filter(
        (actor) =>
          actor.id !== myActorId &&
          actor.id !== directAgent?.id &&
          // Someone already named in the message is not offered again.
          !mentions.some(
            (named) =>
              named.id === actor.id && text.includes(mentionToken(named)),
          ) &&
          actor.display_name.toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        a.kind === b.kind
          ? a.display_name.localeCompare(b.display_name)
          : a.kind === "agent"
            ? -1
            : 1,
      )
      .slice(0, 6);
  }, [directAgent?.id, members, mentions, myActorId, query, text]);
  const choose = (actor: Mentionable) => {
    if (!query) return;
    const next = insertMention(text, query.start, caret, actor);
    setText(next.text);
    setCaret(next.caret);
    nextSelection.current = { start: next.caret, end: next.caret };
    setMentions((current) => [
      ...current.filter((item) => item.id !== actor.id),
      actor,
    ]);
  };

  const uploading = files.some((file) => !file.upload);
  const canSend =
    !uploading &&
    (text.trim().length > 0 || files.length > 0) &&
    !!outbox.outbox;

  // A chat opens ready to type, also when the Human comes back to it, as
  // Codex's does; dragging the conversation down puts the keyboard away.
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  useFocusEffect(
    useCallback(() => {
      // After the drawer has closed: focus taken while it slides away is
      // dropped.
      const timer = setTimeout(() => input.current?.focus(), 350);
      return () => clearTimeout(timer);
    }, []),
  );

  const latestTeamHub = useRef(teamHub);
  useEffect(() => {
    latestTeamHub.current = teamHub;
  }, [teamHub]);
  const plusRef = useRef<React.ComponentRef<typeof View>>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  const toggleMenu = () => {
    tap();
    if (menuAt) {
      setMenuAt(undefined);
      return;
    }
    plusRef.current?.measureInWindow((x, y) => setMenuAt({ x, y }));
  };
  const pickFrom = (source: AttachSource) => {
    setMenuAt(undefined);
    void attach(source);
  };

  const attach = async (source: AttachSource) => {
    setProblem(undefined);
    if (!teamHub.connected) {
      setProblem(t(m.connectToAttach));
      return;
    }
    let asset: PickedFile | undefined;
    try {
      asset = await pickFile(source, t);
    } catch (error) {
      setProblem(
        error instanceof CameraNotAllowed
          ? t(m.cameraNotAllowed)
          : source === "camera"
            ? t(m.cameraUnavailable)
            : t(m.pickFailed),
      );
      return;
    }
    if (!asset) return;
    if (asset.size !== undefined && asset.size > MAX_UPLOAD_BYTES) {
      setProblem(t(m.fileTooLarge));
      return;
    }
    const localId = newIdempotencyKey();
    setFiles((current) => [...current, { localId, name: asset.name }]);
    try {
      const bytes = await new File(asset.uri).bytes();
      const hostId = teamHub.hostId;
      // Read through the ref so a retry uses the session open now, and only
      // while it still belongs to the same computer.
      const send = () => {
        const current = latestTeamHub.current;
        if (current.hostId !== hostId)
          return Promise.reject(new Error("The computer changed."));
        return current.run((session) =>
          uploadAttachment(
            session,
            props.roomId,
            { name: asset.name, mediaType: asset.mimeType, bytes },
            localId,
          ),
        );
      };
      // The same key lets the computer keep one copy.
      const upload = await sendRetryingOnce(
        send,
        (error) =>
          error instanceof SessionClosed || error instanceof NotConnected,
      );
      setFiles((current) =>
        current.map((file) =>
          file.localId === localId ? { ...file, upload } : file,
        ),
      );
    } catch (error) {
      setFiles((current) => current.filter((file) => file.localId !== localId));
      setProblem(
        error instanceof HttpError && error.status === 413
          ? t(m.fileTooLargeForComputer)
          : t(m.uploadFailed, { name: asset.name }),
      );
    }
  };

  const remove = (file: Pending) => {
    setFiles((current) =>
      current.filter((item) => item.localId !== file.localId),
    );
    const upload = file.upload;
    if (upload)
      void teamHub
        .run((session) =>
          deleteAttachmentUpload(session, props.roomId, upload.id),
        )
        .catch(() => undefined);
  };

  const send = async () => {
    if (!canSend) return;
    const uploads = files.flatMap((file) => (file.upload ? [file.upload] : []));
    const message = text.trim();
    const named = mentions.filter((actor) =>
      message.includes(mentionToken(actor)),
    );
    tap();
    setText("");
    setMentions([]);
    setFiles([]);
    setProblem(undefined);
    try {
      await outbox.send(props.roomId, message, uploads, {
        mentions: named,
        directAgent,
      });
    } catch {
      setText(message);
      setMentions(named);
      setProblem(t(m.notSaved));
    }
  };

  const shownProblem = problem;
  const showSend = canSend || text.trim().length > 0;

  return (
    <View style={styles.wrap}>
      {shownProblem ? (
        <Text style={[type.small, styles.problem]} accessibilityRole="alert">
          {shownProblem}
        </Text>
      ) : null}
      {suggestions.length > 0 ? (
        <MentionSheet actors={suggestions} onChoose={choose} />
      ) : null}
      {files.length > 0 ? (
        <View style={styles.files}>
          {files.map((file) => (
            <View key={file.localId} style={styles.file}>
              {file.upload ? null : (
                <ActivityIndicator size="small" color={colors.muted} />
              )}
              <Text style={[type.small, styles.fileName]} numberOfLines={1}>
                {file.name}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t(m.removeFile, { name: file.name })}
                onPress={() => remove(file)}
                hitSlop={10}
              >
                <Icon name="close" size={14} color={colors.muted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.dock}>
        <View ref={plusRef} collapsable={false}>
          <RoundButton label={t(m.attach)} onPress={toggleMenu} icon="add" />
        </View>
        <AttachMenu
          anchor={menuAt}
          onClose={() => setMenuAt(undefined)}
          onChoose={pickFrom}
        />
        <TextInput
          style={styles.input}
          ref={input}
          onChangeText={setText}
          selection={nextSelection.current}
          onSelectionChange={(event) => {
            nextSelection.current = undefined;
            setCaret(event.nativeEvent.selection.end);
          }}
          placeholder={props.placeholder}
          placeholderTextColor={colors.placeholder}
          multiline
          textAlignVertical="center"
          accessibilityLabel={t(m.message)}
          submitBehavior="newline"
        >
          {/* Children instead of value, so a chosen @ shows as a mention. */}
          {messageSegments(text, mentions).map((segment, index) =>
            segment.type === "reference" ? (
              <Text key={index} style={mentionStyle}>
                {segment.content}
              </Text>
            ) : (
              <Text key={index}>{segment.content}</Text>
            ),
          )}
        </TextInput>
        {/* As on the desktop: with nothing typed the ink button opens
            Live, with words it sends them. */}
        {showSend ? (
          <RoundButton
            label={t(m.send)}
            onPress={() => void send()}
            icon="send"
            tone="ink"
            disabled={!canSend}
          />
        ) : (
          <RoundButton
            label={t(m.talkLive)}
            onPress={() => {
              tap();
              armLive();
              router.push({
                pathname: "/voice/[mode]",
                params: { mode: "live", roomId: props.roomId },
              });
            }}
            icon="wave"
            tone="ink"
          />
        )}
      </View>
    </View>
  );
}

class CameraNotAllowed extends Error {}

interface PickedFile {
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly size?: number;
}

/** Opens the camera, the photo library or Files; undefined when cancelled. */
async function pickFile(
  source: AttachSource,
  t: Translate,
): Promise<PickedFile | undefined> {
  if (source === "files") {
    const picked = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = picked.canceled ? undefined : picked.assets[0];
    return asset
      ? {
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.size,
        }
      : undefined;
  }
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new CameraNotAllowed();
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: source === "camera" ? ["images"] : ["images", "videos"],
    quality: 0.85,
    // HEIC photos become JPEG, which every computer can show.
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  };
  const picked =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (!asset) return undefined;
  const extension = asset.mimeType?.split("/")[1] ?? "jpg";
  const time = new Date().toISOString().slice(0, 19).replace("T", " ");
  return {
    uri: asset.uri,
    name:
      asset.fileName ??
      `${t(asset.type === "video" ? m.videoName : m.photoName, { time })}.${extension}`,
    mimeType: asset.mimeType,
    size: asset.fileSize,
  };
}

function RoundButton(props: {
  readonly label: string;
  readonly icon: IconName;
  readonly onPress: () => void;
  /** The gray pill, the ink circle of Send and Live, or a bare icon. */
  readonly tone?: "pill" | "ink" | "quiet";
  readonly disabled?: boolean;
}) {
  const ink = props.tone === "ink";
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      style={[
        styles.round,
        ink
          ? styles.roundInk
          : props.tone === "quiet"
            ? styles.roundQuiet
            : styles.roundPill,
        props.disabled && styles.roundDisabled,
      ]}
    >
      <Icon
        name={props.icon}
        size={20}
        color={ink ? colors.onAction : colors.secondary}
      />
    </PressScale>
  );
}

/** Room members to mention, as large faces sliding up over the dock. */
function MentionSheet(props: {
  readonly actors: readonly Mentionable[];
  readonly onChoose: (actor: Mentionable) => void;
}) {
  const { t } = useTranslation();
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(rise, {
      toValue: 1,
      speed: 18,
      bounciness: 5,
      useNativeDriver: true,
    }).start();
  }, [rise]);
  return (
    <Animated.View
      style={[
        styles.sheet,
        {
          opacity: rise,
          transform: [
            {
              translateY: rise.interpolate({
                inputRange: [0, 1],
                outputRange: [24, 0],
              }),
            },
          ],
        },
      ]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.sheetRow}
        accessibilityLabel={t(m.mentionList)}
      >
        {props.actors.map((actor) => (
          <Pressable
            key={actor.id}
            accessibilityRole="button"
            accessibilityLabel={t(m.mention, { name: actor.display_name })}
            onPress={() => props.onChoose(actor)}
            style={({ pressed }) => [
              styles.pick,
              pressed && styles.pickPressed,
            ]}
          >
            <ActorAvatar actor={actor} size={52} />
            <Text style={styles.pickName} numberOfLines={1}>
              {actor.display_name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.md,
    paddingTop: space.xs,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  problem: { color: colors.danger, paddingHorizontal: space.sm },
  files: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    maxWidth: "100%",
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  fileName: { color: colors.ink, flexShrink: 1 },
  // The composer: white, a hairline, shadow-md, radius 16 (--composer-*).
  dock: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadow.md,
  },
  input: {
    ...StyleSheet.flatten(type.chat),
    flex: 1,
    minHeight: 36,
    maxHeight: 140,
    paddingTop: 7,
    paddingBottom: 7,
  },
  round: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  roundPill: { backgroundColor: colors.pill },
  roundInk: { backgroundColor: colors.action },
  roundQuiet: { backgroundColor: "transparent" },
  roundDisabled: { opacity: 0.4 },
  // A menu over the composer: r12, hairline, shadow-md.
  sheet: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: space.md,
    ...shadow.md,
  },
  sheetRow: {
    paddingHorizontal: space.md,
    gap: space.lg,
    alignItems: "flex-start",
  },
  pick: {
    alignItems: "center",
    gap: 6,
    width: 68,
    minHeight: 84,
    borderRadius: radius.lg,
  },
  pickPressed: { opacity: 0.6, transform: [{ scale: 0.95 }] },
  pickName: { fontSize: 12, color: colors.secondary, maxWidth: 64 },
});
