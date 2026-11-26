import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Delete02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { commonMessages } from "@/i18n/common.messages";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowText,
} from "@/components/ui/settings-group";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubRoutine,
  TeamHubScheduledRoutine,
} from "@/features/teamhub/teamhub-types";
import { useT } from "@/i18n/use-translation";

import { connectedAppDisplayName } from "../cards/connected-app-names";

import {
  roomRoutinesQueryKey,
  roomRoutinesQueryOptions,
  tenantAgentsQueryOptions,
} from "../room-queries";
import {
  cadenceLabel,
  dayHeading,
  formatTimeOfDay,
  formatWhen,
  isEditableRoutine,
  isScheduled,
} from "./routine-cadence";
import { deleteRoomRoutine, RoutineDialog } from "./routine-dialog";
import { PanelLoading } from "./panel-loading";
import { routinesMessages as m } from "./routines.messages";

/** One Agent's Routines in a Room, laid out by the day they next run. */
export function RemindersPanel({
  agentActorId,
  hidden = false,
  mentionOptions,
  roomId,
  tenantId,
}: {
  /** Lists routines this Agent created or is mentioned by; new ones mention it. */
  agentActorId?: string;
  hidden?: boolean;
  mentionOptions: TeamHubActorRef[];
  roomId: string;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const listQuery = useQuery(
    roomRoutinesQueryOptions(client, tenantId, roomId),
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const routines = (listQuery.data?.items ?? []).filter(
    (item) =>
      !agentActorId ||
      (isScheduled(item) &&
        (item.created_by_actor_id === agentActorId ||
          item.mention_actor_id === agentActorId)),
  );
  const open =
    openId && openId !== "new"
      ? routines
          .filter(isScheduled)
          .find((item) => item.id === openId && isEditableRoutine(item))
      : undefined;

  return (
    <section
      aria-label={t(m.routines)}
      className="workspace-scrollbar flex h-full min-h-0 flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges]"
      data-testid="panel-routines"
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <RoutineAgenda
        agentActorId={agentActorId}
        client={client}
        failed={listQuery.isError}
        loading={listQuery.isPending}
        routines={routines}
        tenantId={tenantId}
        onCreate={() => setOpenId("new")}
        onOpen={setOpenId}
      />
      {openId === "new" || open ? (
        <RoutineDialog
          agentScoped={Boolean(agentActorId)}
          client={client}
          mentionActorId={agentActorId}
          mentionOptions={mentionOptions.filter(
            (actor) => actor.kind === "agent",
          )}
          routine={open}
          roomId={roomId}
          onClose={() => setOpenId(null)}
          onSaved={async () => {
            await queryClient.invalidateQueries({
              queryKey: roomRoutinesQueryKey(tenantId, roomId),
            });
            setOpenId(null);
          }}
        />
      ) : null}
    </section>
  );
}

// A one-shot Routine past its time is done and cannot run again; one paused
// before its time can still be turned back on.
function isDone(routine: TeamHubScheduledRoutine) {
  return (
    !routine.enabled &&
    routine.cadence.kind === "once" &&
    Date.parse(routine.cadence.run_at ?? "") <= Date.now()
  );
}

function runTime(routine: TeamHubScheduledRoutine) {
  return Date.parse(routine.next_run_at ?? routine.cadence.run_at ?? "");
}

function RoutineAgenda({
  agentActorId,
  client,
  failed,
  loading,
  onCreate,
  onOpen,
  routines,
  tenantId,
}: {
  agentActorId?: string;
  client: TeamHubClient;
  failed: boolean;
  loading: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
  routines: TeamHubRoutine[];
  tenantId: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [showDone, setShowDone] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // The Routine as the last pause or enable left it, offered for undo for a
  // few seconds.
  const [offer, setOffer] = useState<{
    routine: TeamHubRoutine;
    secondsLeft: number;
  } | null>(null);
  const undo = useMutation({
    mutationFn: (routine: TeamHubRoutine) =>
      teamHubData(
        client.api.PATCH("/v0/routines/{routineId}", {
          params: { path: { routineId: routine.id } },
          body: {
            expected_revision: routine.revision,
            enabled: !routine.enabled,
          },
        }),
      ),
    onSuccess: async (routine) => {
      setOffer(null);
      await queryClient.invalidateQueries({
        queryKey: roomRoutinesQueryKey(tenantId, routine.room_id),
      });
    },
  });
  useEffect(() => {
    // Hold the countdown while an undo is in flight, so its failure shows.
    if (!offer || undo.isPending) return;
    const timer = window.setTimeout(
      () =>
        setOffer((current) =>
          current && current.secondsLeft > 1
            ? { ...current, secondsLeft: current.secondsLeft - 1 }
            : null,
        ),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [offer, undo.isPending]);
  if (loading) {
    return <PanelLoading label={t(m.loading)} />;
  }
  if (failed) {
    return (
      <p className="px-4 py-6 text-sm text-destructive" role="alert">
        {t(m.loadFailed)}
      </p>
    );
  }
  const onToggled = (routine: TeamHubRoutine) => {
    setDeleteError(null);
    undo.reset();
    setOffer({ routine, secondsLeft: UNDO_SECONDS });
  };
  const onDeleted = (routineId: string) => {
    setDeleteError(null);
    setOffer((current) => (current?.routine.id === routineId ? null : current));
  };
  const scheduled = routines.filter(isScheduled);
  const listeners = routines.filter((routine) => !isScheduled(routine));
  const reminders = scheduled.filter(
    (routine) => routine.enabled && routine.cadence.kind === "once",
  );
  const recurring = scheduled
    .filter((routine) => routine.enabled && routine.cadence.kind !== "once")
    .sort(
      (a, b) =>
        Date.parse(a.next_run_at ?? "9999") -
        Date.parse(b.next_run_at ?? "9999"),
    );
  const paused = scheduled.filter(
    (routine) => !routine.enabled && !isDone(routine),
  );
  const done = scheduled.filter(isDone);
  const upcoming = [...reminders].sort((a, b) => runTime(a) - runTime(b));
  const rowProps = {
    agentActorId,
    client,
    onDeleteError: setDeleteError,
    onDeleted,
    onToggled,
    tenantId,
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 pb-6 font-(family-name:--app-room-font)">
      {deleteError ? (
        <p className="px-1.5 text-sm text-destructive" role="alert">
          {deleteError}
        </p>
      ) : null}
      {scheduled.length === 0 && listeners.length === 0 ? (
        <SettingsGroup ariaLabel={t(m.noRoutines)}>
          <SettingsRow icon={<Icon icon={Clock01Icon} size={16} />}>
            <span className="min-w-0 flex-1 py-1">
              <span className="block text-[14px] font-medium leading-[18px] text-foreground">
                {t(m.emptyTitle)}
              </span>
              <span className="mt-0.5 block text-xs leading-[17px] text-muted-foreground">
                {t(m.emptyBody)}
              </span>
            </span>
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      {listeners.length > 0 ? (
        <SettingsGroup label={t(m.watching)}>
          <ul aria-label={t(m.appListeners)}>
            {listeners.map((routine) => (
              <ListenerRow
                client={client}
                key={routine.id}
                routine={routine}
                tenantId={tenantId}
                onToggled={onToggled}
              />
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
      {upcoming.length > 0 ? (
        <SettingsGroup label={t(m.upcoming)} meta={upcoming.length}>
          <ul>
            {upcoming.map((routine) => {
              const { day, distance } = dayHeading(
                new Date(runTime(routine)),
                new Date(),
                t,
              );
              const time = formatTimeOfDay(
                new Date(runTime(routine)).toISOString(),
              );
              return (
                <RoutineRow
                  {...rowProps}
                  detail={
                    distance
                      ? t(m.upcomingDetailDistance, { day, time, distance })
                      : t(m.upcomingDetail, { day, time })
                  }
                  key={routine.id}
                  routine={routine}
                  onOpen={() => onOpen(routine.id)}
                />
              );
            })}
          </ul>
        </SettingsGroup>
      ) : null}
      {recurring.length > 0 ? (
        <SettingsGroup label={t(m.recurring)} meta={recurring.length}>
          <ul>
            {recurring.map((routine) => (
              <RoutineRow
                {...rowProps}
                detail={cadenceLabel(routine.cadence, t)}
                key={routine.id}
                routine={routine}
                onOpen={() => onOpen(routine.id)}
              />
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
      {paused.length > 0 ? (
        <SettingsGroup label={t(m.paused)} meta={paused.length}>
          <ul>
            {paused.map((routine) => (
              <RoutineRow
                {...rowProps}
                detail={
                  routine.cadence.kind === "once"
                    ? formatWhen(routine.cadence.run_at ?? "")
                    : cadenceLabel(routine.cadence, t)
                }
                key={routine.id}
                routine={routine}
                onOpen={() => onOpen(routine.id)}
              />
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
      {done.length > 0 ? (
        <section aria-label={t(m.done)}>
          <div className="px-1.5">
            <button
              aria-expanded={showDone}
              className="flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setShowDone((current) => !current)}
              type="button"
            >
              {t(m.done)}
              <span className="tabular-nums text-muted-foreground/80">
                {done.length}
              </span>
              <Icon
                icon={showDone ? ArrowDown01Icon : ArrowRight01Icon}
                size={12}
              />
            </button>
          </div>
          {showDone ? (
            <SettingsGroup ariaLabel={t(m.doneRoutines)}>
              <ul>
                {done.map((routine) => (
                  <li key={routine.id}>
                    <button
                      className="block w-full text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                      onClick={() => onOpen(routine.id)}
                      type="button"
                    >
                      <SettingsRow
                        icon={<Icon icon={CheckmarkCircle02Icon} size={16} />}
                      >
                        <SettingsRowText
                          description={formatWhen(routine.cadence.run_at ?? "")}
                          muted
                          title={routine.name}
                        />
                      </SettingsRow>
                    </button>
                  </li>
                ))}
              </ul>
            </SettingsGroup>
          ) : null}
        </section>
      ) : null}
      <SettingsGroup>
        <button
          className="block w-full text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
          onClick={onCreate}
          type="button"
        >
          <SettingsRow icon={<Icon icon={PlusSignIcon} size={16} />}>
            <span className="flex-1 text-[14px] font-medium text-foreground">
              {t(m.newRoutine)}
            </span>
            <Icon
              className="text-muted-foreground/70"
              icon={ArrowRight01Icon}
              size={14}
            />
          </SettingsRow>
        </button>
      </SettingsGroup>
      {offer ? (
        <div className="sticky bottom-4 mt-auto px-1.5">
          <UndoToast
            failed={undo.isError}
            pending={undo.isPending}
            routine={offer.routine}
            secondsLeft={offer.secondsLeft}
            onUndo={() => undo.mutate(offer.routine)}
          />
        </div>
      ) : null}
    </div>
  );
}

// Matches the 5s of .town-countdown-ring in globals.css.
const UNDO_SECONDS = 5;

interface ToggleProps {
  client: TeamHubClient;
  onToggled: (routine: TeamHubRoutine) => void;
  tenantId: string;
}

function RoutineRow({
  agentActorId,
  detail,
  onDeleteError,
  onDeleted,
  onOpen,
  routine,
  ...toggle
}: ToggleProps & {
  agentActorId?: string;
  detail: string;
  onDeleteError: (message: string | null) => void;
  onDeleted: (routineId: string) => void;
  onOpen: () => void;
  routine: TeamHubScheduledRoutine;
}) {
  const t = useT();
  const wakesOther = Boolean(
    routine.mention_actor_id && routine.mention_actor_id !== agentActorId,
  );
  const agents = useQuery({
    ...tenantAgentsQueryOptions(toggle.client, toggle.tenantId),
    enabled: wakesOther,
  });
  const target = agents.data?.items.find(
    (item) => item.actor.id === routine.mention_actor_id,
  );
  // The Agent whose Info this is goes without saying; say who else wakes.
  const description = !routine.mention_actor_id
    ? t(m.detailMessageOnly, { detail })
    : !wakesOther
      ? detail
      : target
        ? t(m.detailWakes, { detail, name: target.actor.display_name })
        : t(m.detailWakesAgent, { detail });
  if (!isEditableRoutine(routine)) {
    return (
      <li>
        <SettingsRow icon={<Icon icon={Clock01Icon} size={16} />}>
          <SettingsRowText
            description={description}
            muted={!routine.enabled}
            title={routine.name}
          />
          <div className="flex shrink-0 items-center gap-2">
            <RoutineDeleteButton
              client={toggle.client}
              onDeleted={() => onDeleted(routine.id)}
              onError={onDeleteError}
              routine={routine}
              tenantId={toggle.tenantId}
            />
            <RoutineSwitch routine={routine} {...toggle} />
          </div>
        </SettingsRow>
      </li>
    );
  }
  return (
    <li className="group transition-colors duration-150 hover:bg-muted/40">
      <SettingsRow icon={<Icon icon={Clock01Icon} size={16} />}>
        <button
          className="-my-1 flex min-w-0 flex-1 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpen}
          type="button"
        >
          <SettingsRowText
            description={description}
            muted={!routine.enabled}
            title={routine.name}
          />
        </button>
        <RoutineSwitch routine={routine} {...toggle} />
      </SettingsRow>
    </li>
  );
}

function RoutineDeleteButton({
  client,
  onDeleted,
  onError,
  routine,
  tenantId,
}: {
  client: TeamHubClient;
  onDeleted: () => void;
  onError: (message: string | null) => void;
  routine: TeamHubScheduledRoutine;
  tenantId: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteRoomRoutine(client, routine),
    onMutate: () => onError(null),
    onSuccess: async () => {
      setConfirmOpen(false);
      onDeleted();
      await queryClient.invalidateQueries({
        queryKey: roomRoutinesQueryKey(tenantId, routine.room_id),
      });
    },
    onError: (cause) => {
      setConfirmOpen(false);
      onError(cause instanceof Error ? cause.message : t(m.deleteFailed));
    },
  });
  return (
    <>
      <button
        data-voice-risk="never"
        aria-label={t(m.deleteRoutine)}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        disabled={remove.isPending}
        onClick={() => setConfirmOpen(true)}
        title={t(m.deleteRoutine)}
        type="button"
      >
        <Icon icon={Delete02Icon} size={14} />
      </button>
      {confirmOpen ? (
        <ModalDialog
          description={t(m.deleteRoutineConfirmDescription, {
            name: routine.name,
          })}
          footer={
            <>
              <Button
                disabled={remove.isPending}
                onClick={() => setConfirmOpen(false)}
                size="compact"
              >
                {t(commonMessages.cancel)}
              </Button>
              <Button
                data-voice-risk="never"
                loading={remove.isPending}
                onClick={() => remove.mutate()}
                size="compact"
                tone="danger"
              >
                {t(commonMessages.delete)}
              </Button>
            </>
          }
          onClose={() => {
            if (!remove.isPending) setConfirmOpen(false);
          }}
          size="sm"
          title={t(m.deleteRoutineConfirmTitle)}
        >
          {null}
        </ModalDialog>
      ) : null}
    </>
  );
}

function ListenerRow({
  routine,
  ...toggle
}: ToggleProps & { routine: TeamHubRoutine }) {
  const t = useT();
  const app = connectedAppDisplayName(routine.listener?.app);
  return (
    <li>
      <SettingsRow
        icon={
          <span
            className={`size-2 rounded-full ${routine.enabled ? "bg-[var(--app-status-success-text)]" : "bg-input"}`}
          />
        }
      >
        <SettingsRowText
          description={routine.name}
          muted={!routine.enabled}
          title={t(routine.enabled ? m.watchingApp : m.notWatchingApp, { app })}
        />
        <RoutineSwitch routine={routine} {...toggle} />
      </SettingsRow>
    </li>
  );
}

function RoutineSwitch({
  client,
  onToggled,
  routine,
  tenantId,
}: ToggleProps & { routine: TeamHubRoutine }) {
  const t = useT();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      teamHubData(
        client.api.PATCH("/v0/routines/{routineId}", {
          params: { path: { routineId: routine.id } },
          body: {
            expected_revision: routine.revision,
            enabled,
          },
        }),
      ),
    onSuccess: async (saved) => {
      onToggled(saved);
      await queryClient.invalidateQueries({
        queryKey: roomRoutinesQueryKey(tenantId, routine.room_id),
      });
    },
  });
  return (
    <button
      aria-checked={routine.enabled}
      aria-label={t(routine.enabled ? m.pauseRoutine : m.enableRoutine)}
      className={`relative h-4 w-7 shrink-0 rounded-full shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${routine.enabled ? "bg-primary" : "bg-input"}`}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!routine.enabled)}
      role="switch"
      type="button"
    >
      <span
        className={`absolute left-0 top-0.5 size-3 rounded-full bg-card shadow-sm transition-transform duration-150 ${routine.enabled ? "translate-x-3.5" : "translate-x-0.5"}`}
      />
    </button>
  );
}

function UndoToast({
  failed,
  onUndo,
  pending,
  routine,
  secondsLeft,
}: {
  failed: boolean;
  onUndo: () => void;
  pending: boolean;
  routine: TeamHubRoutine;
  secondsLeft: number;
}) {
  const t = useT();
  return (
    <div
      className="town-toast-enter flex items-center gap-3 rounded-xl bg-popover px-4 py-2.5 text-sm text-foreground shadow-lg"
      role="status"
    >
      <span className="min-w-0 flex-1 truncate">
        {failed
          ? t(m.undoFailed)
          : t(routine.enabled ? m.enabledRoutine : m.pausedRoutine, {
              name: routine.name,
            })}
      </span>
      {failed ? null : (
        <>
          <span
            aria-hidden="true"
            className="relative grid size-5 shrink-0 place-items-center text-[10px] font-medium tabular-nums text-muted-foreground"
          >
            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 20 20">
              <circle
                className="stroke-border"
                cx="10"
                cy="10"
                fill="none"
                r="8.5"
                strokeWidth="2"
              />
              <circle
                className="town-countdown-ring stroke-foreground"
                cx="10"
                cy="10"
                fill="none"
                key={`${routine.id}:${routine.revision}`}
                pathLength={100}
                r="8.5"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </svg>
            {secondsLeft}
          </span>
          <button
            className="shrink-0 rounded-md px-1.5 py-0.5 font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={pending}
            onClick={onUndo}
            type="button"
          >
            {t(m.undo)}
          </button>
        </>
      )}
    </div>
  );
}
