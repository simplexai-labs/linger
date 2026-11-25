import { AlertCircleIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import type { components } from "@linger/wire-contracts/teamhub-public/types";
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { Icon } from "@/components/ui/icon";
import type { Message, PluralForms } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

import { anotherMeQueryOptions } from "../room-queries";
import {
  dismissBackgroundFailure,
  readDismissedBackgroundFailure,
  subscribeDismissedBackgroundFailures,
} from "./another-me-background-failure-dismissal";
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
 * TeamHub sends the failure from the third in a row and drops it once a call
 * completes or the Runtime changes; the Human can also dismiss it for the
 * current failure reason. */
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
  const dismissedReason = useSyncExternalStore(
    subscribeDismissedBackgroundFailures,
    () => readDismissedBackgroundFailure(tenantId, roomId),
    () => undefined,
  );

  if (!failure || dismissedReason === failure.reason) return null;
  const message = Object.hasOwn(reasonMessages, failure.reason)
    ? reasonMessages[failure.reason]
    : m.backgroundFailedUnknown;
  return (
    <div className="room-readable shrink-0 px-4 pt-3">
      <div
        className="flex min-h-9 items-start gap-2 rounded-lg border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] px-4 py-2 text-xs font-medium text-[var(--app-status-danger-text)]"
        role="alert"
      >
        <Icon className="mt-0.5 shrink-0" icon={AlertCircleIcon} size={14} />
        <span className="min-w-0 flex-1 leading-5">
          {t(message, { count: failure.consecutive_failures })}
        </span>
        <button
          aria-label={t(m.dismissBackgroundFailureNotice)}
          className="-mr-1 -mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-current opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-focus"
          data-voice-close=""
          onClick={() =>
            dismissBackgroundFailure(tenantId, roomId, failure.reason)
          }
          type="button"
        >
          <Icon icon={Cancel01Icon} size={14} />
        </button>
      </div>
    </div>
  );
}
