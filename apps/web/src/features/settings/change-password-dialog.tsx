import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { SecretField } from "@/components/ui/secret-field";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { accountSettingsMessages } from "./account-settings.messages";

export function ChangePasswordDialog({
  changePassword,
  onChanged,
  onClose,
}: {
  changePassword: (input: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<void>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const mutation = useMutation({
    mutationFn: () => changePassword({ currentPassword, newPassword }),
    retry: false,
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });
  const mismatch = confirmation.length > 0 && confirmation !== newPassword;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    confirmation.length > 0 &&
    !mismatch &&
    !mutation.isPending;

  useEffect(() => {
    currentPasswordRef.current?.focus();
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit) {
      mutation.mutate();
    }
  }

  function requestClose() {
    if (!mutation.isPending) onClose();
  }

  function resetFailure() {
    if (mutation.error) {
      mutation.reset();
    }
  }

  return (
    <ModalDialog
      onClose={requestClose}
      size="md"
      title={t(accountSettingsMessages.changePassword)}
      footer={
        <>
          <Button disabled={mutation.isPending} onClick={requestClose}>
            {t(commonMessages.cancel)}
          </Button>
          <Button
            disabled={!canSubmit}
            form={formId}
            loading={mutation.isPending}
            tone="primary"
            type="submit"
          >
            {t(accountSettingsMessages.changePassword)}
          </Button>
        </>
      }
    >
      <form className="px-5 py-4" id={formId} onSubmit={handleSubmit}>
        <fieldset className="space-y-4" disabled={mutation.isPending}>
          <SecretField
            autoComplete="current-password"
            inputRef={currentPasswordRef}
            label={t(accountSettingsMessages.currentPassword)}
            onChange={(event) => {
              resetFailure();
              setCurrentPassword(event.target.value);
            }}
            value={currentPassword}
          />
          <SecretField
            autoComplete="new-password"
            hint={t(accountSettingsMessages.newPasswordHint)}
            label={t(accountSettingsMessages.newPassword)}
            onChange={(event) => {
              resetFailure();
              setNewPassword(event.target.value);
            }}
            value={newPassword}
          />
          <SecretField
            autoComplete="new-password"
            label={t(accountSettingsMessages.confirmNewPassword)}
            onChange={(event) => {
              resetFailure();
              setConfirmation(event.target.value);
            }}
            value={confirmation}
          />
        </fieldset>

        {mismatch ? (
          <p className="mt-4 text-sm text-app-danger" role="alert">
            {t(accountSettingsMessages.passwordsDoNotMatch)}
          </p>
        ) : null}
        {mutation.error ? (
          <p className="mt-4 text-sm text-app-danger" role="alert">
            {mutation.error.message}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
}
