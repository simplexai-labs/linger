import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import { teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { useT } from "@/i18n/use-translation";

import { AccountProfileHero } from "./account-profile-hero";
import { accountProfileQueryOptions } from "./account-profile-queries";
import { accountSettingsMessages } from "./account-settings.messages";
import { ApiKeysSettings } from "./api-keys-settings";
import { ChangePasswordDialog } from "./change-password-dialog";
import { SettingsPageHeading } from "./settings-page-heading";
import { settingsMessages } from "./settings.messages";

/** Settings › Account: the profile card, the password and the API keys. */
export function AccountSettingsPage() {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const accountQuery = useQuery(accountProfileQueryOptions(client, tenantId));
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-(--app-settings-width) flex-col gap-8 pb-4">
      <SettingsPageHeading title={t(settingsMessages.account)} />

      {accountQuery.isPending ? (
        <div
          aria-busy="true"
          aria-label={t(accountSettingsMessages.loadingAccountProfile)}
          className="rounded-2xl border border-border p-6"
          role="status"
        >
          <span className="sr-only">
            {t(accountSettingsMessages.loadingAccountProfileStatus)}
          </span>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-5 h-40 w-full" />
        </div>
      ) : accountQuery.error ? (
        <p
          className="rounded-xl border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] p-4 text-sm text-app-danger"
          role="alert"
        >
          {accountQuery.error.message}
        </p>
      ) : (
        <AccountProfileHero
          account={accountQuery.data}
          client={client}
          tenantId={tenantId}
        />
      )}

      <section className="rounded-2xl border border-border bg-background p-6">
        <div className="flex flex-col justify-center gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-foreground">
            {t(accountSettingsMessages.password)}
          </p>
          <Button
            onClick={() => {
              setPasswordChanged(false);
              setChangePasswordOpen(true);
            }}
          >
            {t(accountSettingsMessages.changePassword)}
          </Button>
        </div>
      </section>

      <ApiKeysSettings />

      {passwordChanged ? (
        <p
          className="flex items-center gap-2 text-sm text-app-success"
          role="status"
        >
          <Icon icon={Tick02Icon} size={16} />
          {t(accountSettingsMessages.passwordChanged)}
        </p>
      ) : null}

      {changePasswordOpen ? (
        <ChangePasswordDialog
          changePassword={({ currentPassword, newPassword }) =>
            teamHubDone(
              client.api.POST("/v0/account/password", {
                body: {
                  current_password: currentPassword,
                  new_password: newPassword,
                },
              }),
            )
          }
          onChanged={() => setPasswordChanged(true)}
          onClose={() => setChangePasswordOpen(false)}
        />
      ) : null}
    </div>
  );
}
