import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity01Icon,
  ArrowLeft01Icon,
  Loading03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";
import { RuntimeHistoryView } from "./runtime-history-view";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import { ActorAvatar } from "../../members/actor-avatar";
import { PanelLoading } from "../panel-loading";
import { activityPanelMessages as m } from "./activity-panel.messages";
import { TaskConversationProvider } from "./task-conversation-dialog";

export function MessageActivitiesPanelTab({
  activationKey,
  hidden,
  message,
  onBack,
  backLabel,
  roomId,
  tenantId,
}: {
  activationKey?: number;
  hidden: boolean;
  message: TeamHubMessage;
  onBack?: () => void;
  backLabel?: string;
  roomId: string;
  tenantId: string;
}) {
  const t = useT();
  const back = backLabel ?? t(m.backToAgentInfo);
  const { client } = useTeamHubRuntime();
  const activities = useQuery({
    enabled: !hidden,
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/rooms/{roomId}/messages/{messageId}/activities", {
          params: { path: { roomId, messageId: message.id } },
        }),
      ),
    queryKey: [
      "teamhub",
      tenantId,
      "rooms",
      roomId,
      "messages",
      message.id,
      "activities",
    ],
    retry: false,
    // Follow a live log only; an unavailable or failed one will not change.
    refetchInterval: (query) =>
      !hidden && query.state.data?.status === "available" ? 750 : false,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
  const loading = activities.isPending;
  // Polling stays silent; only an explicit refresh shows progress.
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  useEffect(() => {
    followLatest.current = true;
  }, [activationKey, message.id, hidden]);
  useEffect(() => {
    if (hidden || !followLatest.current) return;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [activationKey, hidden, message.id, activities.data?.records.length]);

  return (
    <TaskConversationProvider roomId={roomId} tenantId={tenantId}>
      <div
        className={hidden ? "hidden" : "flex h-full min-h-0 flex-col bg-card"}
        data-testid="message-activities-panel"
        hidden={hidden || undefined}
        inert={hidden || undefined}
      >
        <header className="flex min-h-14 shrink-0 items-center gap-2.5 px-4 py-2">
          {onBack ? (
            <button
              aria-label={back}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus"
              onClick={onBack}
              title={back}
              type="button"
            >
              <Icon icon={ArrowLeft01Icon} size={16} />
            </button>
          ) : null}
          <ActorAvatar
            actorId={message.author.id}
            kind={message.author.kind}
            name={message.author.display_name}
            size="xs"
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {t(m.messageActivities, { name: message.author.display_name })}
            </h2>
            <p className="truncate text-xs text-app-muted">{t(m.activity)}</p>
          </div>
          <button
            aria-label={t(m.refreshMessageActivities)}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
            disabled={loading}
            onClick={() => {
              setRefreshing(true);
              void activities.refetch().finally(() => setRefreshing(false));
            }}
            title={t(m.refresh)}
            type="button"
          >
            {refreshing ? (
              <Icon
                className="animate-spin motion-reduce:animate-none"
                icon={Loading03Icon}
                size={16}
              />
            ) : (
              <Icon icon={RefreshIcon} size={16} />
            )}
          </button>
        </header>

        <div
          ref={scrollRef}
          className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto bg-card"
          onScroll={(event) => {
            const element = event.currentTarget;
            followLatest.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <=
              32;
          }}
        >
          {activities.isError ? (
            <ActivityLogState
              detail={t(m.activitiesLoadFailedDetail)}
              title={t(m.activitiesLoadFailedTitle)}
            />
          ) : loading ? (
            <PanelLoading label={t(m.loadingActivities)} />
          ) : activities.data?.status !== "available" ? (
            <ActivityLogState
              detail={activities.data?.reason}
              title={t(m.activityLogUnavailable)}
            />
          ) : activities.data.records.length > 0 ? (
            <section className="bg-card">
              {!activities.data.has_native_turn ? (
                <p className="px-4 py-2 text-xs text-app-muted">
                  {t(m.onlyLinkedToolRecords)}
                </p>
              ) : null}
              {activities.data.truncated ? (
                <p className="px-4 py-2 text-xs text-app-muted">
                  {t(m.turnTruncated, { limit: 10_000 })}
                </p>
              ) : null}
              <RuntimeHistoryView records={activities.data.records} />
            </section>
          ) : (
            <ActivityLogState
              detail={activities.data.reason ?? t(m.onlyLinkedRuntimeRecords)}
              title={t(m.noExactActivityLog)}
            />
          )}
        </div>
      </div>
    </TaskConversationProvider>
  );
}

function ActivityLogState({
  detail,
  title,
}: {
  detail?: string;
  title: string;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
      <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
        <Icon icon={Activity01Icon} size={16} />
      </span>
      <p className="mt-3 text-sm font-semibold text-app-body">{title}</p>
      {detail ? (
        <p className="mt-1 max-w-sm text-xs leading-5 text-app-muted">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
