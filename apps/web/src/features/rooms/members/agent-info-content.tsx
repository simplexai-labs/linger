/* eslint-disable jsx-a11y/no-autofocus -- The name input is mounted only after an explicit edit action. */
import { useQuery } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  inlineNameButtonClassName,
  inlineNameInputClassName,
} from "@/components/ui/inline-name";
import { AgentConnectors } from "@/features/apps/agent-connectors";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import type {
  TeamHubActor,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
} from "@/features/teamhub/teamhub-types";

import { tenantAgentsQueryOptions } from "../room-queries";
import { ActorAvatar } from "./actor-avatar";
import { AvatarEditButton } from "./avatar-edit-button";
import { agentInfoMessages } from "./agent-info.messages";
import { AgentStatus } from "./agent-status";

const RemindersPanel = lazy(() =>
  import("../task-sidebar/reminders-panel").then((module) => ({
    default: module.RemindersPanel,
  })),
);

const AGENT_INFO_TABS = [
  ["basic", agentInfoMessages.tabDetails],
  ["routines", agentInfoMessages.tabRoutines],
  ["connectors", agentInfoMessages.tabConnectors],
] as const satisfies readonly (readonly [string, Message<string>])[];

type AgentInfoTab = (typeof AGENT_INFO_TABS)[number][0];

