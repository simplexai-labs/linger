// Settings, laid out as iOS Settings: the computer and how this phone reaches
// it, the Relay nodes, notifications and the version. One line per row, and a
// note only where a choice needs one.
import Constants from "expo-constants";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Share, StyleSheet, View } from "react-native";

import { addRelayNode, listRelayNodes } from "../../../api/teamhub";
import { useComputer } from "../../../computer/computer-context";
import type { ConnectionStatus } from "../../../computer/connection";
import { relayNodesOf, sameRelayNodes } from "../../../computer/relay-nodes";
import { documentFiles } from "../../../computer/store-expo";
import {
  DEFAULT_PUSH_PREFERENCES,
  readPushRecord,
  type PushPreferences,
} from "../../../push/grant";
import {
  disablePush,
  enablePush,
  pushSetup,
  setPushPreferences,
} from "../../../push/push";
import {
  diagnosticsReceiver,
  sendAppLog,
  shareAppLog,
} from "../../../lib/app-log-expo";
import {
  DiagnosticsUploadError,
  diagnosticsUploadErrorText,
} from "../../../lib/diagnostics-upload";
import { HttpError } from "../../../session/http";
import { colors, radius, space, type } from "../../../theme";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { Button } from "../../../ui/controls";
import { Icon } from "../../../ui/icon";
import {
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSwitch,
  StatusLine,
} from "../../../ui/settings";
import { StatusStrip } from "../../../ui/status-strip";
import { Text, TextInput } from "../../../ui/text";
import { setLanguageChoice, type Translate } from "../../../i18n/language";
import { LANGUAGES, type LanguageChoice } from "../../../i18n/languages";
import { useTranslation } from "../../../i18n/use-translation";
import { settingsMessages as m } from "../../../screens/settings.messages";

function Check() {
  return <Icon name="check" size={20} color={colors.accent} />;
}

/** The active computer's state and route as a dot and a few words. */
function statusLine(
  t: Translate,
  status: ConnectionStatus | undefined,
  via: string | undefined,
): { tone: "success" | "warning" | "muted"; text: string } {
  switch (status?.kind) {
    case "connected":
      return {
        tone: "success",
        text: via ? t(m.connectedVia, { route: via }) : t(m.connected),
      };
    case "pending":
      return { tone: "warning", text: t(m.waitingApproval) };
    case "offline":
      return { tone: "warning", text: t(m.offline) };
    case "removed":
    case "keyChanged":
      return { tone: "warning", text: t(m.needsPairing) };
    default:
      return { tone: "muted", text: t(m.connecting) };
  }
}

/**
 * The Relay nodes the computer links to: Automatic races them all and keeps
 * the fastest, or the Human pins one. Each shows the handshake time this phone
 * measured; a node added here joins the computer's list at once.
 */
