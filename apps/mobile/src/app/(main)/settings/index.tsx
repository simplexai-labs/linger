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
import { DiagnosticsUploadError } from "../../../lib/diagnostics-upload";
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

function Check() {
  return <Icon name="check" size={20} color={colors.accent} />;
}

/** The active computer's state and route as a dot and a few words. */
function statusLine(
  status: ConnectionStatus | undefined,
  via: string | undefined,
): { tone: "success" | "warning" | "muted"; text: string } {
  switch (status?.kind) {
    case "connected":
      return {
        tone: "success",
        text: via ? `Connected · ${via}` : "Connected",
      };
    case "pending":
      return { tone: "warning", text: "Waiting for approval" };
    case "offline":
      return { tone: "warning", text: "Offline · Retrying" };
    case "removed":
    case "keyChanged":
      return { tone: "warning", text: "Needs pairing again" };
    default:
      return { tone: "muted", text: "Connecting…" };
  }
}

/**
 * The Relay nodes the computer links to: Automatic races them all and keeps
 * the fastest, or the Human pins one. Each shows the handshake time this phone
 * measured; a node added here joins the computer's list at once.
 */
function RelaySetting() {
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
          ? "Use a ws:// or wss:// address, such as ws://203.0.113.7:7787."
          : error instanceof HttpError && error.code === "RELAY_EXISTS"
            ? "Your computer already has this node."
            : error instanceof HttpError && error.code === "TOO_MANY_RELAYS"
              ? "Your computer has eight nodes you added. Remove one there first."
              : error instanceof HttpError &&
                  error.code === "RELAY_PRIVATE_FROM_PHONE"
                ? "A node on a private network can be added only on your computer."
                : "The node was not added. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const timeOf = (url: string) => {
    const ms = active.relayLatency?.[url];
    if (ms !== undefined) return `${Math.round(ms)} ms`;
    return measuring ? "…" : "–";
  };

  return (
    <SettingsGroup
      label="Relay"
      footer={
        problem ? (
          <SettingsNote tone="warning">{problem}</SettingsNote>
        ) : (
          "Used away from your computer's Wi-Fi. Times are a request's round trip."
        )
      }
    >
      <SettingsRow
        title="Automatic"
        onPress={() => choose("auto")}
        accessibilityLabel="Automatic Relay node"
        accessibilityState={{ selected: choice === "auto" }}
        trailing={choice === "auto" ? <Check /> : <View style={styles.check} />}
      />
      {nodes.map((node) => (
        <SettingsRow
          key={node.id}
          title={node.label}
          subtitle={
            relay === node.url ? (
              <StatusLine tone="success" text="In use" />
            ) : undefined
          }
          detail={timeOf(node.url)}
          onPress={() => choose(node.id)}
          accessibilityLabel={`Use only ${node.label}`}
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
            accessibilityLabel="Relay node address"
            onSubmitEditing={() => void add()}
          />
          <View style={styles.addActions}>
            <Button
              label="Cancel"
              variant="quiet"
              compact
              onPress={() => {
                setAdding(false);
                setProblem(undefined);
              }}
            />
            <Button
              label="Add"
              compact
              busy={busy}
              disabled={!draft.trim() || !session}
              onPress={() => void add()}
            />
          </View>
        </View>
      ) : (
        <SettingsRow
          title="Add Node"
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
          error instanceof Error
            ? error.message
            : "The diagnostics were not sent.",
        retry: error instanceof DiagnosticsUploadError ? error.retry : true,
      });
    }
  };

  const host = receiver ? new URL(receiver).host : "";
  return (
    <SettingsGroup
      label="Diagnostics"
      footer="Diagnostics hold this phone's events and timings, never messages, documents or keys."
    >
      {receiver ? (
        <SettingsRow
          icon="upload"
          title="Send Diagnostics"
          subtitle="Upload for support and get a report ID"
          onPress={() => setSending({ step: "ask" })}
        />
      ) : null}
      <SettingsRow
        icon="share"
        title="Save Diagnostics"
        subtitle="Share the log file yourself"
        onPress={() => void shareAppLog()}
      />
      <ConfirmDialog
        visible={sending?.step === "ask" || sending?.step === "busy"}
        title="Send diagnostics?"
        body={`This phone's log of events and timings goes to ${host}. It holds no messages, documents or keys.`}
        confirmLabel="Send"
        busy={sending?.step === "busy"}
        onConfirm={() => void send()}
        onCancel={() => setSending(undefined)}
      />
      <ConfirmDialog
        visible={sending?.step === "sent"}
        title="Diagnostics sent"
        body={
          sending?.step === "sent"
            ? `Report ID ${sending.reportId}. Give it to support so they can find it.`
            : undefined
        }
        confirmLabel="Share ID"
        cancelLabel="Done"
        onConfirm={() => {
          if (sending?.step === "sent")
            void Share.share({ message: sending.reportId });
        }}
        onCancel={() => setSending(undefined)}
      />
      <ConfirmDialog
        visible={sending?.step === "failed"}
        title="Diagnostics not sent"
        body={sending?.step === "failed" ? sending.message : undefined}
        confirmLabel={
          sending?.step === "failed" && sending.retry
            ? "Try Again"
            : "Save Instead"
        }
        cancelLabel="Close"
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
        if (!granted)
          setProblem("Turn on notifications for Linger in iOS Settings.");
      } else {
        await disablePush({ session, hostId, files: documentFiles });
      }
    } catch {
      setEnabled(!next);
      setProblem(
        session
          ? "The change did not reach your computer. Try again."
          : "Connect to your computer to change this.",
      );
    }
  };

  const change = async (next: PushPreferences) => {
    setProblem(undefined);
    const previous = preferences;
    setPreferences(next);
    try {
      await setPushPreferences({
        session,
        hostId,
        files: documentFiles,
        preferences: next,
      });
    } catch {
      setPreferences(previous);
      setProblem("The change did not reach your computer. Try again.");
    }
  };
  const option = (
    key: keyof PushPreferences,
    title: string,
    subtitle: string,
  ) => (
    <SettingsRow
      key={key}
      title={title}
      subtitle={subtitle}
      trailing={
        <SettingsSwitch
          value={preferences[key]}
          onValueChange={(value) =>
            void change({ ...preferences, [key]: value })
          }
          accessibilityLabel={title}
        />
      }
    />
  );

  return (
    <SettingsGroup
      footer={
        problem ? (
          <SettingsNote tone="warning">{problem}</SettingsNote>
        ) : enabled ? (
          "One alert when an Agent finishes, never while you are looking at the chat."
        ) : null
      }
    >
      <SettingsRow
        title="Notifications"
        trailing={
          <SettingsSwitch
            value={enabled}
            onValueChange={(value) => void toggle(value)}
            accessibilityLabel="Notifications"
          />
        }
      />
      {enabled
        ? [
            option("replies", "Replies", "When an Agent finishes a reply"),
            option("decisions", "Decisions", "When Linger needs your decision"),
            option(
              "whenActive",
              "Even at My Computer",
              "Also while you look at the chat elsewhere",
            ),
          ]
        : null}
    </SettingsGroup>
  );
}

