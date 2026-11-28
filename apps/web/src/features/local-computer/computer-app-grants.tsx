import { LaptopIcon } from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import {
  computerAppGrantsQueryKey,
  computerAppGrantsQueryOptions,
  revokeComputerAppGrant,
} from "./app-grants-api";
import { ComputerRow, RowMark } from "./computer-row";
import { computersMessages } from "./computers.messages";

/** Persistent per-app desktop grants on one Local Computer, with Revoke actions. */
export function ComputerAppGrants({
  computerId,
  tenantId,
}: {
  computerId: string;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const grants = useQuery(
    computerAppGrantsQueryOptions(client, tenantId, computerId),
  );
  const revokeMutation = useMutation({
    mutationFn: (grantId: string) =>
      revokeComputerAppGrant(client, tenantId, computerId, grantId),
    onMutate: (grantId) => {
      setRevokingId(grantId);
    },
    onSettled: async () => {
      setRevokingId(null);
      await queryClient.invalidateQueries({
        queryKey: computerAppGrantsQueryKey(tenantId, computerId),
      });
    },
  });

  const items = grants.data?.items ?? [];

  return (
    <div className="divide-y divide-border/60">
      <div className="px-4 py-2.5">
        <h4 className="text-xs font-medium text-muted-foreground">
          {t(computersMessages.allowedDesktopApps)}
        </h4>
        {grants.isError ? (
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <p className="text-xs text-app-danger" role="alert">
              {t(computersMessages.loadAppGrantsError)}
            </p>
            <Button
              disabled={grants.isFetching}
              onClick={() => void grants.refetch()}
              size="compact"
              tone="ghost"
            >
              {t(commonMessages.retry)}
            </Button>
          </div>
        ) : items.length === 0 && !grants.isPending ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t(computersMessages.noAllowedDesktopApps)}
          </p>
        ) : null}
        {revokeMutation.isError ? (
          <p className="mt-1 text-xs text-app-danger" role="alert">
            {t(computersMessages.revokeAppGrantError)}
          </p>
        ) : null}
      </div>
      {items.map((grant) => {
        const pending = revokingId === grant.id && revokeMutation.isPending;
        const subtitle = grant.agent_display_name
          ? t(computersMessages.allowedForAgent, {
              agent: grant.agent_display_name,
              bundleId: grant.bundle_id,
            })
          : grant.bundle_id;
        return (
          <ComputerRow
            action={
              <Button
                data-voice-risk="confirm"
                disabled={pending}
                onClick={() => revokeMutation.mutate(grant.id)}
                size="compact"
                tone="ghost"
              >
                {pending
                  ? t(computersMessages.revoking)
                  : t(computersMessages.revoke)}
              </Button>
            }
            key={grant.id}
            mark={
              <RowMark tone="card">
                <Icon icon={LaptopIcon} size={15} />
              </RowMark>
            }
            subtitle={subtitle}
            title={grant.app_name}
          />
        );
      })}
    </div>
  );
}
