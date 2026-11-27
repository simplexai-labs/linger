import { RefreshIcon } from "@hugeicons/core-free-icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import { ByokCombobox } from "@/features/local-models/byok-combobox";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceDictationSettings } from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { voiceKeyMessages as m } from "./voice-key.messages";

/** Where TeamHub keeps saved keys; a server without it cannot store one. */
export const VOICE_KEY_STORAGE_VARIABLE = "TEAMHUB_SECRET_ENCRYPTION_KEY";

const localModelStateMessage = {
  ready: m.localReady,
  downloading: m.localDownloading,
  unavailable: m.localUnavailable,
} as const;

type RewriteSource = "cli" | "api";

// What a Claude CLI takes whoever runs it. The choice applies to everyone
// dictating on this server, so a model id that only one person's Computer
// lists is not offered.
const cliModelAliases = [
  ["haiku", m.defaultRewriteModel],
  ["sonnet", m.rewriteModelSonnet],
  ["opus", m.rewriteModelOpus],
] as const;

// What the page offers first for an API of one's own: DeepSeek's hosted chat.
const defaultApiBaseUrl = "https://api.deepseek.com/v1";
const defaultApiModel = "deepseek-chat";

function describeApiError(error: Error, t: Translate, invalid: string) {
  switch (error instanceof TeamHubError ? error.code : undefined) {
    case "VOICE_KEY_REJECTED":
      return t(m.apiRejected);
    case "VOICE_PROVIDER_UNAVAILABLE":
      return t(m.apiUnreachable);
    case "VOICE_KEY_STORAGE_UNAVAILABLE":
      return t(m.storageUnavailable, {
        storageVariable: VOICE_KEY_STORAGE_VARIABLE,
      });
    case "INVALID_REQUEST":
      return invalid;
    default:
      return t(m.localSaveFailed);
  }
}

function sameAddress(left: string, right: string) {
  return left.trim().replace(/\/+$/, "") === right.trim().replace(/\/+$/, "");
}

/**
 * The page of the voice key dialog that chooses what rewrites dictated text
 * when no Soniox key transcribes it: each person's connected Claude CLI on a
 * model alias (Haiku first), or an OpenAI-compatible API of the deployment's
 * own, such as DeepSeek.
 */
