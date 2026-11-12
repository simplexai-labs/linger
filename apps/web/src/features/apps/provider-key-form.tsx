import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { externalAppsQueryOptions } from "./connected-apps-queries";

/**
 * Takes one provider API key and hands it to `save`. TeamHub checks a key
 * before keeping it and never returns it, so the field clears once it is saved.
 */
export function ProviderKeyForm({
  describeError = (error) => error.message,
  hint,
  label,
  onSaved,
  pendingLabel = "Checking key...",
  save,
}: {
  /** The message shown under the field when `save` fails. */
  describeError?: (error: Error) => string;
  hint: string;
  label: string;
  onSaved?: () => void;
  /** The Save button's text while `save` runs. */
  pendingLabel?: string;
  save: (apiKey: string) => Promise<unknown>;
}) {
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
      <Field
        autoComplete="off"
        error={mutation.error ? describeError(mutation.error) : undefined}
        hint={hint}
        label={label}
        onChange={(event) => setApiKey(event.target.value)}
        spellCheck={false}
        type="password"
        value={apiKey}
      />
      <Button
        disabled={!apiKey.trim()}
        loading={mutation.isPending}
        tone="primary"
        type="submit"
      >
        {mutation.isPending ? pendingLabel : "Save key"}
      </Button>
    </form>
  );
}

// A private deployment without COMPOSIO_API_KEY saves its key here.
export function ComposioKeyForm({ onSaved }: { onSaved?: () => void } = {}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  return (
    <ProviderKeyForm
      hint="Use a key with full read and write access (Read All and Write All). It is stored encrypted and never shown again."
      label="Composio API key"
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
