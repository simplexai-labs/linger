import {
  ArrowRight01Icon,
  Loading03Icon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

import { Icon } from "@/components/ui/icon";
import { commonMessages } from "@/i18n/common.messages";
import { RichMessage, useT } from "@/i18n/use-translation";
import { meetingPath, useMeetings } from "@/features/memory/memory-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubMemoryEntry,
  TeamHubMessageMeetingNotesSegment,
} from "@/features/teamhub/teamhub-types";

import { chatMessages } from "./chat.messages";

/** The recording whose quick notes a completion Message shows. */
export function captureQuickNotesQueryKey(captureId: string) {
  return ["teamhub", "voice-capture", captureId, "quick-notes"] as const;
}

/** How often a pending card looks again; the Room event usually comes first. */
const pendingRefreshMs = 3_000;

/**
 * Past the job's two attempts of up to a minute each, plus time waiting for
 * a place on the Runtime, notes still pending will not come: the card stops
 * looking and leaves them out.
 */
const pendingWindowMs = 300_000;

/**
 * A recording's quick notes under its recording and transcript: a progress
 * line while they are written, the notes once they are, then a line that
 * says where the full meeting notes appear and links to them once written.
 */
export function MessageMeetingNotes({
  segment,
  tenantId,
}: {
  segment: TeamHubMessageMeetingNotesSegment;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const [shownAt] = useState(() => Date.now());
  const capture = useQuery({
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/voice-captures/{captureSessionId}", {
          params: { path: { captureSessionId: segment.capture_id } },
        }),
      ),
    queryKey: captureQuickNotesQueryKey(segment.capture_id),
    refetchInterval: (query) =>
      query.state.data?.quick_notes?.state === "pending" &&
      query.state.dataUpdatedAt - shownAt < pendingWindowMs
        ? pendingRefreshMs
        : false,
  });
  const notes = capture.data?.quick_notes;
  const gaveUp =
    notes?.state === "pending" &&
    capture.dataUpdatedAt - shownAt >= pendingWindowMs;
  // Notes that could not be written show nothing: the recording and
  // transcript stand alone, with where the full notes will appear.
  if (notes?.state === "failed" || gaveUp || capture.isError) {
    return (
      <section
        aria-label={t(chatMessages.meetingNotes)}
        className="w-full max-w-[var(--chat-card-width)] rounded-xl border border-app-border bg-app-surface"
      >
        <FullNotesStatus captureId={segment.capture_id} tenantId={tenantId} />
      </section>
    );
  }
  return (
    <section
      aria-label={t(chatMessages.meetingSummary)}
      className="w-full max-w-[var(--chat-card-width)] overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-[var(--chat-card-shadow)]"
    >
      {notes?.state === "ready" && notes.title && notes.sections ? (
        <div className="px-4 pt-3 pb-1">
          <p className="flex items-center gap-1 text-[11.5px] font-semibold uppercase tracking-wide text-app-muted">
            <Icon icon={SparklesIcon} size={12} />
            {t(chatMessages.meetingSummary)}
          </p>
          <h3 className="mt-1 text-[16px] font-semibold leading-6 text-app-ink [overflow-wrap:anywhere]">
            {notes.title}
          </h3>
          {notes.sections.map((section, index) => (
            <div key={`${index}:${section.heading}`}>
              <p className="mt-3 mb-1 flex gap-1.5 text-[13.5px] font-semibold text-app-ink">
                <span
                  aria-hidden="true"
                  className="font-medium text-app-border-strong"
                >
                  #
                </span>
                {section.heading}
              </p>
              <ul className="list-disc space-y-0.5 pl-[18px] text-[15px] leading-[22px] text-app-ink marker:text-app-border-strong">
                {section.bullets.map((bullet, bulletIndex) => (
                  <li
                    className="[overflow-wrap:anywhere]"
                    key={`${bulletIndex}:${bullet}`}
                  >
                    {bullet}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 pt-3 pb-2" role="status">
          <div className="h-[3px] overflow-hidden rounded-full bg-app-surface-soft">
            <div className="h-full w-2/5 animate-pulse rounded-full bg-app-ink" />
          </div>
          <p className="mt-2 flex items-center gap-2 text-[13px] text-app-muted">
            <Icon className="animate-spin" icon={Loading03Icon} size={14} />
            {t(chatMessages.pullingKeyPoints)}
          </p>
        </div>
      )}
      <div className="border-t border-app-border">
        <FullNotesStatus captureId={segment.capture_id} tenantId={tenantId} />
      </div>
    </section>
  );
}

function FullNotesStatus({
  captureId,
  tenantId,
}: {
  captureId: string;
  tenantId: string;
}) {
  // Refreshing stops once this meeting's full notes are written.
  const meetings = useMeetings(tenantId, (entries) =>
    Boolean(findMeeting(entries, captureId)?.meeting?.summary_ready),
  );
  const meeting = meetings.data && findMeeting(meetings.data, captureId);
  const ready = Boolean(meeting?.meeting?.summary_ready);
  const t = useT();
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 text-[13px] leading-[18px] text-app-muted">
      {ready && meeting ? (
        <>
          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-app-success text-white">
            <Icon icon={Tick02Icon} size={10} />
          </span>
          <span className="min-w-0 flex-1">
            <strong className="font-semibold text-app-ink">
              {t(chatMessages.fullNotesReady)}
            </strong>
          </span>
          <Link
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-app-action px-3 py-1.5 text-[13px] font-medium text-app-action-foreground hover:bg-app-action-hover"
            to={meetingPath(tenantId, meeting.id)}
          >
            {t(commonMessages.open)}
            <Icon icon={ArrowRight01Icon} size={14} />
          </Link>
        </>
      ) : (
        <>
          <Icon
            className="shrink-0 animate-spin"
            icon={Loading03Icon}
            size={14}
          />
          <span className="min-w-0 flex-1">
            <RichMessage
              message={chatMessages.fullNotesSoon}
              tags={{
                link: (text) => (
                  <Link
                    className="text-app-ink underline decoration-app-border-strong underline-offset-[3px]"
                    to={`/t/${encodeURIComponent(tenantId)}/library/meetings`}
                  >
                    {text}
                  </Link>
                ),
              }}
            />
          </span>
        </>
      )}
    </div>
  );
}

function findMeeting(entries: TeamHubMemoryEntry[], captureId: string) {
  return entries.find((entry) => entry.meeting?.capture_id === captureId);
}
