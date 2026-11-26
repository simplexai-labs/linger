// A Document or file, read-only. Text, Markdown and images are drawn by the
// app; audio and video play in the app; PDF, Office, tables, HTML and the
// rest the desktop previews are downloaded into the cache and rendered by the
// offline viewer page. Only what the desktop cannot preview either goes to
// the system viewer (Quick Look on iOS), which every downloaded file also
// offers from the header. A file Document reads its current Version, which
// needs only read access: Wiki pages are read-only and cannot be exported,
// so their GET /v0/documents/{id}/downloads answers 404. A native Document's
// latest content comes from that route, which waits out one still rendering.
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import type { File } from "expo-file-system";
import { useVideoPlayer, VideoView } from "expo-video";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import { openFile } from "../../../modules/file-preview";
import {
  documentVersionContentPath,
  downloadDocumentVersion,
  downloadLatestDocument,
  getDocument,
  getDocumentVersion,
} from "../../api/teamhub";
import { FileTile } from "../../chat/file-card";
import { downloadToFile, freshCacheFile } from "../../library/cache-file";
import { FileViewer, type WebKind } from "../../library/file-viewer";
import {
  fileSize,
  fileTypeLabel,
  viewerFor,
  type Viewer,
} from "../../library/file-kind";
import { readKnowledgeMarkdown } from "../../library/knowledge-markdown";
import { readableFrom, ReadableView } from "../../library/readable";
import { Recording } from "../../library/recording";
import { isWikiPage, wikiPageTitle } from "../../library/wiki-pages";
import { useTranslation } from "../../i18n/use-translation";
import { documentMessages as m } from "../../screens/document.messages";
import { HttpError } from "../../session/http";
import { teamHubKey, useTeamHub } from "../../state/queries";
import { colors, radius, space, type } from "../../theme";
import { Button, EmptyState } from "../../ui/controls";
import { Icon } from "../../ui/icon";
import { StatusStrip } from "../../ui/status-strip";
import { Text } from "../../ui/text";

interface FileFacts {
  readonly versionId?: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size?: number;
}

/** The file's head: its tile, name, and type and size. */
function FileHead(props: { readonly facts: FileFacts }) {
  const { facts } = props;
  const { t } = useTranslation();
  return (
    <View style={styles.head}>
      <FileTile
        filename={facts.filename}
        mediaType={facts.mediaType}
        size={56}
      />
      <Text style={styles.headName} numberOfLines={2}>
        {facts.filename}
      </Text>
      <Text style={type.chatMeta}>
        {fileTypeLabel(t, facts.filename, facts.mediaType)}
        {facts.size !== undefined ? ` · ${fileSize(facts.size)}` : ""}
      </Text>
    </View>
  );
}

/** A downloaded video, played by the phone's own player. */
function VideoFile(props: { readonly uri: string }) {
  const player = useVideoPlayer(props.uri);
  return (
    <VideoView
      player={player}
      nativeControls
      fullscreenOptions={{ enable: true }}
      contentFit="contain"
      style={styles.video}
    />
  );
}

/**
 * Downloads the version into the cache, then shows it where viewer says:
 * the viewer page, the video player, or the system viewer. A file the page
 * cannot render falls back to the system viewer.
 */