function RelaySetting() {
  const { t } = useTranslation();
  const { active, session, relay, setRelayChoice, probeRelays, setRelayNodes } =
    useComputer();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [measuring, setMeasuring] = useState(false);

  // Read the computer's current list once a session is up, then time every
  // node so Automatic and the times shown reflect where the phone is now.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listRelayNodes(session);
        const nodes = list.links_off
          ? []
          : list.items
              .filter((node) => node.enabled)
              .map(({ id, url, label }) => ({ id, url, label }));
        if (
          !cancelled &&
          active &&
          !sameRelayNodes(nodes, relayNodesOf(active))
        )
          await setRelayNodes(nodes);
      } catch {
        // An older computer has no list to read; keep the one it named.
      }
      if (cancelled) return;
      setMeasuring(true);
      await probeRelays().finally(() => {
        if (!cancelled) setMeasuring(false);
      });
    })();
    return () => {
      cancelled = true;
    };
    // Runs per session; the list and times it stores do not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  if (!active) return null;
  const nodes = relayNodesOf(active);
  if (nodes.length === 0) return null;
  const choice = nodes.some((node) => node.id === active.relayChoice)
    ? active.relayChoice
    : "auto";

  const choose = (next: string) => {
    if (next === choice) return;
    void setRelayChoice(next);
  };

  const add = async () => {
    if (!session) return;
    setBusy(true);
    setProblem(undefined);
    try {
      await addRelayNode(session, draft.trim());
      const list = await listRelayNodes(session);
      await setRelayNodes(
        list.items
          .filter((node) => node.enabled)
          .map(({ id, url, label }) => ({ id, url, label })),
      );
      setDraft("");
      setAdding(false);
      void probeRelays();
    } catch (error) {
      setProblem(
        error instanceof HttpError && error.code === "INVALID_RELAY_URL"
          ? t(m.invalidRelayURL)
          : error instanceof HttpError && error.code === "RELAY_EXISTS"
            ? t(m.relayExists)
            : error instanceof HttpError && error.code === "TOO_MANY_RELAYS"
              ? t(m.tooManyRelays)
              : error instanceof HttpError &&
                  error.code === "RELAY_PRIVATE_FROM_PHONE"
                ? t(m.relayPrivate)
                : t(m.relayNotAdded),
      );
    } finally {
      setBusy(false);
    }
  };

  const timeOf = (url: string) => {
    const ms = active.relayLatency?.[url];
    if (ms !== undefined) return t(m.milliseconds, { ms: Math.round(ms) });
    return measuring ? "…" : "–";
  };

  return (
    <SettingsGroup
      label={t(m.relayLabel)}
      footer={
        problem ? (
          <SettingsNote tone="warning">{problem}</SettingsNote>
        ) : (
          t(m.relayFooter)
        )
      }
    >
      <SettingsRow
        title={t(m.automatic)}
        onPress={() => choose("auto")}
        accessibilityLabel={t(m.automaticNode)}
        accessibilityState={{ selected: choice === "auto" }}
        trailing={choice === "auto" ? <Check /> : <View style={styles.check} />}
      />
      {nodes.map((node) => (
        <SettingsRow
          key={node.id}
          title={node.label}
          subtitle={
            relay === node.url ? (
              <StatusLine tone="success" text={t(m.inUse)} />
            ) : undefined
          }
          detail={timeOf(node.url)}
          onPress={() => choose(node.id)}
          accessibilityLabel={t(m.useOnly, { name: node.label })}
          accessibilityState={{ selected: choice === node.id }}
          trailing={
            choice === node.id ? <Check /> : <View style={styles.check} />
          }
        />
      ))}
      {adding ? (
        <View style={styles.addForm}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="ws://203.0.113.7:7787"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            autoFocus
            style={styles.addInput}
            accessibilityLabel={t(m.nodeAddress)}
            onSubmitEditing={() => void add()}
          />
          <View style={styles.addActions}>
            <Button
              label={t(m.cancel)}
              variant="quiet"
              compact
              onPress={() => {
                setAdding(false);
                setProblem(undefined);
              }}
            />
            <Button
              label={t(m.add)}
              compact
              busy={busy}
              disabled={!draft.trim() || !session}
              onPress={() => void add()}
            />
          </View>
        </View>
      ) : (
        <SettingsRow
          title={t(m.addNode)}
          tone="accent"
          onPress={() => setAdding(true)}
        />
      )}
    </SettingsGroup>
  );
}

type Sending =
  | { readonly step: "ask" }
  | { readonly step: "busy" }
  | { readonly step: "sent"; readonly reportId: string }
  | {
      readonly step: "failed";
      readonly message: string;
      readonly retry: boolean;
    };

/**
 * Send Diagnostics, as on the desktop: the phone's log of events and timings
 * (never content) goes to Linger's receiver after the Human agrees, and the
 * report ID it answers with is what support asks for. Save Diagnostics hands
 * the same log to the share sheet instead.
 */
function DiagnosticsSetting() {
  const { t } = useTranslation();
  const receiver = diagnosticsReceiver();
  const [sending, setSending] = useState<Sending | undefined>();

  const send = async () => {
    setSending({ step: "busy" });
    try {
      setSending({ step: "sent", reportId: await sendAppLog() });
    } catch (error) {
      setSending({
        step: "failed",
        message:
          error instanceof DiagnosticsUploadError
            ? diagnosticsUploadErrorText(error, t)
            : t(m.diagnosticsNotSentBody),
        retry: error instanceof DiagnosticsUploadError ? error.retry : true,
      });
    }
  };

  const host = receiver ? new URL(receiver).host : "";
  return (
    <SettingsGroup
      label={t(m.diagnosticsLabel)}
      footer={t(m.diagnosticsFooter)}
    >
      {receiver ? (
        <SettingsRow
          icon="upload"
          title={t(m.sendDiagnostics)}
          subtitle={t(m.sendDiagnosticsHint)}
          onPress={() => setSending({ step: "ask" })}
        />
      ) : null}
      <SettingsRow
        icon="share"
        title={t(m.saveDiagnostics)}
        subtitle={t(m.saveDiagnosticsHint)}
        onPress={() => void shareAppLog()}
      />
      <ConfirmDialog
        visible={sending?.step === "ask" || sending?.step === "busy"}
        title={t(m.sendDiagnosticsTitle)}
        body={t(m.sendDiagnosticsBody, { host })}
        confirmLabel={t(m.send)}
        busy={sending?.step === "busy"}
        onConfirm={() => void send()}
        onCancel={() => setSending(undefined)}
      />
      <ConfirmDialog
        visible={sending?.step === "sent"}
        title={t(m.diagnosticsSent)}
        body={
          sending?.step === "sent"
            ? t(m.reportID, { id: sending.reportId })
            : undefined
        }
        confirmLabel={t(m.shareID)}
        cancelLabel={t(m.done)}
        onConfirm={() => {
          if (sending?.step === "sent")
            void Share.share({ message: sending.reportId });
        }}
        onCancel={() => setSending(undefined)}
      />
      <ConfirmDialog
        visible={sending?.step === "failed"}
        title={t(m.diagnosticsNotSent)}
        body={sending?.step === "failed" ? sending.message : undefined}
        confirmLabel={
          sending?.step === "failed" && sending.retry
            ? t(m.tryAgain)
            : t(m.saveInstead)
        }
        cancelLabel={t(m.close)}
        onConfirm={() => {
          if (sending?.step === "failed" && sending.retry) void send();
          else {
            setSending(undefined);
            void shareAppLog();
          }
        }}
        onCancel={() => setSending(undefined)}
      />
    </SettingsGroup>
  );
}

