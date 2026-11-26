// The line above the composer while an Agent works in a group, with Stop
// (a direct Agent chat shows it on the stage instead). Statuses
// come from the Room's run list and `agent_run.status_changed`; the text
// comes from the Run's runtime presentation events, as in Web's Dock.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import {
  cancelRun,
  listPresentationEvents,
  listRunStatuses,
} from "../api/teamhub";
import { runsKey, type RunViews } from "../realtime/realtime-context";
import { useTeamHub } from "../state/queries";
import { colors, radius, space, touchTarget, type } from "../theme";
import type { Translate } from "../i18n/language";
import type { Message } from "../i18n/messages";
import { useTranslation } from "../i18n/use-translation";
import {
  applyPresentationEvents,
  isWorking,
  mergeRun,
  needsEvents,
  type RunPhase,
  type RunView,
} from "./run-status";
import { chatRunMessages as m } from "./run-status.messages";
import { Text } from "../ui/text";

const PHASES: Record<RunPhase, Message<string>> = {
  working: m.working,
  thinking: m.thinking,
  queued: m.queued,
};

/** What a working Run's status line says: its own words, or its phase. */
export function runLine(view: RunView, t: Translate): string {
  return view.line || t(PHASES[view.phase]);
}

export function useRunViews(roomId: string): RunViews {
  const teamHub = useTeamHub();
  const client = useQueryClient();
  const key = useMemo(
    () => runsKey(teamHub.hostId, roomId),
    [teamHub.hostId, roomId],
  );
  const runs = useQuery({
    queryKey: key,
    enabled: teamHub.connected,
    queryFn: async (): Promise<RunViews> => {
      const list = await teamHub.run((session) =>
        listRunStatuses(session, roomId),
      );
      const current = client.getQueryData<RunViews>(key);
      const next: Record<string, ReturnType<typeof mergeRun>> = {};
      for (const run of list.items)
        next[run.run_id] = mergeRun(current?.[run.run_id], run);
      return next;
    },
  });
  const views = useMemo(() => runs.data ?? {}, [runs.data]);

  // Read presentation events for working Runs whose ordinal moved.
  const loading = useRef(new Set<string>());
  useEffect(() => {
    for (const view of Object.values(views)) {
      const runId = view.run.run_id;
      if (!needsEvents(view) || loading.current.has(runId)) continue;
      loading.current.add(runId);
      void teamHub
        .run((session) =>
          listPresentationEvents(session, roomId, runId, view.appliedOrdinal),
        )
        .then((page) =>
          client.setQueryData<RunViews>(key, (current) => {
            const latest = current?.[runId];
            if (!latest) return current;
            return {
              ...current,
              [runId]: applyPresentationEvents(
                latest,
                page.items,
                page.published_through_ordinal,
              ),
            };
          }),
        )
        .catch(() => undefined)
        .finally(() => loading.current.delete(runId));
    }
  }, [client, key, roomId, teamHub, views]);

  return views;
}

/** Stops a Room's Runs and remembers which are stopping. */
export function useStopRun(roomId: string): {
  readonly stopping: ReadonlySet<string>;
  stop(runId: string): void;
} {
  const teamHub = useTeamHub();
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  return {
    stopping,
    stop(runId) {
      setStopping((current) => new Set(current).add(runId));
      void teamHub
        .run((session) => cancelRun(session, roomId, runId))
        .catch(() =>
          setStopping((current) => {
            const next = new Set(current);
            next.delete(runId);
            return next;
          }),
        );
    },
  };
}

export function RunStatusBar(props: { readonly roomId: string }) {
  const { t } = useTranslation();
  const views = useRunViews(props.roomId);
  const { stopping, stop } = useStopRun(props.roomId);
  const working = Object.values(views).filter((view) => isWorking(view.run));
  if (working.length === 0) return null;

  return (
    <View style={styles.bar}>
      {working.map((view) => {
        const runId = view.run.run_id;
        const isStopping = stopping.has(runId);
        return (
          <View key={runId} style={styles.run} accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" color={colors.muted} />
            <Text style={[type.small, styles.text]} numberOfLines={1}>
              <Text style={styles.agent}>{view.run.agent.display_name}</Text>
              {"  "}
              {isStopping ? t(m.stopping) : runLine(view, t)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(m.stopAgent, {
                name: view.run.agent.display_name,
              })}
              disabled={isStopping}
              hitSlop={8}
              onPress={() => stop(runId)}
              style={({ pressed }) => [
                styles.stop,
                pressed && styles.pressed,
                isStopping && styles.disabled,
              ]}
            >
              <View style={styles.stopSquare} />
              <Text style={styles.stopLabel}>{t(m.stop)}</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.xs },
  run: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: touchTarget,
  },
  text: { flex: 1 },
  agent: { color: colors.ink, fontWeight: "600" },
  stop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  stopSquare: {
    width: 9,
    height: 9,
    borderRadius: 2,
    backgroundColor: colors.ink,
  },
  stopLabel: { fontSize: 14, fontWeight: "600", color: colors.ink },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
