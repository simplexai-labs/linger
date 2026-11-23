import { useQuery } from "@tanstack/react-query";

import { externalConnectionsQueryOptions } from "@/features/apps/connected-apps-queries";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { useT } from "@/i18n/use-translation";
import { canvasMessages } from "./canvas.messages";
import { mailCanvasAppName } from "./canvas-targets";

export function CanvasMailSender({
  client,
  target,
}: {
  client: TeamHubClient;
  /** The canvas's mail app; its accounts are the ones that can send it. */
  target: string;
}) {
  const t = useT();
  const connections = useQuery(externalConnectionsQueryOptions(client));
  const accounts = connections.data?.connections.filter(
    (connection) =>
      connection.provider === target && connection.status === "active",
  );
  const app = mailCanvasAppName(target);
  return (
    <span>
      {accounts?.length === 1
        ? accounts[0]?.identity_label ||
          t(canvasMessages.connectedMailAccount, { app })
        : t(canvasMessages.mailAccount, { app })}
    </span>
  );
}
