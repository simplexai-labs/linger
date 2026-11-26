import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { collectTeamHubCursorPages } from "@/features/teamhub/teamhub-cursor-pages";
import { tenantRoomsQueryOptions } from "../room-queries";

import { readStoredAgentAvatarKey } from "../members/agent-avatar";

import { agentTemplateFromAgent } from "./agent-template";
import {
  TemplateContents,
  useTemplateContentGroups,
} from "./agent-template-contents";
import { agentTemplatesQueryKey } from "./agent-template-queries";
import { agentTemplateMessages as m } from "./agent-templates.messages";
import { useAgentConnectorKeys } from "./use-agent-connector-keys";

/**
 * Publishing shares the portable part of this Agent so anyone can create their
 * own from it. Runtime, model, and Local Computer stay with this Agent.
 */
export function PublishAgentTemplateDialog({
  onClose,
  registration,
  tenantId,
}: {
  onClose: () => void;
  registration: TeamHubTenantAgent;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const queryClient = useQueryClient();
  const formId = useId();
  const routines = useQuery({
    queryKey: [
      "teamhub",
      tenantId,
      "agent-template-source-routines",
      registration.actor.id,
    ],
    queryFn: async () => {
      const rooms = await queryClient.fetchQuery({
        ...tenantRoomsQueryOptions(client, tenantId),
        staleTime: 0,
      });
      const room = rooms.items.find(
        (item) => item.direct_peer?.id === registration.actor.id,
      );
      if (!room) return [];
      // A template carries recurring Routines only; one-shot and app
      // listener Routines stay with the source Agent.
      return (
        await collectTeamHubCursorPages((page) =>
          teamHubData(
            client.api.GET("/v0/rooms/{roomId}/routines", {
              params: { path: { roomId: room.id }, query: page },
            }),
          ),
        )
      ).items.flatMap((routine) =>
        routine.cadence && routine.cadence.kind !== "once"
          ? [{ ...routine, cadence: routine.cadence }]
          : [],
      );
    },
    retry: false,
  });
  const [name, setName] = useState(registration.actor.display_name);
  const connectors = useAgentConnectorKeys({
    agentActorId: registration.actor.id,
    tenantId,
  });
  const template = agentTemplateFromAgent(
    registration,
    readStoredAgentAvatarKey(registration.actor.id),
    connectors.keys,
  );
  const groups = useTemplateContentGroups({
    connector_bindings: template.connector_bindings ?? [],
    skill_bindings: template.skill_bindings ?? [],
  });
  const publish = useMutation({
    mutationFn: () =>
      teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/agent-templates", {
          params: { path: { tenantId } },
          body: { ...template, name: name.trim() },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: agentTemplatesQueryKey(tenantId),
      });
      onClose();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      name.trim() &&
      !publish.isPending &&
      !connectors.isPending &&
      routines.isSuccess
    ) {
      publish.mutate();
    }
  }

  return (
    <ModalDialog
      onClose={onClose}
      size="md"
      title={t(m.publishTitle)}
      footer={
        <>
          <Button onClick={onClose} type="button">
            {t(commonMessages.cancel)}
          </Button>
          <Button
            disabled={
              !name.trim() || connectors.isPending || !routines.isSuccess
            }
            form={formId}
            loading={publish.isPending}
            tone="primary"
            type="submit"
          >
            {t(m.publish)}
          </Button>
        </>
      }
    >
      <form className="px-5 py-4" id={formId} onSubmit={submit}>
        <fieldset className="space-y-4" disabled={publish.isPending}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">
              {t(m.templateName)}
            </span>
            <input
              aria-label={t(m.templateName)}
              className="ui-field-control w-full"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>
          <div>
            <p className="mb-2 text-sm font-medium">{t(m.sharedWithOthers)}</p>
            {connectors.isPending || routines.isPending ? (
              <p className="text-sm text-app-muted" role="status">
                {t(m.checkingAgent)}
              </p>
            ) : (
              <TemplateContents
                connectorNote={t(m.publishConnectorNote)}
                groups={groups}
                instructions={registration.instructions}
                routines={routines.data}
              />
            )}
          </div>
          <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm leading-5 text-app-muted">
            {t(m.staysPrivate)}
          </p>
        </fieldset>
        {routines.error ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {t(m.routinesLoadFailed)}{" "}
            <Button onClick={() => void routines.refetch()} type="button">
              {t(commonMessages.retry)}
            </Button>
          </p>
        ) : null}
        {publish.error ? (
          <p className="mt-3 text-sm leading-5 text-app-danger" role="alert">
            {publish.error.message}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
}
