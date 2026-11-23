import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import type { components } from "@linger/wire-contracts/teamhub-public/types";
import { useQuery } from "@tanstack/react-query";

import { Icon } from "@/components/ui/icon";
import type { Message, PluralForms } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

import { anotherMeQueryOptions } from "../room-queries";
import { chatMessages as m } from "./chat.messages";

type BackgroundFailureReason =
  components["schemas"]["AnotherMeBackgroundFailureReason"];

const reasonMessages: Record<BackgroundFailureReason, Message<PluralForms>> = {
  runtime_incompatible: m.backgroundFailedIncompatible,
  runtime_auth_required: m.backgroundFailedSignIn,
  runtime_unavailable: m.backgroundFailedRuntimeUnavailable,
  unknown: m.backgroundFailedUnknown,
};

/** Tops the Another Me Chat while its background model calls keep failing.
 * TeamHub sends the failure only from the third in a row and drops it after
 * the next completed call, so the banner has no dismiss of its own. */
export function AnotherMeBackgroundFailureBanner({
  client,
  roomId,
  tenantId,
}: {
  client: TeamHubClient;
  roomId: string;
  tenantId: string;
}) {
  const t = useT();
  const { data } = useQuery(anotherMeQueryOptions(client, tenantId));
  const failure =
    data?.room_id === roomId ? data.background_failure : undefined;
  if (!failure) return null;
  const message = Object.hasOwn(reasonMessages, failure.reason)
    ? reasonMessages[failure.reason]
    : m.backgroundFailedUnknown;
  return (
    <div className="room-readable shrink-0 px-4 pt-3">
      <div
        className="flex min-h-9 items-center gap-2 rounded-lg border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] px-4 py-2 text-xs font-medium text-[var(--app-status-danger-text)]"
        role="alert"
      >
        <Icon className="shrink-0" icon={AlertCircleIcon} size={14} />
        {t(message, { count: failure.consecutive_failures })}
      </div>
    </div>
  );
}
