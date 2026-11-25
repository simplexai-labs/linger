import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { tenantLocalModelsQueryKey } from "@/features/local-models/local-models-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";
import { useT } from "@/i18n/use-translation";
import type { AgentRuntimeUpdateInput } from "../members/edit-agent-runtime-dialog";
const EditAgentRuntimeDialog = lazy(async () => ({
  default: (await import("../members/edit-agent-runtime-dialog"))
    .EditAgentRuntimeDialog,
}));
import {
  reasoningEffortMessages,
  useResolvedAgentModelLabel,
} from "../members/use-agent-model-selection";
import { tenantAgentsQueryKey } from "../room-queries";
import { composerMessages } from "./composer.messages";
import "./direct-agent-model-switch.css";

const LOCAL_RUNTIME_LABELS: Record<TeamHubLocalRuntimeType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  antigravity: "Antigravity",
};

/**
 * Produces a concise human-readable label for the compact composer model pill:
 * removes verbose "Default (recommended) · " prefixes, strips upstream proxy
 * namespace prefixes (e.g. "sub2api-claude/"), and humanizes raw lowercase
 * hyphenated slugs while preserving already-formatted display names.
 */
export function formatModelPillLabel(rawLabel: string): string {
  let cleaned = rawLabel.trim();
  cleaned = cleaned.replace(/^default\s*\([^)]*\)\s*[·\-—:]\s*/i, "").trim();
  const slashIndex = cleaned.lastIndexOf("/");
  if (slashIndex > 0 && !/\s/.test(cleaned.slice(0, slashIndex))) {
    cleaned = cleaned.slice(slashIndex + 1).trim();
  }
  if (/^[a-z0-9][a-z0-9.-]*$/.test(cleaned) && cleaned.split("-").length >= 3) {
    const withVersion = cleaned.replace(/-(\d+)-(\d+)(?=$|-)/g, " $1.$2");
    cleaned = withVersion
      .split("-")
      .filter(Boolean)
      .map((part) => {
        if (/^\d+(?:\.\d+)?$/.test(part)) return part;
        if (/^\d+[a-z]$/.test(part)) return part.toUpperCase();
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }
  return cleaned || rawLabel;
}

interface Props {
  client: TeamHubClient;
  currentActorId?: string;
  registration: TeamHubTenantAgent;
  tenantId: string;
  busy?: boolean;
}

export function DirectAgentModelSwitch(props: Props) {
  const { currentActorId, registration } = props;
  const canEdit =
    Boolean(currentActorId) && registration.created_by.id === currentActorId;
  return <RuntimeSettingsEntry {...props} canEdit={canEdit} />;
}

function RuntimeSettingsEntry({
  client,
  registration,
  tenantId,
  busy,
  canEdit,
}: Props & { canEdit: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const effort = registration.runtime.reasoning_effort;
  const resolvedLabel = useResolvedAgentModelLabel(
    client,
    tenantId,
    registration.runtime,
  );
  const displayLabel = formatModelPillLabel(resolvedLabel);
  const placement = registration.runtime.placement;
  const computerId =
    placement?.type === "local" ? placement.computer_id : undefined;
  const computers = useQuery({
    ...localComputersQueryOptions(client, tenantId),
    enabled: Boolean(computerId),
  });
  const computerName = computerId
    ? computers.data?.items.find((item) => item.computer_id === computerId)
        ?.display_name
    : undefined;
  const runtimeLabel =
    placement?.type === "local" && placement.runtime_type
      ? LOCAL_RUNTIME_LABELS[placement.runtime_type]
      : undefined;
  const effortLabel = effort ? t(reasoningEffortMessages[effort]) : undefined;
  const detailParts: string[] = [];
  if (resolvedLabel) detailParts.push(resolvedLabel);
  if (
    registration.runtime.model &&
    !resolvedLabel.includes(registration.runtime.model)
  ) {
    detailParts.push(registration.runtime.model);
  }
  if (runtimeLabel) detailParts.push(runtimeLabel);
  if (computerName) detailParts.push(computerName);
  if (effortLabel) detailParts.push(effortLabel);
  const detailsTitle = detailParts.join(" · ");

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
          queryKey: tenantLocalModelsQueryKey(tenantId),
        }),
      ]);
      setOpen(false);
    },
  });

  const pillContent = (
    <>
      <span className="agent-model-switch-trigger-label">{displayLabel}</span>
      {/* A long model label shortens with an ellipsis; the effort stays. */}
      {effortLabel ? (
        <>
          {" "}
          <span aria-hidden="true" className="agent-model-switch-trigger-sep">
            ·
          </span>{" "}
          <span className="agent-model-switch-trigger-effort">
            {effortLabel}
          </span>
        </>
      ) : null}
    </>
  );

  if (!canEdit) {
    return (
      <div className="agent-model-switch">
        <span
          className="agent-model-switch-badge"
          data-testid="agent-model-readonly-badge"
          title={detailsTitle}
        >
          {pillContent}
        </span>
      </div>
    );
  }

  return (
    <div className="agent-model-switch">
      <button
        className="agent-model-switch-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={detailsTitle}
        onClick={() => {
          update.reset();
          setOpen(true);
        }}
      >
        {pillContent}
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