function DownloadedFile(props: {
  readonly facts: FileFacts & { versionId: string };
  readonly viewer: { readonly web: WebKind } | "video" | "system";
}) {
  const { facts } = props;
  const { t, language } = useTranslation();
  const teamHub = useTeamHub();
  const fileRef = useRef<File | undefined>(undefined);
  const [state, setState] = useState<
    "downloading" | "ready" | "failed" | "unsupported"
  >("downloading");
  const [inApp, setInApp] = useState(props.viewer !== "system");
  const [truncatedRows, setTruncatedRows] = useState<number>();
  const [bytes, setBytes] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const show = useCallback(async () => {
    const file = fileRef.current;
    if (!file) return;
    try {
      await openFile(file.uri, facts.filename, facts.mediaType || undefined);
    } catch {
      setState("unsupported");
    }
  }, [facts.filename, facts.mediaType]);

  useEffect(() => {
    let cancelled = false;
    const hostId = teamHub.hostId;
    if (!hostId || !teamHub.connected || fileRef.current) return;
    const file = freshCacheFile(hostId, facts.versionId, facts.filename);
    fileRef.current = file;
    void teamHub
      .run((session) =>
        downloadToFile(
          session,
          documentVersionContentPath(facts.versionId),
          file,
          setBytes,
        ),
      )
      .then(() => {
        if (cancelled) return;
        setState("ready");
        if (!inApp) void show();
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
    // inApp only matters for the first open, after the download.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, facts.filename, facts.versionId, show, teamHub]);

  // The phone keeps no file from the computer once this screen closes.
  useEffect(
    () => () => {
      const file = fileRef.current;
      if (file?.exists) file.delete();
    },
    [],
  );

  const fallBack = useCallback(() => setInApp(false), []);
  const file = fileRef.current;
  const openIn =
    state === "ready" && inApp ? (
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(m.openInAnotherApp)}
              hitSlop={8}
              onPress={() => void show()}
            >
              <Icon name="share" size={20} color={colors.ink} />
            </Pressable>
          ),
        }}
      />
    ) : null;

  if (state === "ready" && inApp && file) {
    const viewer = props.viewer;
    return (
      <View style={styles.fill}>
        {openIn}
        {truncatedRows !== undefined ? (
          <Text style={styles.strip}>
            {t(m.truncatedRows, { count: truncatedRows })}
          </Text>
        ) : null}
        {viewer === "video" ? (
          <VideoFile uri={file.uri} />
        ) : typeof viewer === "object" ? (
          <FileViewer
            file={file}
            kind={viewer.web}
            filename={facts.filename}
            mediaType={facts.mediaType}
            language={language}
            onFailed={fallBack}
            onTruncated={setTruncatedRows}
          />
        ) : null}
      </View>
    );
  }

  const progress =
    facts.size && facts.size > 0 ? Math.min(1, bytes / facts.size) : undefined;

  return (
    <View style={styles.center}>
      <View style={styles.card}>
        <FileHead facts={facts} />
        {state === "downloading" ? (
          <View style={styles.progress}>
            {progress !== undefined ? (
              <View style={styles.bar}>
                <View
                  style={[styles.barFill, { width: `${progress * 100}%` }]}
                />
              </View>
            ) : (
              <ActivityIndicator color={colors.muted} />
            )}
            <Text style={styles.note}>
              {bytes > 0
                ? facts.size
                  ? t(m.gettingOf, {
                      received: fileSize(bytes),
                      total: fileSize(facts.size),
                    })
                  : t(m.getting, { received: fileSize(bytes) })
                : t(m.gettingFromComputer)}
            </Text>
          </View>
        ) : state === "ready" ? (
          <View style={styles.progress}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(m.open)}
              onPress={() => void show()}
              style={({ pressed }) => [styles.open, pressed && styles.pressed]}
            >
              <Icon name="open" size={16} color={colors.onAction} />
              <Text style={styles.openLabel}>{t(m.open)}</Text>
            </Pressable>
            <Text style={styles.note}>
              {props.viewer === "system"
                ? t(m.opensInViewer)
                : t(m.couldNotShow)}
            </Text>
          </View>
        ) : state === "unsupported" ? (
          <Text style={styles.note}>{t(m.noApp)}</Text>
        ) : (
          <View style={styles.progress}>
            <Text style={styles.note}>{t(m.didNotDownload)}</Text>
            <Button
              label={t(m.tryAgain)}
              variant="secondary"
              onPress={() => {
                fileRef.current = undefined;
                setBytes(0);
                setState("downloading");
                setAttempt((value) => value + 1);
              }}
              style={styles.action}
            />
          </View>
        )}
      </View>
    </View>
  );
}

/** An audio file: its head above the player card. */
function AudioFile(props: {
  readonly facts: FileFacts & { versionId: string };
}) {
  return (
    <View style={styles.center}>
      <View style={styles.audio}>
        <FileHead facts={props.facts} />
        <Recording
          versionId={props.facts.versionId}
          filename={props.facts.filename}
        />
      </View>
    </View>
  );
}

/** A native Document rendered as HTML, written to the cache for the viewer page. */
function HtmlPage(props: {
  readonly documentId: string;
  readonly html: string;
}) {
  const { t, language } = useTranslation();
  const teamHub = useTeamHub();
  const [file, setFile] = useState<File>();
  const [failed, setFailed] = useState(false);
  const { documentId, html } = props;
  useEffect(() => {
    const hostId = teamHub.hostId;
    if (!hostId) return;
    const next = freshCacheFile(hostId, documentId, "page.html");
    next.writeSync(html);
    setFile(next);
    return () => {
      if (next.exists) next.delete();
    };
  }, [documentId, html, teamHub.hostId]);
  const fail = useCallback(() => setFailed(true), []);
  if (failed) return <EmptyState title={t(m.didNotLoad)} />;
  if (!file)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  return (
    <FileViewer
      file={file}
      kind="html"
      filename="page.html"
      mediaType="text/html"
      language={language}
      onFailed={fail}
    />
  );
}