export function VoiceLocalModelPage({
  onSaved,
}: {
  /** Called once the choice is saved; resolves when the caller has turned
   * dictation on or found it is not on yet. */
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const settings = useQuery({
    queryFn: () =>
      teamHubData(client.api.GET("/v0/voice-dictation-settings", {})),
    queryKey: ["voice-dictation-settings"],
    retry: false,
    staleTime: 0,
  });
  const [requestedSource, setRequestedSource] = useState<RewriteSource>();
  const [requestedModel, setRequestedModel] = useState<string>();
  const [requestedBaseUrl, setRequestedBaseUrl] = useState<string>();
  const [requestedApiModel, setRequestedApiModel] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelFieldId = useId();
  // Models the API lists are stale once its address or key changes.
  const models = useMutation({
    mutationFn: (body: { api_key?: string; base_url: string }) =>
      teamHubData(
        client.api.POST("/v0/voice-dictation-settings/models", { body }),
      ),
    onSuccess: (listing) => setModelMenuOpen(listing.models.length > 0),
  });

  const current: TeamHubVoiceDictationSettings | undefined = settings.data;
  const source: RewriteSource =
    requestedSource ?? current?.polish_source ?? "cli";
  const model =
    requestedModel ??
    current?.polish_model ??
    current?.default_polish_model ??
    "";
  const baseUrl =
    requestedBaseUrl ?? current?.polish_api?.base_url ?? defaultApiBaseUrl;
  const apiModel =
    requestedApiModel ?? current?.polish_api?.model ?? defaultApiModel;
  const keySaved = current?.polish_api?.key_saved === true;
  // The saved key goes only to the address it was saved for, so another
  // address needs a key of its own.
  const savedKeyApplies =
    keySaved && sameAddress(current?.polish_api?.base_url ?? "", baseUrl);
  const canListModels =
    !saving &&
    baseUrl.trim() !== "" &&
    (apiKey.trim() !== "" || savedKeyApplies);
  const listedModels = models.data?.models ?? [];
  const apiModelHint = models.isPending
    ? t(m.apiModelsListing)
    : models.isError
      ? describeApiError(models.error, t, t(m.apiListInvalid))
      : models.data
        ? listedModels.length > 0
          ? t(m.apiModelsListed, { count: listedModels.length })
          : t(m.apiModelsNone)
        : t(m.apiModelHint);

  function changeApiAddress(next: { baseUrl?: string; key?: string }) {
    if (next.baseUrl !== undefined) setRequestedBaseUrl(next.baseUrl);
    if (next.key !== undefined) setApiKey(next.key);
    setModelMenuOpen(false);
    models.reset();
  }

  const options = new Map<string, string>(
    cliModelAliases.map(([id, label]) => [id, t(label)]),
  );
  // A saved choice this page no longer offers still shows.
  if (model && !options.has(model)) options.set(model, model);

  const canSave =
    Boolean(current) &&
    current?.local_model !== "unavailable" &&
    (source === "cli"
      ? Boolean(model)
      : current?.can_save_api_key === true &&
        Boolean(baseUrl.trim() && apiModel.trim()) &&
        Boolean(apiKey.trim() || savedKeyApplies));

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      await teamHubData(
        client.api.PUT("/v0/voice-dictation-settings", {
          body:
            source === "cli"
              ? { polish_source: "cli", polish_model: model }
              : {
                  polish_source: "api",
                  polish_api: {
                    base_url: baseUrl.trim(),
                    model: apiModel.trim(),
                    ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
                  },
                },
        }),
      );
      setApiKey("");
      await settings.refetch();
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? describeApiError(cause, t, t(m.invalidApi))
          : t(m.localSaveFailed),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="text-muted-foreground">{t(m.localPurpose)}</p>
      {current ? (
        <p role="status">{t(localModelStateMessage[current.local_model])}</p>
      ) : null}
      <div aria-label={t(m.rewriteWith)} className="flex gap-2" role="group">
        {(["cli", "api"] as const).map((option) => (
          <Button
            aria-pressed={option === source}
            key={option}
            onClick={() => setRequestedSource(option)}
            tone={option === source ? "primary" : "secondary"}
          >
            {t(option === "cli" ? m.rewriteWithCli : m.rewriteWithApi)}
          </Button>
        ))}
      </div>
      {source === "cli" ? (
        <>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">
              {t(m.rewriteModel)}
            </span>
            <Select
              aria-label={t(m.rewriteModelLabel)}
              className="ui-field-control w-full"
              disabled={!current || saving}
              onValueChange={setRequestedModel}
              value={model}
            >
              {[...options].map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </Select>
          </label>
          <p className="text-muted-foreground">{t(m.rewriteModelHint)}</p>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">{t(m.apiPurpose)}</p>
          {current?.can_save_api_key === false ? (
            <p role="alert">
              {t(m.storageUnavailable, {
                storageVariable: VOICE_KEY_STORAGE_VARIABLE,
              })}
            </p>
          ) : null}
          <Field
            autoComplete="off"
            disabled={saving}
            label={t(m.apiBaseUrl)}
            onChange={(event) =>
              changeApiAddress({ baseUrl: event.target.value })
            }
            spellCheck={false}
            value={baseUrl}
          />
          <Field
            autoComplete="off"
            disabled={saving}
            hint={t(
              savedKeyApplies
                ? m.apiKeySavedHint
                : keySaved
                  ? m.apiKeyNewAddressHint
                  : m.keyHint,
            )}
            label={t(m.apiKeyLabel)}
            onChange={(event) => changeApiAddress({ key: event.target.value })}
            spellCheck={false}
            type="password"
            value={apiKey}
          />
          <div>
            <label
              className="mb-1.5 block text-sm font-medium text-foreground"
              htmlFor={modelFieldId}
            >
              {t(m.apiModel)}
            </label>
            <div className="flex gap-2">
              <ByokCombobox
                aria-describedby={`${modelFieldId}-hint`}
                className="min-w-0 flex-1"
                disabled={saving}
                id={modelFieldId}
                label={t(m.apiModel)}
                onOpenChange={setModelMenuOpen}
                onValueChange={setRequestedApiModel}
                open={modelMenuOpen}
                options={listedModels.map((value) => ({ value }))}
                placeholder={defaultApiModel}
                value={apiModel}
              />
              <Button
                aria-label={t(m.listApiModels)}
                className="!rounded-full"
                disabled={!canListModels}
                loading={models.isPending}
                onClick={() =>
                  models.mutate({
                    base_url: baseUrl.trim(),
                    ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
                  })
                }
                size="icon"
                title={t(m.listApiModels)}
              >
                {models.isPending ? null : (
                  <Icon icon={RefreshIcon} size={16} />
                )}
              </Button>
            </div>
            <p
              className={cn(
                "mt-1.5 text-xs [overflow-wrap:anywhere]",
                models.isError ? "text-destructive" : "text-muted-foreground",
              )}
              id={`${modelFieldId}-hint`}
            >
              {apiModelHint}
            </p>
          </div>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <Button
        disabled={!canSave}
        loading={saving}
        onClick={() => void save()}
        tone="primary"
      >
        {saving && source === "api" ? t(m.checkingApi) : t(m.useLocalModel)}
      </Button>
    </>
  );
}