function PushSetting() {
  const { t } = useTranslation();
  const { active, session } = useComputer();
  const [enabled, setEnabled] = useState<boolean | undefined>();
  const [preferences, setPreferences] = useState(DEFAULT_PUSH_PREFERENCES);
  const [problem, setProblem] = useState<string | undefined>();
  const setup = pushSetup();
  const hostId = active?.hostId;

  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    void readPushRecord(documentFiles, hostId).then((record) => {
      if (cancelled) return;
      setEnabled(record.enabled);
      setPreferences(record.preferences ?? DEFAULT_PUSH_PREFERENCES);
    });
    return () => {
      cancelled = true;
    };
  }, [hostId]);

  if (!setup || !hostId || enabled === undefined) return null;

  const toggle = async (next: boolean) => {
    setProblem(undefined);
    setEnabled(next);
    try {
      if (next) {
        const granted = await enablePush({
          session,
          hostId,
          files: documentFiles,
        });
        if (!granted) setProblem(t(m.notificationsOffInSystem));
      } else {
        await disablePush({ session, hostId, files: documentFiles });
      }
    } catch {
      setEnabled(!next);
      setProblem(session ? t(m.changeNotDelivered) : t(m.connectToChange));
    }
  };

  const change = async (next: PushPreferences) => {
    setProblem(undefined);
    setPreferences(next);
    try {
      await setPushPreferences({
        session,
        hostId,
        files: documentFiles,
        preferences: next,
      });
    } catch {
      // The phone keeps the choice and sends it on the next session.
      setProblem(t(m.savedOnPhone));
    }
  };
  const option = (
    key: keyof PushPreferences,
    title: string,
    subtitle?: string,
  ) => (
    <SettingsRow
      key={key}
      title={title}
      subtitle={subtitle}
      trailing={
        <SettingsSwitch
          value={preferences[key]}
          disabled={!enabled}
          onValueChange={(value) =>
            void change({ ...preferences, [key]: value })
          }
          accessibilityLabel={title}
        />
      }
    />
  );

  // The master switch gets a group of its own; the two groups under it dim,
  // and keep their choices, while it is off, so the dependency shows.
  return (
    <>
      <SettingsGroup
        label={t(m.notificationsLabel)}
        footer={
          problem ? <SettingsNote tone="warning">{problem}</SettingsNote> : null
        }
      >
        <SettingsRow
          title={t(m.allowNotifications)}
          trailing={
            <SettingsSwitch
              value={enabled}
              onValueChange={(value) => void toggle(value)}
              accessibilityLabel={t(m.allowNotifications)}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup label={t(m.notifyAbout)} disabled={!enabled}>
        {option("replies", t(m.agentReplies), t(m.agentRepliesHint))}
        {option("decisions", t(m.decisions), t(m.decisionsHint))}
      </SettingsGroup>
      <SettingsGroup
        label={t(m.elsewhereLabel)}
        disabled={!enabled}
        footer={preferences.whenActive ? t(m.elsewhereOn) : t(m.elsewhereOff)}
      >
        {option("whenActive", t(m.notifyPhoneToo))}
      </SettingsGroup>
    </>
  );
}

/**
 * The interface language, kept on this phone: Follow System (the default)
 * tracks the phone's language, or English or Simplified Chinese is pinned.
 * Each language is named in its own language, as on the Web.
 */
