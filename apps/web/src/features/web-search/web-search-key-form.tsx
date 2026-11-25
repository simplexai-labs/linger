import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { SecretInput } from "@/components/ui/secret-field";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubWebSearchKeyBackend } from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";
import { RichMessage, useT } from "@/i18n/use-translation";

import { webSearchKeySite, webSearchQueryKey } from "./web-search-backends";
import { webSearchMessages as m } from "./web-search.messages";

export interface WebSearchKeyTarget {
  id: TeamHubWebSearchKeyBackend;
  key_url?: string;
  name: string;
}

/**
 * One backend's key field with its Save button on the same line. TeamHub
 * checks the key before keeping it and never returns it, so the field
 * clears once it is saved. A key added from a search key card names the
 * card, and TeamHub checks it by running the card's request.
 */
export function WebSearchKeyForm({
  backend,
  compact = false,
  decisionId,
  onSaved,
  submitLabel,
  tone = "primary",
}: {
  backend: WebSearchKeyTarget;
  /** A row in a list: no visible label, and the hint is only the key link. */
  compact?: boolean;
  decisionId?: string;
  onSaved?: () => void;
  submitLabel?: string;
  tone?: "primary" | "secondary";
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const inputId = useId();
  const mutation = useMutation({
    mutationFn: (key: string) =>
      teamHubData(
        client.api.PUT("/v0/web-search/backends/{backend}/key", {
          params: { path: { backend: backend.id } },
          body: decisionId
            ? { api_key: key, decision_id: decisionId }
            : { api_key: key },
        }),
      ),
    onSuccess: async () => {
      setApiKey("");
      await queryClient.invalidateQueries({ queryKey: webSearchQueryKey });
      onSaved?.();
    },
  });
  const label = t(m.apiKey, { backend: backend.name });
  const error = mutation.error
    ? describeKeyError(mutation.error, backend, t)
    : null;
  const hasHint = Boolean(backend.key_url);
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy =
    [hasHint && hintId, error && errorId].filter(Boolean).join(" ") ||
    undefined;

  return (
    <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (apiKey.trim()) mutation.mutate(apiKey.trim());
      }}
    >
      {compact ? null : (
        <label className="text-xs font-medium text-app-body" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className="flex min-w-0 gap-2">
        <SecretInput
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          aria-label={compact ? label : undefined}
          autoComplete="off"
          disabled={mutation.isPending}
          frameClassName="min-w-0 flex-1"
          id={inputId}
          onChange={(event) => setApiKey(event.target.value)}
          spellCheck={false}
          value={apiKey}
        />
        <Button
          disabled={!apiKey.trim()}
          loading={mutation.isPending}
          size="large"
          tone={tone}
          type="submit"
        >
          {mutation.isPending
            ? t(m.checkingKey)
            : (submitLabel ?? t(m.saveKey))}
        </Button>
      </div>
      {error ? (
        <p
          className="[overflow-wrap:anywhere] text-xs text-app-danger"
          id={errorId}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {backend.key_url ? (
        <p className="text-xs text-app-muted" id={hintId}>
          <RichMessage
            message={m.getKeyAt}
            tags={{
              link: (site) => (
                <a
                  className="text-app-link hover:underline"
                  href={backend.key_url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {site} <span aria-hidden="true">↗</span>
                </a>
              ),
            }}
            values={{ site: webSearchKeySite(backend.key_url) }}
          />
        </p>
      ) : null}
    </form>
  );
}

function describeKeyError(
  error: Error,
  backend: WebSearchKeyTarget,
  t: Translate,
): string {
  if (error instanceof TeamHubError && error.code === "WEB_SEARCH_KEY_REJECTED")
    return backend.key_url
      ? t(m.keyRejectedAt, {
          backend: backend.name,
          site: webSearchKeySite(backend.key_url),
        })
      : t(m.keyRejected, { backend: backend.name });
  return error.message;
}