function Page(props: {
  readonly documentId: string;
  /** Read this Version; without one, the Document's latest content. */
  readonly versionId?: string;
  /** Generated knowledge Markdown, which hides its metadata from readers. */
  readonly knowledge: boolean;
  readonly onTitle: (title: string) => void;
}) {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const content = useQuery({
    queryKey: teamHubKey(
      teamHub.hostId,
      "document",
      props.documentId,
      "content",
      props.versionId,
    ),
    enabled: teamHub.connected,
    gcTime: 0,
    queryFn: async () =>
      readableFrom(
        await teamHub.run((session) =>
          props.versionId
            ? downloadDocumentVersion(session, props.versionId)
            : downloadLatestDocument(session, props.documentId),
        ),
      ),
  });
  const knowledge = useMemo(
    () =>
      props.knowledge && content.data?.kind === "markdown"
        ? readKnowledgeMarkdown(content.data.text)
        : undefined,
    [content.data, props.knowledge],
  );
  const { onTitle } = props;
  useEffect(() => {
    if (knowledge?.title) onTitle(knowledge.title);
  }, [knowledge?.title, onTitle]);
  const denied =
    content.error instanceof HttpError &&
    (content.error.status === 403 || content.error.status === 404);
  if (content.data?.kind === "image")
    return <ReadableView content={content.data} />;
  if (content.data?.kind === "html")
    return <HtmlPage documentId={props.documentId} html={content.data.text} />;
  if (content.data)
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <ReadableView
          content={
            knowledge
              ? { kind: "markdown", text: knowledge.body }
              : content.data
          }
        />
      </ScrollView>
    );
  if (content.isError)
    return (
      <EmptyState
        title={denied ? t(m.cannotRead) : t(m.didNotLoad)}
        body={denied ? t(m.notShared) : undefined}
        action={
          denied
            ? undefined
            : { label: t(m.tryAgain), onPress: () => void content.refetch() }
        }
      />
    );
  return teamHub.connected ? (
    <View style={styles.center}>
      <ActivityIndicator color={colors.muted} />
    </View>
  ) : (
    <EmptyState title={t(m.waiting)} />
  );
}

export default function DocumentScreen() {
  const params = useLocalSearchParams<{
    documentId: string;
    versionId?: string;
    filename?: string;
    mediaType?: string;
  }>();
  const { documentId } = params;
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const [pageTitle, setPageTitle] = useState<string>();
  const document = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "document", documentId),
    enabled: teamHub.connected && !!documentId,
    queryFn: () => teamHub.run((session) => getDocument(session, documentId)),
  });
  const versionId = params.versionId || document.data?.current_version?.id;
  // A file Document's content is its current Version; a native Document's is
  // its latest draft, which only the downloads route renders.
  const readVersionId =
    params.versionId ||
    (document.data && document.data.format !== "blocknote"
      ? document.data.current_version?.id
      : undefined);
  // The version names the file and gives its size, which picks the viewer.
  const version = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "document-version", versionId),
    enabled: teamHub.connected && !!versionId,
    queryFn: () =>
      teamHub.run((session) => getDocumentVersion(session, versionId ?? "")),
  });
  const facts: FileFacts | undefined = version.data
    ? {
        versionId,
        filename: version.data.filename,
        mediaType: version.data.media_type,
        size: version.data.size_bytes,
      }
    : params.filename && (version.isError || !versionId)
      ? {
          versionId,
          filename: params.filename,
          mediaType: params.mediaType ?? "",
        }
      : undefined;
  // A native Document has no file of its own: it reads as a page.
  const viewer: Viewer | undefined = facts
    ? viewerFor(facts.filename, facts.mediaType, facts.size)
    : document.data && !versionId
      ? "page"
      : version.isError
        ? "page"
        : undefined;
  const wikiPage = !!document.data && isWikiPage(document.data);
  const title =
    pageTitle ||
    (document.data
      ? wikiPage
        ? wikiPageTitle(document.data, t)
        : document.data.title
      : facts?.filename) ||
    t(m.title);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title }} />
      <StatusStrip />
      {viewer === "page" || viewer === "image" ? (
        <Page
          documentId={documentId}
          versionId={readVersionId}
          knowledge={wikiPage}
          onTitle={setPageTitle}
        />
      ) : viewer === "audio" && facts?.versionId ? (
        <AudioFile facts={{ ...facts, versionId: facts.versionId }} />
      ) : viewer && viewer !== "audio" && facts?.versionId ? (
        <DownloadedFile
          facts={{ ...facts, versionId: facts.versionId }}
          viewer={viewer}
        />
      ) : document.isError ? (
        <EmptyState
          title={t(m.didNotLoad)}
          action={{
            label: t(m.tryAgain),
            onPress: () => void document.refetch(),
          }}
        />
      ) : teamHub.connected ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.muted} />
        </View>
      ) : (
        <EmptyState title={t(m.waiting)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
  },
  card: {
    alignSelf: "stretch",
    alignItems: "center",
    gap: space.xl,
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  audio: { alignSelf: "stretch", gap: space.xl },
  fill: { flex: 1 },
  video: { flex: 1, backgroundColor: "#000" },
  strip: {
    ...StyleSheet.flatten(type.chatMeta),
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: colors.surfaceSoft,
  },
  head: { alignItems: "center", gap: space.xs },
  headName: {
    marginTop: space.sm,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
    color: colors.ink,
    textAlign: "center",
  },
  progress: { alignSelf: "stretch", alignItems: "center", gap: space.md },
  bar: {
    alignSelf: "stretch",
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
  },
  barFill: { height: 4, backgroundColor: colors.ink },
  note: { ...StyleSheet.flatten(type.chatMeta), textAlign: "center" },
  open: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    alignSelf: "stretch",
    minHeight: 44,
    borderRadius: radius.lg,
    backgroundColor: colors.action,
  },
  openLabel: { fontSize: 15, fontWeight: "500", color: colors.onAction },
  pressed: { transform: [{ scale: 0.97 }] },
  action: { alignSelf: "stretch" },
});
