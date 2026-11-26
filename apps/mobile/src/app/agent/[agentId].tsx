// An Agent's profile as a sheet, opened from its face: who it is, whether it
// is online, its instructions, the Routines that wake it in this chat and the
// connected accounts it may use. Everything is read-only on the phone; the
// computer edits it. Skills are left out.
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import {
  listAgentAvailability,
  listConnectionAgentAccess,
  listExternalApps,
  listExternalConnections,
  listRoomRoutines,
  listTenantAgents,
} from "../../api/teamhub";
import type { TenantAgent } from "../../api/types";
import { describeCadence } from "../../chat/routine-cadence";
import type { Message } from "../../i18n/messages";
import { useTranslation } from "../../i18n/use-translation";
import { agentMessages as m } from "../../screens/agent.messages";
import { teamHubKey, useIdentity, useTeamHub } from "../../state/queries";
import { colors, radius, space, type } from "../../theme";
import { AgentAvatar } from "../../ui/avatar";
import { Button, EmptyState } from "../../ui/controls";
import { SettingsGroup, SettingsRow, StatusLine } from "../../ui/settings";
import { Text } from "../../ui/text";

type Tab = "details" | "routines" | "connectors";

const TABS: { id: Tab; label: Message<string> }[] = [
  { id: "details", label: m.details },
  { id: "routines", label: m.routines },
  { id: "connectors", label: m.connectors },
];

function useAgent(agentId: string) {
  const teamHub = useTeamHub();
  const tenantId = useIdentity().data?.tenantId;
  return useQuery({
    queryKey: teamHubKey(teamHub.hostId, "agent", tenantId, agentId),
    enabled: teamHub.connected && !!tenantId,
    queryFn: async (): Promise<TenantAgent | null> => {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const result = await teamHub.run((session) =>
          listTenantAgents(session, tenantId ?? "", cursor),
        );
        const found = result.items.find((item) => item.actor.id === agentId);
        if (found) return found;
        if (!result.page.has_more || !result.page.next_cursor) break;
        cursor = result.page.next_cursor;
      }
      return null;
    },
  });
}

function useAvailability(agentId: string) {
  const teamHub = useTeamHub();
  const tenantId = useIdentity().data?.tenantId;
  const query = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "agent-availability", tenantId),
    enabled: teamHub.connected && !!tenantId,
    queryFn: () =>
      teamHub.run((session) => listAgentAvailability(session, tenantId ?? "")),
  });
  return query.data?.items.find((item) => item.actor_id === agentId)
    ?.availability;
}