function LanguageSetting() {
  const { t, choice, language } = useTranslation();
  const nameOf = (tag: string) =>
    LANGUAGES.find((entry) => entry.tag === tag)?.name ?? tag;
  const row = (value: LanguageChoice, title: string, detail?: string) => (
    <SettingsRow
      key={value}
      title={title}
      detail={detail}
      onPress={() => {
        if (value !== choice) setLanguageChoice(value);
      }}
      accessibilityState={{ selected: choice === value }}
      trailing={choice === value ? <Check /> : <View style={styles.check} />}
    />
  );
  return (
    <SettingsGroup label={t(m.languageLabel)} footer={t(m.languageFooter)}>
      {row(
        "system",
        t(m.followSystem),
        choice === "system" ? nameOf(language) : undefined,
      )}
      {LANGUAGES.map((entry) => row(entry.tag, entry.name))}
    </SettingsGroup>
  );
}

export default function SettingsScreen() {
  const { t } = useTranslation();
  const { computers, active, route, relay, status, switchTo, unpair } =
    useComputer();
  const version = Constants.expoConfig?.version ?? "unknown";
  const [unpairing, setUnpairing] = useState<
    { readonly hostId: string; readonly name: string } | undefined
  >();
  const [unpairBusy, setUnpairBusy] = useState(false);

  const confirmUnpair = async () => {
    if (!unpairing) return;
    const last = computers.length <= 1;
    setUnpairBusy(true);
    try {
      await unpair(unpairing.hostId);
    } finally {
      setUnpairBusy(false);
      setUnpairing(undefined);
    }
    if (last) router.replace("/pair");
  };

  const via =
    route === "relay"
      ? (active &&
          relayNodesOf(active).find((node) => node.url === relay)?.label) ||
        t(m.routeRelay)
      : route === "lan"
        ? t(m.routeLan)
        : undefined;
  const activeStatus = statusLine(t, status, via);

  return (
    <View style={styles.screen}>
      <StatusStrip />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        <Text style={styles.title} accessibilityRole="header">
          {t(m.title)}
        </Text>
        <SettingsGroup>
          {computers.map((computer) => {
            const isActive = computer.hostId === active?.hostId;
            return (
              <SettingsRow
                key={computer.hostId}
                icon="laptop"
                title={computer.name}
                subtitle={
                  isActive ? (
                    <StatusLine {...activeStatus} />
                  ) : (
                    <StatusLine tone="muted" text={t(m.tapToSwitch)} />
                  )
                }
                onPress={
                  isActive
                    ? undefined
                    : () =>
                        void switchTo(computer.hostId).then(() =>
                          router.replace("/"),
                        )
                }
                accessibilityLabel={t(m.switchTo, { name: computer.name })}
              />
            );
          })}
          <SettingsRow
            icon="add"
            title={t(m.pairAnother)}
            chevron
            onPress={() => router.push("/pair")}
          />
          {active ? (
            <SettingsRow
              icon={null}
              title={t(m.unpairNamed, { name: active.name })}
              tone="danger"
              onPress={() =>
                setUnpairing({ hostId: active.hostId, name: active.name })
              }
            />
          ) : null}
        </SettingsGroup>

        <RelaySetting />

        <PushSetting />

        <LanguageSetting />

        <SettingsGroup footer={t(m.dataStays)}>
          <SettingsRow title={t(m.version)} detail={version} />
        </SettingsGroup>

        <DiagnosticsSetting />
      </ScrollView>

      <ConfirmDialog
        visible={unpairing !== undefined}
        title={
          unpairing
            ? t(m.unpairTitle, { name: unpairing.name })
            : t(m.unpairThisComputer)
        }
        body={t(m.unpairBody)}
        confirmLabel={t(m.unpair)}
        tone="danger"
        busy={unpairBusy}
        onConfirm={() => void confirmUnpair()}
        onCancel={() => setUnpairing(undefined)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sidebar },
  content: { paddingBottom: space.xxl * 2 },
  // The groups' own inset plus their label's, so the title starts where
  // the section labels do.
  title: {
    ...StyleSheet.flatten(type.title),
    fontSize: 32,
    lineHeight: 40,
    paddingHorizontal: space.md + 6,
    paddingTop: space.xs,
  },
  check: { width: 20 },
  addForm: { padding: space.md, gap: space.sm },
  addInput: {
    ...StyleSheet.flatten(type.chat),
    minHeight: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: space.md,
    color: colors.ink,
  },
  addActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: space.sm,
  },
});
