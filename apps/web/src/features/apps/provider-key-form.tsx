import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { SecretField } from "@/components/ui/secret-field";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { useT } from "@/i18n/use-translation";

import { externalAppsQueryOptions } from "./connected-apps-queries";
import { connectorMessages as m } from "./connectors.messages";

/**
 * Takes one provider API key and hands it to `save`. TeamHub checks a key
 * before keeping it and never returns it, so the field clears once it is saved.
 */
export function ProviderKeyForm({
  describeError = (error) => error.message,
  hint,
  label,
  onSaved,
  pendingLabel,
  save,
}: {
  /** The message shown under the field when `save` fails. */
  describeError?: (error: Error) => string;
  hint?: string;
  label: string;
  onSaved?: () => void;
  /** The Save button's text while `save` runs; "Checking key..." without one. */
  pendingLabel?: string;
  save: (apiKey: string) => Promise<unknown>;
}) {
  const t = useT();
  const [apiKey, setApiKey] = useState("");
  const mutation = useMutation({
    mutationFn: () => save(apiKey.trim()),
    onSuccess: () => {
      setApiKey("");
      onSaved?.();
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (apiKey.trim()) mutation.mutate();
      }}
    >
      <SecretField
        autoComplete="off"
        error={mutation.error ? describeError(mutation.error) : undefined}
        hint={hint}
        label={label}
        onChange={(event) => setApiKey(event.target.value)}
        spellCheck={false}
        value={apiKey}
      />
      <Button
        disabled={!apiKey.trim()}
        loading={mutation.isPending}
        tone="primary"
        type="submit"
      >
        {mutation.isPending ? (pendingLabel ?? t(m.checkingKey)) : t(m.saveKey)}
      </Button>
    </form>
  );
}

// A private deployment without COMPOSIO_API_KEY saves its key here.
export function ComposioKeyForm({ onSaved }: { onSaved?: () => void } = {}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const t = useT();
  return (
    <ProviderKeyForm
      label={t(m.composioApiKey)}
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
