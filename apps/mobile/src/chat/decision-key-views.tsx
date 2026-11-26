// The decision cards that ask for an API key: the deployment's Composio key
// and a web search backend's key. A key goes from its field to TeamHub,
// never into the chat; saving it answers the card on the server.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  listExternalApps,
  listWebSearchBackends,
  saveExternalProviderKey,
  saveWebSearchKey,
} from "../api/teamhub";
import type { WebSearchBackend, WebSearchKeyBackend } from "../api/types";
import type { Translate } from "../i18n/language";
import { useTranslation } from "../i18n/use-translation";
import { HttpError } from "../session/http";
import { teamHubKey, useTeamHub, type TeamHubAccess } from "../state/queries";
import { colors, radius, space, type } from "../theme";
import { Button } from "../ui/controls";
import { Text } from "../ui/text";
import { chatDecisionMessages as m } from "./decision-card.messages";
import { SecretField, styles as parts } from "./decision-parts";
import { keyBackendName, keySite, searchKeyBackends } from "./decision-rules";
import type { DecisionViewProps } from "./decision-setup-views";

/** Saves the Composio key; resolves why it was refused, or undefined. */
export async function saveComposioKey(
  teamHub: TeamHubAccess,
  key: string,
  t: Translate,
): Promise<string | undefined> {
  try {
    await teamHub.run((session) => saveExternalProviderKey(session, key));
    return undefined;
  } catch (error) {
    if (!(error instanceof HttpError)) return t(m.keyNotSaved);
    if (error.code === "COMPOSIO_KEY_REJECTED" || error.status === 400)
      return t(m.composioKeyRejected);
    if (
      error.code === "COMPOSIO_KEY_FROM_ENVIRONMENT" ||
      error.code === "COMPOSIO_KEY_STORAGE_UNAVAILABLE"
    )
      return t(m.keysCannotBeSaved);
    return t(m.keyNotSaved);
  }
}

/** The deployment's Composio API key, which every Connected App needs. */
export function ProviderKey(props: DecisionViewProps) {
  const { t } = useTranslation();
  const { canAnswer, decision } = props;
  const teamHub = useTeamHub();
  const client = useQueryClient();
  const catalog = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "external-apps"),
    enabled: teamHub.connected && canAnswer,
    staleTime: 5 * 60_000,
    queryFn: () => teamHub.run(listExternalApps),
  });
  if (!canAnswer) return null;
  return (
    <>
      {catalog.data?.provider_key.can_save === false ? (
        <Text style={type.small}>{t(m.keysCannotBeSaved)}</Text>
      ) : (
        <SecretField
          label={t(m.composioApiKey)}
          save={async (key) => {
            const refused = await saveComposioKey(teamHub, key, t);
            if (refused) return refused;
            await client.invalidateQueries({
              queryKey: teamHubKey(teamHub.hostId, "external-apps"),
            });
            await decision.refresh();
            return undefined;
          }}
        />
      )}
      <Button
        label={t(m.notNow)}
        variant="secondary"
        onPress={() => void decision.answer({ decision: "deny" })}
        busy={decision.busy}
      />
    </>
  );
}

/**
 * A web search backend's key: the one the Agent named or TeamHub suggested
 * first, every other backend that takes a key below it. A provider refusing
 * the key keeps the card open with the reason.
 */
export function SearchKey(props: DecisionViewProps) {
  const { t } = useTranslation();
  const { card, canAnswer, decision } = props;
  const teamHub = useTeamHub();
  const client = useQueryClient();
  const [othersOpen, setOthersOpen] = useState(false);
  const view = card.search_key;
  const list = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "web-search-backends"),
    enabled: teamHub.connected && !!view,
    staleTime: 5 * 60_000,
    queryFn: () => teamHub.run(listWebSearchBackends),
  });
  if (!view) return null;
  const pending = card.status === "pending";
  const shownId: WebSearchKeyBackend =
    !pending && card.answer?.backend ? card.answer.backend : view.backend;
  const { shown, others } = searchKeyBackends(
    list.data?.backends ?? [],
    shownId,
  );
  const shownName = shown?.name ?? keyBackendName(shownId);

  const save = async (
    backend: { id: WebSearchKeyBackend; name: string },
    key: string,
  ) => {
    try {
      await teamHub.run((session) =>
        saveWebSearchKey(session, backend.id, key, card.decision_id),
      );
    } catch (error) {
      return error instanceof HttpError &&
        error.code === "WEB_SEARCH_KEY_REJECTED"
        ? t(m.searchKeyRejected, { backend: backend.name })
        : t(m.keyNotSaved);
    }
    await client.invalidateQueries({
      queryKey: teamHubKey(teamHub.hostId, "web-search-backends"),
    });
    await decision.refresh();
    return undefined;
  };

  return (
    <>
      <View style={parts.row}>
        <Text style={parts.rowLabel} numberOfLines={1}>
          {shownName}
        </Text>
        {pending ? (
          <Pill
            text={t(view.origin === "requested" ? m.requested : m.suggested)}
          />
        ) : null}
      </View>
      {shown?.description ? (
        <Text style={type.small}>{shown.description}</Text>
      ) : null}
      {canAnswer && view.reason !== "missing" ? (
        <Text style={type.small}>
          {t(
            view.reason === "rejected"
              ? m.searchKeyNoLongerAccepted
              : m.freeSearchesUsedUp,
            { backend: shownName },
          )}
        </Text>
      ) : null}
      {canAnswer && list.data?.can_save_keys === false ? (
        <Text style={type.small}>{t(m.keysCannotBeSaved)}</Text>
      ) : null}
      {canAnswer && list.data?.can_save_keys !== false ? (
        <>
          <SecretField
            label={t(m.apiKeyFor, { backend: shownName })}
            hint={keyHint(shown, t)}
            save={(key) => save({ id: shownId, name: shownName }, key)}
          />
          {others.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: othersOpen }}
              onPress={() => setOthersOpen((open) => !open)}
              hitSlop={8}
              style={styles.toggle}
            >
              <Text style={parts.link}>
                {othersOpen
                  ? t(m.hideOtherProviders)
                  : t(m.otherProvidersCount, { count: others.length })}
              </Text>
            </Pressable>
          ) : null}
          {othersOpen
            ? others.map((backend) => (
                <View key={backend.id} style={styles.other}>
                  <View style={parts.row}>
                    <Text style={parts.rowLabel} numberOfLines={1}>
                      {backend.name}
                    </Text>
                    {backend.tier === "free" ? (
                      <Pill text={t(m.freeLimited)} />
                    ) : null}
                  </View>
                  <Text style={type.small}>{backend.description}</Text>
                  <SecretField
                    label={t(m.apiKeyFor, { backend: backend.name })}
                    hint={keyHint(backend, t)}
                    secondary
                    save={(key) => save(backend, key)}
                  />
                </View>
              ))
            : null}
        </>
      ) : null}
      {canAnswer ? (
        <Button
          label={t(m.notNow)}
          variant="secondary"
          onPress={() => void decision.answer({ decision: "deny" })}
          busy={decision.busy}
        />
      ) : null}
    </>
  );
}

function keyHint(
  backend: WebSearchBackend | undefined,
  t: Translate,
): { text: string; url: string } | undefined {
  const url = backend?.key_url;
  return url ? { text: t(m.getKeyAt, { site: keySite(url) }), url } : undefined;
}

function Pill(props: { readonly text: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{props.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { alignSelf: "flex-start" },
  other: {
    gap: space.sm,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pill: {
    height: 22,
    justifyContent: "center",
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  pillText: { fontSize: 12, color: colors.secondary },
});