function Segmented(props: {
  readonly value: Tab;
  readonly onChange: (tab: Tab) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {TABS.map((tab) => {
        const selected = tab.id === props.value;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => props.onChange(tab.id)}
            style={[styles.segment, selected && styles.segmentOn]}
          >
            <Text
              style={[styles.segmentText, selected && styles.segmentTextOn]}
            >
              {t(tab.label)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Details(props: { readonly agent: TenantAgent }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const instructions = props.agent.instructions.trim();
  return (
    <>
      {props.agent.description ? (
        <SettingsGroup label={t(m.about)}>
          <View style={styles.textBlock}>
            <Text style={type.chat}>{props.agent.description}</Text>
          </View>
        </SettingsGroup>
      ) : null}
      {instructions ? (
        <SettingsGroup label={t(m.instructions)}>
          <View style={styles.textBlock}>
            <Text style={type.chat} numberOfLines={open ? undefined : 6}>
              {instructions}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(!open)}
              hitSlop={8}
            >
              <Text style={styles.more}>
                {open ? t(m.showLess) : t(m.showMore)}
              </Text>
            </Pressable>
          </View>
        </SettingsGroup>
      ) : null}
      <SettingsGroup>
        <SettingsRow title={t(m.model)} detail={props.agent.runtime.model} />
      </SettingsGroup>
    </>
  );
}

function Routines(props: {
  readonly agentId: string;
  readonly roomId?: string;
}) {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const roomId = props.roomId;
  const routines = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "routines", roomId),
    enabled: teamHub.connected && !!roomId,
    queryFn: () =>
      teamHub.run((session) => listRoomRoutines(session, roomId ?? "")),
  });
  if (!roomId) return <EmptyState title={t(m.openFromChat)} />;
  if (routines.isPending) return <EmptyState title={t(m.loading)} busy />;
  // Routines without a named Agent wake whoever the chat belongs to.
  const items = (routines.data?.items ?? []).filter(
    (routine) =>
      !routine.mention_actor_id || routine.mention_actor_id === props.agentId,
  );
  if (items.length === 0) return <EmptyState title={t(m.noRoutines)} />;
  return (
    <SettingsGroup>
      {items.map((routine) => (
        <SettingsRow
          key={routine.id}
          title={routine.name}
          subtitle={describeCadence(routine.cadence, t)}
          detail={routine.enabled ? undefined : t(m.off)}
        />
      ))}
    </SettingsGroup>
  );
}

function Connectors(props: { readonly agentId: string }) {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const granted = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "agent-connectors", props.agentId),
    enabled: teamHub.connected,
    queryFn: () =>
      teamHub.run(async (session) => {
        const [apps, connections] = await Promise.all([
          listExternalApps(session),
          listExternalConnections(session),
        ]);
        const names = new Map(
          apps.apps.map((app) => [app.key, app.display_name]),
        );
        const active = connections.connections.filter(
          (connection) => connection.status === "active",
        );
        const access = await Promise.all(
          active.map((connection) =>
            listConnectionAgentAccess(session, connection.id).then(
              (list) => ({ connection, list }),
              () => ({ connection, list: { agents: [] } }),
            ),
          ),
        );
        return access
          .filter(({ list }) =>
            list.agents.some(
              (agent) =>
                agent.agent_actor_id === props.agentId && agent.granted,
            ),
          )
          .map(({ connection }) => ({
            id: connection.id,
            app: names.get(connection.provider) ?? connection.provider,
            account: connection.identity_label,
          }));
      }),
  });
  if (granted.isPending) return <EmptyState title={t(m.loading)} busy />;
  if (!granted.data || granted.data.length === 0)
    return <EmptyState title={t(m.noAccounts)} />;
  return (
    <SettingsGroup>
      {granted.data.map((item) => (
        <SettingsRow key={item.id} title={item.app} subtitle={item.account} />
      ))}
    </SettingsGroup>
  );
}

export default function AgentSheet() {
  const { t } = useTranslation();
  const {
    agentId,
    roomId,
    tab: openTab,
  } = useLocalSearchParams<{
    agentId: string;
    roomId?: string;
    tab?: string;
  }>();
  const agent = useAgent(agentId);
  const availability = useAvailability(agentId);
  const [tab, setTab] = useState<Tab>(
    TABS.some((item) => item.id === openTab) ? (openTab as Tab) : "details",
  );
  const online =
    availability &&
    availability.status !== "offline" &&
    availability.status !== "error";

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Button
          label={t(m.close)}
          variant="quiet"
          compact
          onPress={() => router.back()}
        />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.head}>
          <AgentAvatar actorId={agentId} size={72} />
          <Text style={styles.name} accessibilityRole="header">
            {agent.data?.actor.display_name ?? ""}
          </Text>
          {availability ? (
            <StatusLine
              tone={online ? "success" : "muted"}
              text={availability.label}
            />
          ) : null}
        </View>
        <View style={styles.tabs}>
          <Segmented value={tab} onChange={setTab} />
        </View>
        {agent.isPending ? (
          <EmptyState title={t(m.loading)} busy />
        ) : !agent.data ? (
          <EmptyState title={t(m.unavailable)} />
        ) : tab === "details" ? (
          <Details agent={agent.data} />
        ) : tab === "routines" ? (
          <Routines agentId={agentId} roomId={roomId || undefined} />
        ) : (
          <Connectors agentId={agentId} />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sidebar },
  bar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
  },
  content: { paddingBottom: space.xxl * 2 },
  head: { alignItems: "center", gap: space.xs, paddingTop: space.sm },
  name: { ...StyleSheet.flatten(type.headline), marginTop: space.sm },
  tabs: { paddingHorizontal: space.lg, paddingTop: space.lg },
  segmented: {
    flexDirection: "row",
    padding: 2,
    borderRadius: radius.lg,
    backgroundColor: colors.sidebarMuted,
  },
  segment: {
    flex: 1,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  segmentOn: { backgroundColor: colors.surface },
  segmentText: { ...StyleSheet.flatten(type.ui), color: colors.muted },
  segmentTextOn: { color: colors.ink, fontWeight: "500" },
  textBlock: { padding: space.lg, gap: space.sm },
  more: { ...StyleSheet.flatten(type.small), color: colors.accent },
});
