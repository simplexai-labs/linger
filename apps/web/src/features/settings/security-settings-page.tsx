import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { useT } from "@/i18n/use-translation";

import { accountSettingsMessages } from "./account-settings.messages";
import { ApiKeysSettings } from "./api-keys-settings";
import { ChangePasswordDialog } from "./change-password-dialog";
import { SettingsPageHeading } from "./settings-page-heading";
import { settingsMessages } from "./settings.messages";

export function SecuritySettingsPage() {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-(--app-settings-width) flex-col gap-8 pb-4">
      <SettingsPageHeading
        description={t(accountSettingsMessages.securityDescription)}
        title={t(settingsMessages.security)}
      />

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
