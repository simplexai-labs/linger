import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import { createTeamHubIdempotencyKey } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRoomListItem,
  TeamHubWorkItem,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { formatLocale, type Translate } from "@/i18n/language";
import { useT, useTranslation } from "@/i18n/use-translation";

import {
  capitalize,
  formatWorkItemCommentTime,
  formatWorkItemDate,
} from "./work-item-format";

import {
  createWorkItemComment,
  tenantWorkItemCommentsQueryKey,
  tenantWorkItemCommentsQueryOptions,
  type TeamHubWorkItemComment,
} from "./work-item-queries";
import { workItemsMessages as m } from "./work-items.messages";

export interface WorkItemDetailDrawerProps {
  item: TeamHubWorkItem;
  onClose: () => void;
  originRoomLabel: string;
  rooms: readonly TeamHubRoomListItem[];
  statusBadge: ReactNode;
  tenantId: string;
}

export function WorkItemDetailDrawer({
  item,
  onClose,
  originRoomLabel,
  rooms,
  statusBadge,
  tenantId,
}: WorkItemDetailDrawerProps) {
  const { language, t } = useTranslation();
  const locale = formatLocale(language);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const originRoom = item.origin_room_id
    ? rooms.find((room) => room.id === item.origin_room_id)
    : undefined;
  const workRoom = item.work_room_id
    ? rooms.find((room) => room.id === item.work_room_id)
    : undefined;
  const executionLabel = item.task_execution
    ? formatExecutionStatus(
        item.task_execution.status,
        item.task_execution.reason_code,
        t,
      )
    : undefined;

  return (
    <aside
      aria-label={t(m.detailTitle)}
      className="absolute inset-0 z-20 flex min-h-0 w-full flex-col overflow-hidden bg-app-surface lg:static lg:inset-auto lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-l lg:border-app-border"
      data-voice-closable
    >
      <header className="flex shrink-0 items-center justify-between gap-2 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t(item.kind === "issue" ? m.issueNumber : m.taskNumber, {
              number: String(item.number),
            })}
          </span>
          {statusBadge}
        </div>
        <Button
          aria-label={t(m.closeDetail)}
          data-voice-close
          onClick={onClose}
          size="compactIcon"
          title={t(m.closeDetail)}
          tone="ghost"
        >
          <Icon icon={Cancel01Icon} size={14} />
        </Button>
      </header>

      <div className="workspace-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div>
          <h2 className="text-base font-semibold leading-6 text-foreground [overflow-wrap:anywhere]">
            {item.title}
          </h2>
          {item.description.trim() ? (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-app-body [overflow-wrap:anywhere]">
              {item.description}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              {t(m.noDescription)}
            </p>
          )}
        </div>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 pt-4 text-xs">
          <dt className="text-muted-foreground">{t(m.priority)}</dt>
          <dd className="font-medium text-foreground">
            {capitalize(item.priority)}
          </dd>

          {item.resolution ? (
            <>
              <dt className="text-muted-foreground">{t(m.resolution)}</dt>
              <dd className="font-medium text-foreground">
                {formatResolution(item.resolution, t)}
              </dd>
            </>
          ) : null}

          {executionLabel ? (
            <>
              <dt className="text-muted-foreground">{t(m.runActivity)}</dt>
              <dd className="font-medium text-foreground">{executionLabel}</dd>
            </>
          ) : null}

          <dt className="text-muted-foreground">{t(m.room)}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">
            {originRoom ? (
              <Link
                className="font-medium text-app-link hover:underline"
                to={`/t/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(originRoom.id)}/chat`}
              >
                {originRoomLabel}
              </Link>
            ) : (
              <span className="text-foreground">{originRoomLabel}</span>
            )}
          </dd>

          {workRoom ? (
            <>
              <dt className="text-muted-foreground">{t(m.workRoom)}</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">
                <Link
                  className="font-medium text-app-link hover:underline"
                  to={`/t/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(workRoom.id)}/chat`}
                >
                  {workRoom.name}
                </Link>
              </dd>
            </>
          ) : null}

          <dt className="text-muted-foreground">{t(m.createdBy)}</dt>
          <dd className="flex min-w-0 items-center gap-1.5 text-foreground">
            <ActorAvatar
              actorId={item.created_by.id}
              kind={item.created_by.kind}
              name={item.created_by.display_name}
              size="micro"
            />
            <span className="truncate">{item.created_by.display_name}</span>
          </dd>

          <dt className="text-muted-foreground">{t(m.assignees)}</dt>
          <dd className="min-w-0 text-foreground">
            {item.assignees.length ? (
              <ul className="space-y-1.5">
                {item.assignees.map(({ actor }) => (
                  <li
                    className="flex min-w-0 items-center gap-1.5"
                    key={actor.id}
                  >
                    <ActorAvatar
                      actorId={actor.id}
                      kind={actor.kind}
                      name={actor.display_name}
                      size="micro"
                    />
                    <span className="truncate">{actor.display_name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">{t(m.unassigned)}</span>
            )}
          </dd>

          <dt className="text-muted-foreground">{t(m.created)}</dt>
          <dd className="text-foreground">
            <time dateTime={item.created_at}>
              {formatWorkItemDate(item.created_at, locale)}
            </time>
          </dd>

          <dt className="text-muted-foreground">{t(m.updated)}</dt>
          <dd className="text-foreground">
            <time dateTime={item.updated_at}>
              {formatWorkItemDate(item.updated_at, locale)}
            </time>
          </dd>
        </dl>

        <WorkItemCommentsList tenantId={tenantId} workItemId={item.id} />
      </div>

      <WorkItemCommentForm
        key={item.id}
        tenantId={tenantId}
        workItemId={item.id}
      />
    </aside>
  );
}

function WorkItemCommentsList({
  tenantId,
  workItemId,
}: {
  tenantId: string;
  workItemId: string;
}) {
  const { language, t } = useTranslation();
  const locale = formatLocale(language);
  const { client } = useTeamHubRuntime();
  const commentsQuery = useQuery(
    tenantWorkItemCommentsQueryOptions(client, tenantId, workItemId),
  );
  const comments = commentsQuery.data?.items ?? [];

  return (
    <section aria-label={t(m.comments)} className="space-y-3 pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {comments.length
            ? t(m.commentsCount, { count: comments.length })
            : t(m.comments)}
        </h3>
      </div>

      {commentsQuery.isPending ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t(m.loadingComments)}
        </p>
      ) : commentsQuery.isError ? (
        <div className="space-y-2 text-xs text-app-danger" role="alert">
          <p>{commentsQuery.error.message || t(m.commentsLoadFailed)}</p>
          <Button
            onClick={() => void commentsQuery.refetch()}
            size="compact"
            tone="secondary"
          >
            {t(commonMessages.tryAgain)}
          </Button>
        </div>
      ) : comments.length ? (
        <ul className="space-y-2.5">
          {comments.map((comment) => (
            <li
              className="rounded-lg border border-app-border bg-card px-3 py-2.5 text-xs"
              key={comment.id}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                  <ActorAvatar
                    actorId={comment.author.id}
                    kind={comment.author.kind}
                    name={comment.author.display_name}
                    size="micro"
                  />
                  <span className="truncate">
                    {comment.author.display_name}
                  </span>
                </span>
                <time
                  className="shrink-0 text-muted-foreground"
                  dateTime={comment.created_at}
                >
                  {formatWorkItemCommentTime(comment.created_at, locale)}
                </time>
              </div>
              {comment.deleted_at ? (
                <p className="mt-1.5 italic text-muted-foreground">
                  {t(m.commentDeleted)}
                </p>
              ) : (
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-app-body [overflow-wrap:anywhere]">
                  {comment.body}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t(m.noComments)}</p>
      )}
    </section>
  );
}

function WorkItemCommentForm({
  tenantId,
  workItemId,
}: {
  tenantId: string;
  workItemId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const submissionKeyRef = useRef<string | null>(null);
  const addComment = useMutation({
    mutationFn: ({
      body,
      idempotencyKey,
    }: {
      body: string;
      idempotencyKey: string;
    }) => createWorkItemComment(client, workItemId, body, idempotencyKey),
    onSuccess: (created) => {
      submissionKeyRef.current = null;
      setDraft("");
      queryClient.setQueryData(
        tenantWorkItemCommentsQueryKey(tenantId, workItemId),
        (
          current:
            | { items: TeamHubWorkItemComment[]; page: { has_more: boolean } }
            | undefined,
        ) =>
          current
            ? {
                ...current,
                items: current.items.some((entry) => entry.id === created.id)
                  ? current.items
                  : [...current.items, created],
              }
            : { items: [created], page: { has_more: false } },
      );
      void queryClient.invalidateQueries({
        queryKey: tenantWorkItemCommentsQueryKey(tenantId, workItemId),
      });
    },
  });

  function submitComment(event: FormEvent) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || addComment.isPending) return;
    const idempotencyKey =
      submissionKeyRef.current ?? createTeamHubIdempotencyKey();
    submissionKeyRef.current = idempotencyKey;
    addComment.mutate({ body: trimmed, idempotencyKey });
  }

  return (
    <form
      className="shrink-0 space-y-2 bg-app-surface px-5 py-3"
      onSubmit={submitComment}
    >
      <textarea
        aria-label={t(m.addCommentLabel)}
        className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-app-placeholder hover:border-border-hover focus-visible:border-foreground focus-visible:ring-2 focus-visible:ring-ring"
        disabled={addComment.isPending}
        onChange={(event) => {
          submissionKeyRef.current = null;
          setDraft(event.target.value);
          if (addComment.isError) addComment.reset();
        }}
        placeholder={t(m.addCommentPlaceholder)}
        rows={2}
        value={draft}
      />
      {addComment.isError ? (
        <p className="text-xs text-app-danger" role="alert">
          {addComment.error.message || t(m.commentPostFailed)}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          data-voice-risk="never"
          disabled={!draft.trim() || addComment.isPending}
          loading={addComment.isPending}
          size="compact"
          tone="primary"
          type="submit"
        >
          {t(m.postComment)}
        </Button>
      </div>
    </form>
  );
}

function formatResolution(
  resolution: NonNullable<TeamHubWorkItem["resolution"]>,
  t: Translate,
) {
  switch (resolution) {
    case "completed":
      return t(m.resolutionCompleted);
    case "failed":
      return t(m.resolutionFailed);
    case "not_planned":
      return t(m.resolutionNotPlanned);
    case "duplicate":
      return t(m.resolutionDuplicate);
  }
}

function formatExecutionStatus(
  status: NonNullable<TeamHubWorkItem["task_execution"]>["status"],
  reasonCode: string | undefined,
  t: Translate,
) {
  switch (status) {
    case "running":
      return t(m.executionRunning);
    case "waiting_for_approval":
      return t(m.executionWaitingForApproval);
    case "idle":
      return reasonCode === "run_succeeded"
        ? t(m.executionFinishedAwaitingResolution)
        : t(m.executionIdle);
    case "failed":
      return t(m.executionFailed);
    case "canceled":
      return t(m.executionCanceled);
  }
}