export function AgentInfoContent({
  actor,
  availability,
  canEditIdentity = false,
  canEditName = false,
  nameBusy = false,
  nameError,
  onSaveName,
  details,
  detailsActions,
  dialogs,
  description,
  onEditIdentity,
  registration,
  roomId,
  runtimeDetails,
  tenantId,
}: {
  actor: TeamHubActor;
  tenantId: string;
  availability?: TeamHubTenantAgentAvailabilitySnapshot["availability"];
  canEditIdentity?: boolean;
  canEditName?: boolean;
  nameBusy?: boolean;
  nameError?: string;
  onSaveName?: (name: string) => Promise<unknown>;
  details: ReactNode;
  /** Basic info actions placed after the instructions, such as removing the Agent. */
  detailsActions?: ReactNode;
  dialogs?: ReactNode;
  runtimeDetails?: ReactNode;
  description?: string;
  onEditIdentity?: () => void;
  registration?: TeamHubTenantAgent;
  /** Routines are listed per Room, so the Routines tab needs the open Room. */
  roomId?: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const { data: agents } = useQuery(tenantAgentsQueryOptions(client, tenantId));
  const liveRegistration =
    agents?.items.find((item) => item.actor.id === actor.id) ?? registration;
  const [tab, setTab] = useState<AgentInfoTab>("basic");
  const tabId = useId();
  return (
    <div className="agent-info-content flex h-full min-h-0 min-w-0 flex-col bg-sidebar/50">
      <AgentInfoIdentity
        actor={actor}
        availability={availability}
        canEdit={canEditIdentity}
        canEditName={canEditName}
        nameBusy={nameBusy}
        nameError={nameError}
        onSaveName={onSaveName}
        description={
          liveRegistration?.agent_type === "anotherme" ? undefined : description
        }
        onEdit={onEditIdentity}
      />
      <div className="shrink-0 px-4 pb-4">
        <div
          className="mx-auto flex w-fit max-w-full gap-1.5"
          role="tablist"
          aria-label={t(agentInfoMessages.settingsTabs)}
        >
          {AGENT_INFO_TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              onKeyDown={(event) => {
                const index = AGENT_INFO_TABS.findIndex(([key]) => key === id);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % AGENT_INFO_TABS.length
                    : event.key === "ArrowLeft"
                      ? (index + AGENT_INFO_TABS.length - 1) %
                        AGENT_INFO_TABS.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? AGENT_INFO_TABS.length - 1
                          : undefined;
                if (next === undefined) return;
                event.preventDefault();
                const key = AGENT_INFO_TABS[next]![0];
                setTab(key);
                document.getElementById(`${tabId}-tab-${key}`)?.focus();
              }}
              aria-controls={`${tabId}-${id}`}
              id={`${tabId}-tab-${id}`}
              onClick={() => setTab(id)}
              className={`h-7 w-[92px] min-w-0 shrink truncate rounded-full px-3 font-(family-name:--app-room-font) transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                tab === id
                  ? "bg-sidebar-muted text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-muted/50 hover:text-foreground"
              }`}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      <div
        hidden={tab !== "basic"}
        className="agent-settings-column workspace-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-6 [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
        role="tabpanel"
        id={`${tabId}-basic`}
        aria-labelledby={`${tabId}-tab-basic`}
      >
        {details}
        {detailsActions}
      </div>
      {tab === "routines" ? (
        <div
          className="agent-settings-column flex min-h-0 flex-1 flex-col"
          role="tabpanel"
          id={`${tabId}-routines`}
          aria-labelledby={`${tabId}-tab-routines`}
        >
          <AgentRoutines actor={actor} roomId={roomId} tenantId={tenantId} />
        </div>
      ) : null}
      {tab === "connectors" ? (
        <div
          className="agent-settings-column workspace-scrollbar min-h-0 flex-1 overflow-y-auto pb-6 [scrollbar-gutter:stable_both-edges]"
          role="tabpanel"
          id={`${tabId}-connectors`}
          aria-labelledby={`${tabId}-tab-connectors`}
        >
          {runtimeDetails ? <div hidden>{runtimeDetails}</div> : null}
          <AgentConnectors agentActorId={actor.id} tenantId={tenantId} />
        </div>
      ) : null}
      {dialogs}
    </div>
  );
}

function AgentRoutines({
  actor,
  roomId,
  tenantId,
}: {
  actor: TeamHubActor;
  roomId?: string;
  tenantId: string;
}) {
  const t = useT();
  if (!roomId) {
    return (
      <p
        className="px-6 py-8 text-center text-xs text-muted-foreground"
        role="status"
      >
        {t(agentInfoMessages.routinesNeedRoom)}
      </p>
    );
  }
  return (
    <Suspense fallback={null}>
      <RemindersPanel
        agentActorId={actor.id}
        mentionOptions={[actor]}
        roomId={roomId}
        tenantId={tenantId}
      />
    </Suspense>
  );
}

function AgentInfoIdentity({
  actor,
  availability,
  canEdit,
  canEditName,
  nameBusy,
  nameError,
  onSaveName,
  description,
  onEdit,
}: {
  description?: string;
  actor: TeamHubActor;
  availability?: TeamHubTenantAgentAvailabilitySnapshot["availability"];
  canEdit: boolean;
  canEditName: boolean;
  nameBusy: boolean;
  nameError?: string;
  onSaveName?: (name: string) => Promise<unknown>;
  onEdit?: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(actor.display_name);
  const [focusAfterError, setFocusAfterError] = useState(false);
  const saving = useRef(false);
  const editNameButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      editNameButton.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (editing && focusAfterError && !nameBusy) {
      nameInput.current?.focus();
      setFocusAfterError(false);
    }
  }, [editing, focusAfterError, nameBusy]);
  async function saveName() {
    if (saving.current) return;
    const name = draft.trim();
    if (!name || name === actor.display_name) {
      setDraft(actor.display_name);
      setEditing(false);
      return;
    }
    saving.current = true;
    try {
      await onSaveName?.(name);
      setEditing(false);
    } catch {
      // Restore keyboard focus after the input is enabled again.
      if (restoreFocus.current) setFocusAfterError(true);
      restoreFocus.current = false;
    } finally {
      saving.current = false;
    }
  }
  const avatar = (
    <ActorAvatar
      actorId={actor.id}
      kind="agent"
      name={actor.display_name}
      // The edit hint replaces the native name tooltip so two never overlap.
      showTitle={!canEdit}
      size="card"
    />
  );
  return (
    <div className="mx-auto flex w-full max-w-[780px] flex-col items-center px-5 pb-4 pt-5 text-center">
      {canEdit ? (
        <AvatarEditButton
          label={t(agentInfoMessages.editAvatar)}
          onClick={onEdit}
        >
          {avatar}
        </AvatarEditButton>
      ) : (
        avatar
      )}
      {editing ? (
        <input
          aria-label={t(agentInfoMessages.agentName)}
          ref={nameInput}
          autoFocus
          className={`mt-2.5 text-center text-[15px] font-semibold leading-5 text-foreground ${inlineNameInputClassName}`}
          disabled={nameBusy}
          maxLength={120}
          onBlur={() => void saveName()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              restoreFocus.current = true;
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              restoreFocus.current = true;
              setDraft(actor.display_name);
              setEditing(false);
            }
          }}
          value={draft}
        />
      ) : canEditName ? (
        <h2 className="mt-2.5 max-w-full text-[15px] font-semibold leading-5 text-foreground">
          <button
            ref={editNameButton}
            aria-label={t(agentInfoMessages.editName, {
              name: actor.display_name,
            })}
            className={inlineNameButtonClassName}
            disabled={nameBusy}
            title={actor.display_name}
            onClick={() => {
              setDraft(actor.display_name);
              setEditing(true);
            }}
            type="button"
          >
            {actor.display_name}
          </button>
        </h2>
      ) : (
        <h2
          className="mt-2.5 max-w-full truncate px-2 text-[15px] font-semibold leading-5 text-foreground"
          title={actor.display_name}
        >
          {actor.display_name}
        </h2>
      )}
      {editing && nameError ? (
        <p className="mt-1 text-xs text-app-danger" role="alert">
          {nameError}
        </p>
      ) : null}
      {description ? (
        <p className="mt-1 line-clamp-2 max-w-[22rem] text-xs leading-[18px] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {availability ? (
        <p className="mt-1 text-xs">
          <AgentStatus availability={availability} />
        </p>
      ) : null}
    </div>
  );
}
