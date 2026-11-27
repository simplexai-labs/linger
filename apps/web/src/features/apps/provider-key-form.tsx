import { ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { fieldControlClassName } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { RichMessage, useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

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
 * before keeping it and never returns it, so the field clears once it is saved.
 */
export function ProviderKeyForm({
  describeError = (error) => error.message,
  helper,
  label,
  labelAction,
  onCancel,
  onSaved,
  pendingLabel,
  placeholder,
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
  save: (apiKey: string) => Promise<unknown>;
}) {
  const t = useT();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState("");
  const [visible, setVisible] = useState(false);
  const mutation = useMutation({
    mutationFn: () => save(apiKey.trim()),
    onSuccess: () => {
      setApiKey("");
      setVisible(false);
      onSaved?.();
    },
  });

  useEffect(() => {
    let active = true;
    inputRef.current?.focus({ focusVisible: false });
    // ModalDialog calls showModal() in its parent effect after child effects
    // run, which moves focus to the first link in the body unless the input
    // reclaims focus once the dialog is open.
    queueMicrotask(() => {
      if (active) inputRef.current?.focus({ focusVisible: false });
    });
    return () => {
      active = false;
    };
  }, []);

  const helperId = helper ? `${inputId}-helper` : undefined;
  const error = mutation.error ? describeError(mutation.error) : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy =
    [helperId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (apiKey.trim() && !mutation.isPending) mutation.mutate();
      }}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor={inputId}
        >
          {label}
        </label>
        {labelAction}
      </div>
      <div className="ui-field-frame">
        <input
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          className={cn(
            fieldControlClassName,
            "pr-11 font-mono placeholder:font-sans",
          )}
          disabled={mutation.isPending}
          id={inputId}
          onChange={(event) => {
            setApiKey(event.target.value);
            if (mutation.error) mutation.reset();
          }}
          placeholder={placeholder ?? t(m.apiKeyPlaceholder)}
          ref={inputRef}
          spellCheck={false}
          type={visible ? "text" : "password"}
          value={apiKey}
        />
        <span className="absolute inset-y-0 right-0 flex w-11 items-center justify-center">
          <button
            aria-label={t(visible ? m.hideApiKey : m.showApiKey)}
            className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            disabled={mutation.isPending}
            onClick={() => setVisible((current) => !current)}
            type="button"
          >
            {visible ? (
              <Icon icon={ViewOffIcon} size={16} />
            ) : (
              <Icon icon={ViewIcon} size={16} />
            )}
          </button>
        </span>
      </div>
      {helper ? (
        <p
          className="mt-2 text-xs leading-5 text-muted-foreground"
          id={helperId}
        >
          {helper}
        </p>
      ) : null}
      {error ? (
        <p
          className="mt-1.5 text-xs text-destructive"
          id={errorId}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex items-center justify-end gap-2">
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
          loading={mutation.isPending}
          tone="primary"
          type="submit"
        >
          {mutation.isPending
            ? (pendingLabel ?? t(m.checkingKey))
            : t(m.saveKey)}
        </Button>
      </div>
    </form>
  );
}

// A private deployment without COMPOSIO_API_KEY saves its key here.
export function ComposioKeyForm({
  onCancel,
  onSaved,
}: {
  onCancel?: () => void;
  onSaved?: () => void;
} = {}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const t = useT();
  return (
    <ProviderKeyForm
      helper={<RichMessage message={m.composioKeyReminder} tags={PERM_TAGS} />}
      label={t(m.composioApiKey)}
      labelAction={<ProviderKeyLink href={COMPOSIO_KEYS_URL} />}
      onCancel={onCancel}
      onSaved={onSaved}
      save={async (apiKey) => {
        await client.saveExternalProviderKey(apiKey);
        await queryClient.invalidateQueries({
          queryKey: externalAppsQueryOptions(client).queryKey,
        });
      }}
    />
  );
}
