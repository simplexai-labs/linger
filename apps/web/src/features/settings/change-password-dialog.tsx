import { useMutation } from "@tanstack/react-query";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
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
          <PasswordField
            autoComplete="current-password"
            inputRef={currentPasswordRef}
            label={t(accountSettingsMessages.currentPassword)}
            onChange={(value) => {
              resetFailure();
              setCurrentPassword(value);
            }}
            value={currentPassword}
          />
          <PasswordField
            autoComplete="new-password"
            label={t(accountSettingsMessages.newPassword)}
            onChange={(value) => {
              resetFailure();
              setNewPassword(value);
            }}
            value={newPassword}
          />
          <PasswordField
            autoComplete="new-password"
            label={t(accountSettingsMessages.confirmNewPassword)}
            onChange={(value) => {
              resetFailure();
              setConfirmation(value);
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

function PasswordField({
  autoComplete,
  inputRef,
  label,
  onChange,
  value,
}: {
  autoComplete: "current-password" | "new-password";
  inputRef?: RefObject<HTMLInputElement | null>;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-foreground">
        {label}
      </span>
      <input
        aria-label={label}
        autoComplete={autoComplete}
        className="ui-field-control w-full disabled:cursor-not-allowed disabled:bg-app-surface-soft"
        onChange={(event) => onChange(event.target.value)}
        ref={inputRef}
        type="password"
        value={value}
      />
    </label>
  );
}
