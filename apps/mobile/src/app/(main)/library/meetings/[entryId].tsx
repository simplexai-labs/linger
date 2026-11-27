// One meeting: its recording, the summary, and the transcript.
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";

import {
  downloadDocumentVersion,
  getDocumentVersion,
  getMemoryEntry,
} from "../../../../api/teamhub";
import { useTranslation } from "../../../../i18n/use-translation";
import {
  readKnowledgeMarkdown,
  withoutLeadingHeading,
} from "../../../../library/knowledge-markdown";
import { meetingsDetailMessages as m } from "../../../../library/library-screen.messages";
import { readableFrom, ReadableView } from "../../../../library/readable";
import { Recording } from "../../../../library/recording";
import { UnderlineTabs } from "../../../../library/underline-tabs";
import { teamHubKey, useIdentity, useTeamHub } from "../../../../state/queries";
import { colors, space, type } from "../../../../theme";
import { EmptyState } from "../../../../ui/controls";
import { Markdown } from "../../../../ui/markdown";
import { StatusStrip } from "../../../../ui/status-strip";
import { Text } from "../../../../ui/text";

function Transcript(props: { readonly versionId: string }) {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const transcript = useQuery({
    queryKey: teamHubKey(
      teamHub.hostId,
      "document-version",
      props.versionId,
      "content",
    ),
    enabled: teamHub.connected,
    gcTime: 0,
    queryFn: async () => {
      const version = await teamHub.run((session) =>
        getDocumentVersion(session, props.versionId),
      );
      const download = await teamHub.run((session) =>
        downloadDocumentVersion(session, props.versionId),
      );
      return readableFrom({
        contentType: version.media_type || download.contentType,
        bytes: download.bytes,
        tooLarge: download.tooLarge,
      });
    },
  });
  if (transcript.data) return <ReadableView content={transcript.data} />;
  if (transcript.isError)
    return (
      <EmptyState
        title={t(m.transcriptFailed)}
        action={{
          label: t(m.tryAgain),
          onPress: () => void transcript.refetch(),
        }}
      />
    );
  return <ActivityIndicator style={styles.loading} color={colors.muted} />;
}

export default function MeetingScreen() {
  const { t, language } = useTranslation();
  const { entryId } = useLocalSearchParams<{ entryId: string }>();
  const teamHub = useTeamHub();
  const tenantId = useIdentity().data?.tenantId;
  const [tab, setTab] = useState<"summary" | "transcript">("summary");
  const entry = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "meetings", "entry", entryId),
    enabled: teamHub.connected && !!tenantId && !!entryId,
    // The summary is written after the meeting; check again while it is missing.
    refetchInterval: (query) =>
      query.state.data?.meeting?.summary_ready === false ? 15_000 : false,
    queryFn: () =>
      teamHub.run((session) =>
        getMemoryEntry(session, tenantId ?? "", entryId),
      ),
  });
  const meeting = entry.data?.meeting;
  // The summary is a Session page: its metadata stays hidden, and its first
  // heading repeats the title shown above it.
  const summary = useMemo(
    () =>
      withoutLeadingHeading(
        readKnowledgeMarkdown(entry.data?.content ?? "").body,
      ),
    [entry.data?.content],
  );

  const tabs = [
    { id: "summary", label: t(m.summary) },
    { id: "transcript", label: t(m.transcript) },
  ] as const;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: entry.data?.title || t(m.meeting) }} />
      <StatusStrip />
      {!entry.data ? (
        entry.isError ? (
          <EmptyState
            title={t(m.meetingFailed)}
            action={{
              label: t(m.tryAgain),
              onPress: () => void entry.refetch(),
            }}
          />
        ) : (
          <ActivityIndicator style={styles.loading} color={colors.muted} />
        )
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={type.title}>{entry.data.title || t(m.meeting)}</Text>
          {meeting ? (
            <Text style={type.small}>
              {new Date(meeting.started_at).toLocaleString(language, {
                weekday: "long",
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          ) : null}
          {meeting ? (
            <Recording
              versionId={meeting.recording_version_id}
              filename={meeting.recording_filename}
            />
          ) : null}
          <UnderlineTabs
            tabs={tabs}
            selected={tab}
            onSelect={setTab}
            style={styles.tabs}
          />
          {tab === "summary" ? (
            meeting && !meeting.summary_ready ? (
              <Text style={type.body}>{t(m.summaryPending)}</Text>
            ) : (
              <Markdown text={summary} />
            )
          ) : meeting ? (
            <Transcript versionId={meeting.transcript_version_id} />
          ) : (
            <Text style={type.body}>{t(m.noTranscript)}</Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: space.xl, gap: space.lg, paddingBottom: space.xxl * 2 },
  loading: { marginTop: space.xxl },
  // The tab labels line up with the page text.
  tabs: { marginHorizontal: -space.md },
});
