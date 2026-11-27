import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { tenantLocalModelsQueryKey } from "@/features/local-models/local-models-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";
import { useT } from "@/i18n/use-translation";
import type { AgentRuntimeUpdateInput } from "../members/edit-agent-runtime-dialog";
const EditAgentRuntimeDialog = lazy(async () => ({
  default: (await import("../members/edit-agent-runtime-dialog"))
    .EditAgentRuntimeDialog,
}));
import {
  reasoningEffortLabel,
  useResolvedAgentModelLabel,
} from "../members/use-agent-model-selection";
import {
  anotherMeQueryKey,
  tenantAgentAvailabilityQueryKey,
  tenantAgentsQueryKey,
} from "../room-queries";
import { composerMessages } from "./composer.messages";
import "./direct-agent-model-switch.css";

interface Props {
  client: TeamHubClient;
  currentActorId?: string;
  registration: TeamHubTenantAgent;
  tenantId: string;
  busy?: boolean;
}

export function DirectAgentModelSwitch(props: Props) {
  const { currentActorId, registration } = props;
  if (!currentActorId || registration.created_by.id !== currentActorId)
    return null;
  return <RuntimeSettingsEntry {...props} />;
}

function RuntimeSettingsEntry({ client, registration, tenantId, busy }: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const effort = registration.runtime.reasoning_effort;
  const label = useResolvedAgentModelLabel(
    client,
    tenantId,
    registration.runtime,
  );
  const update = useMutation({
    mutationFn: (input: AgentRuntimeUpdateInput) =>
      teamHubData(
        client.api.PATCH("/v0/tenants/{tenantId}/agents/{agentId}", {
          params: { path: { tenantId, agentId: registration.actor.id } },
          body: {
            ...input,
            expected_configuration_revision:
              registration.configuration_revision,
          },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        tenantAgentsQueryKey(tenantId),
        (current: { items: TeamHubTenantAgent[] } | undefined) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.actor.id === updated.actor.id
                    ? { ...item, ...updated }
                    : item,
                ),
              }
            : current,
      );
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: tenantAgentsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantAgentAvailabilityQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: anotherMeQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantLocalModelsQueryKey(tenantId),
        }),
      ]);
      setOpen(false);
    },
  });
  return (
    <div className="agent-model-switch">
      <button
        className="agent-model-switch-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          update.reset();
          setOpen(true);
        }}
      >
        <span className="agent-model-switch-trigger-label">{label}</span>
        {/* A long model label shortens with an ellipsis; the effort stays. */}
        {effort ? (
          <>
            {" "}
            <span className="agent-model-switch-trigger-effort">
              {reasoningEffortLabel(effort, t)}
            </span>
          </>
        ) : null}
      </button>
      {open ? (
        <Suspense
          fallback={
            <span role="status" className="text-xs text-app-muted">
              {t(composerMessages.loadingSettings)}
            </span>
          }
        >
          <EditAgentRuntimeDialog
            client={client}
            registration={registration}
            tenantId={tenantId}
            busy={busy}
            isPending={update.isPending}
            error={update.error?.message}
            onClose={() => {
              if (!update.isPending) setOpen(false);
            }}
            onSave={(input) => update.mutate(input)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