export default function SettingsScreen() {
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
        "Relay"
      : route === "lan"
        ? "Same Wi-Fi"
        : undefined;
  const activeStatus = statusLine(status, via);

  return (
    <View style={styles.screen}>
      <StatusStrip />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        <Text style={styles.title} accessibilityRole="header">
          Settings
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
                    <StatusLine tone="muted" text="Tap to switch" />
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
                accessibilityLabel={`Switch to ${computer.name}`}
              />
            );
          })}
          <SettingsRow
            icon="add"
            title="Pair Another Computer"
            chevron
            onPress={() => router.push("/pair")}
          />
          {active ? (
            <SettingsRow
              icon={null}
              title={`Unpair ${active.name}`}
              tone="danger"
              onPress={() =>
                setUnpairing({ hostId: active.hostId, name: active.name })
              }
            />
          ) : null}
        </SettingsGroup>

        <RelaySetting />

        <PushSetting />

        <SettingsGroup footer="Your data stays on your computer.">
          <SettingsRow title="Version" detail={version} />
        </SettingsGroup>

        <DiagnosticsSetting />
      </ScrollView>

      <ConfirmDialog
        visible={unpairing !== undefined}
        title={`Unpair ${unpairing?.name ?? "this computer"}?`}
        body="This phone forgets the computer and deletes what it keeps for it."
        confirmLabel="Unpair"
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
