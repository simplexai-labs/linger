import { ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { RichMessage, useT } from "@/i18n/use-translation";

import { externalAppsQueryOptions } from "./connected-apps-queries";
import { connectorMessages as m } from "./connectors.messages";

export const COMPOSIO_KEYS_URL =
  "https://dashboard.composio.dev/~/project/settings/api-keys";

const PERM_TAGS = {
  perm: (text: string) => (
    <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
      {text}
    </span>
  ),
};

export function ProviderKeyLink({ href }: { href: string }) {
  const t = useT();
  return (
    <a
      className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-app-link hover:underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {t(m.getAKey)} <span aria-hidden="true">↗</span>
    </a>
  );
}

/**
 * Takes one provider API key and hands it to `save`. TeamHub checks a key
 * before keeping it and never returns it, so the field clears once it is
 * saved. Returns the field and the dialog's buttons apart, so a dialog puts
 * the buttons in its own footer where they stay in view. `resetKey` starts a
 * new draft when it changes, such as on another provider.
 */
export function useProviderKeyForm({
  describeError = (error) => error.message,
  helper,
  label,
  labelAction,
  onCancel,
  onSaved,
  pendingLabel,
  placeholder,
  resetKey = "",
  save,
}: {
  /** The message shown under the field when `save` fails. */
  describeError?: (error: Error) => string;
  helper?: ReactNode;
  label: string;
  labelAction?: ReactNode;
  onCancel?: () => void;
  onSaved?: () => void;
  /** The Save button's text while `save` runs; "Checking key..." without one. */
  pendingLabel?: string;
  placeholder?: string;
  resetKey?: string;
  save: (apiKey: string) => Promise<unknown>;
}): { fields: ReactNode; actions: ReactNode } {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState({ for: resetKey, value: "" });
  const [visible, setVisible] = useState(false);
  const apiKey = draft.for === resetKey ? draft.value : "";
  const mutation = useMutation({
    mutationFn: (value: string) => save(value),
    onSuccess: () => {
      setDraft({ for: resetKey, value: "" });
      setVisible(false);
      onSaved?.();
    },
  });
  // A failure belongs to the draft it was for.
  const error =
    mutation.error && mutation.variables !== undefined && draft.for === resetKey
      ? describeError(mutation.error)
      : undefined;

  const fields = (
    <form
      id={formId}
      onSubmit={(event) => {
        event.preventDefault();
        if (apiKey.trim() && !mutation.isPending)
          mutation.mutate(apiKey.trim());
      }}
    >
      <Field
        autoComplete="off"
        // The key is the dialog's one field; it takes focus over the "Get a
        // key" link above it.
        data-autofocus=""
        error={error}
        hint={helper}
        inputClassName="font-mono placeholder:font-sans"
        label={label}
        labelAction={labelAction}
        onChange={(event) => {
          setDraft({ for: resetKey, value: event.target.value });
          if (mutation.error) mutation.reset();
        }}
        placeholder={placeholder ?? t(m.apiKeyPlaceholder)}
        spellCheck={false}
        suffix={
          <button
            aria-label={t(visible ? m.hideApiKey : m.showApiKey)}
            className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setVisible((current) => !current)}
            type="button"
          >
            <Icon icon={visible ? ViewOffIcon : ViewIcon} size={16} />
          </button>
        }
        type={visible ? "text" : "password"}
        value={apiKey}
      />
    </form>
  );

  const actions = (
    <>
      {onCancel ? (
        <Button
          disabled={mutation.isPending}
          onClick={onCancel}
          tone="secondary"
        >
          {t(commonMessages.cancel)}
        </Button>
      ) : null}
      <Button
        disabled={!apiKey.trim()}
        form={formId}
        loading={mutation.isPending}
        tone="primary"
        type="submit"
      >
        {mutation.isPending ? (pendingLabel ?? t(m.checkingKey)) : t(m.saveKey)}
      </Button>
    </>
  );

  return { actions, fields };
}

// A private deployment without COMPOSIO_API_KEY saves its key here.
export function useComposioKeyForm({
  onCancel,
  onSaved,
}: {
  onCancel?: () => void;
  onSaved?: () => void;
} = {}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const t = useT();
  return useProviderKeyForm({
    helper: <RichMessage message={m.composioKeyReminder} tags={PERM_TAGS} />,
    label: t(m.composioApiKey),
    labelAction: <ProviderKeyLink href={COMPOSIO_KEYS_URL} />,
    onCancel,
    onSaved,
    save: async (apiKey) => {
      await client.saveExternalProviderKey(apiKey);
      await queryClient.invalidateQueries({
        queryKey: externalAppsQueryOptions(client).queryKey,
      });
    },
  });
}

/**
 * The Composio key dialog: its field in the body and Cancel / Save in the
 * footer. A deployment that cannot save a key shows `fallback` instead.
 */
export function ComposioKeyDialog({
  canSave = true,
  description,
  fallback,
  onClose,
  onSaved,
  title,
}: {
  canSave?: boolean;
  description?: ReactNode;
  fallback?: ReactNode;
  onClose: () => void;
  onSaved: () => void;
  title: ReactNode;
}) {
  const form = useComposioKeyForm({ onCancel: onClose, onSaved });
  return (
    <ModalDialog
      closeOnBackdrop
      description={description}
      footer={canSave ? form.actions : undefined}
      onClose={onClose}
      size="sm"
      title={title}
    >
      <div className="px-5 py-4 text-sm text-app-body">
        {canSave ? form.fields : fallback}
      </div>
    </ModalDialog>
  );
}
