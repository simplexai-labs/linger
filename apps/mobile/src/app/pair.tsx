// Pairing: scan the code the computer shows (or open its link), run the
// pairing handshake, show the confirmation code, and wait for approval.
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useComputer } from "../computer/computer-context";
import {
  pairingFailureMessage,
  PairingError,
  pairWithComputer,
} from "../computer/pairing";
import {
  parsePairingLink,
  PairingLinkError,
  type PairingLink,
} from "../computer/pairing-link";
import { computerPairingMessages } from "../computer/pairing.messages";
import { documentFiles } from "../computer/store-expo";
import type { Message } from "../i18n/messages";
import { useTranslation } from "../i18n/use-translation";
import { requestPushPermission, syncPushGrant } from "../push/push";
import { generateKeyPair } from "../session/noise";
import { pairMessages as m } from "../screens/pair.messages";
import { PhoneSession } from "../session/session";
import { colors, radius, space, touchTarget, type } from "../theme";
import { Button } from "../ui/controls";
import { Icon } from "../ui/icon";
import { Text, TextInput } from "../ui/text";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appIcon = require("../../assets/icon.png");

type Stage =
  | { readonly kind: "scan" }
  | { readonly kind: "connecting"; readonly link: PairingLink }
  | { readonly kind: "waiting"; readonly link: PairingLink }
  | { readonly kind: "finishing" }
  | { readonly kind: "error"; readonly message: Message<string> };

function linkProblemMessage(error: unknown): Message<string> {
  if (error instanceof PairingLinkError) {
    switch (error.problem) {
      case "EXPIRED":
        return computerPairingMessages.expired;
      case "UNSUPPORTED_VERSION":
        return m.newerVersion;
      case "NOT_A_PAIRING_CODE":
        return m.notAPairingCode;
    }
  }
  return m.unreadable;
}

export default function PairScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ d?: string }>();
  const computer = useComputer();
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState<Stage>({ kind: "scan" });
  const busy = useRef(false);
  const handledLink = useRef<string | undefined>(undefined);

  const start = useCallback(
    async (raw: string) => {
      if (busy.current) return;
      busy.current = true;
      let link: PairingLink;
      try {
        link = parsePairingLink(raw);
      } catch (error) {
        setStage({ kind: "error", message: linkProblemMessage(error) });
        busy.current = false;
        return;
      }
      setStage({ kind: "connecting", link });
      const key = generateKeyPair();
      try {
        const result = await pairWithComputer({
          link,
          staticKey: key,
          deviceName: Device.deviceName ?? Device.modelName ?? "Phone",
          platform: Platform.OS === "ios" ? "ios" : "android",
          socketFactory: computer.socketFactory,
          open: PhoneSession.open,
        });
        await computer.completePairing({
          link,
          key,
          session: result.session,
          route: result.route,
        });
        setStage({ kind: "waiting", link });
      } catch (error) {
        setStage({
          kind: "error",
          message:
            error instanceof PairingError
              ? pairingFailureMessage(error.failure)
              : m.stoppedUnexpectedly,
        });
        busy.current = false;
      }
    },
    [computer],
  );

  // A pairing link opened from outside the app lands here with its payload.
  useEffect(() => {
    if (params.d && handledLink.current !== params.d) {
      handledLink.current = params.d;
      void start(params.d);
    }
  }, [params.d, start]);

  // Approval arrives through the connection that adopted the pairing session.
  const pairedHost = stage.kind === "waiting" ? stage.link.hostId : undefined;
  const activeHost = computer.active?.hostId;
  const statusKind = computer.status?.kind;
  useEffect(() => {
    if (!pairedHost) return;
    if (activeHost === pairedHost && statusKind === "connected") {
      setStage({ kind: "finishing" });
      const session = computer.session;
      void requestPushPermission()
        .then((granted) =>
          granted && session
            ? syncPushGrant({
                session,
                hostId: pairedHost,
                files: documentFiles,
              })
            : undefined,
        )
        .catch(() => undefined)
        .finally(() => router.replace("/"));
    } else if (activeHost !== pairedHost && computer.removedNotice) {
      busy.current = false;
      setStage({
        kind: "error",
        message: pairingFailureMessage("PHONE_REMOVED"),
      });
      computer.dismissRemovedNotice();
    }
  }, [activeHost, computer, pairedHost, statusKind]);

  const code =
    computer.status?.kind === "pending" ? computer.status.code : undefined;
  const canCancel = computer.computers.length > 0 && stage.kind !== "waiting";

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={styles.header}>
        {canCancel ? (
          <Button
            label={t(m.cancel)}
            variant="quiet"
            compact
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace("/")
            }
          />
        ) : null}
      </View>

      {stage.kind === "scan" ? (
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Image
            source={appIcon}
            style={styles.mark}
            accessibilityIgnoresInvertColors
          />
          <View style={styles.intro}>
            <Text style={type.title} accessibilityRole="header">
              {t(m.title)}
            </Text>
            <Text style={styles.lead}>{t(m.lead)}</Text>
          </View>

          <View style={styles.steps}>
            {STEPS.map((step, index) => (
              <View key={step.id} style={styles.step}>
                <View style={styles.stepNumber}>
                  <Text style={styles.stepNumberText}>{index + 1}</Text>
                </View>
                <Text style={styles.stepText}>{t(step)}</Text>
              </View>
            ))}
          </View>

          {permission?.granted ? (
            <View style={[styles.viewfinder, styles.viewfinderLive]}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={(result) => void start(result.data)}
                accessibilityLabel={t(m.viewfinder)}
              />
              <CornerGuides color={colors.surface} />
            </View>
          ) : (
            <View style={[styles.viewfinder, styles.viewfinderIdle]}>
              <CornerGuides color={colors.borderStrong} />
              <View style={styles.cameraBadge}>
                <Icon name="camera" size={24} color={colors.muted} />
              </View>
              <Text style={styles.cameraText}>
                {permission && !permission.canAskAgain
                  ? t(m.cameraOff)
                  : t(m.cameraUse)}
              </Text>
              {!permission || permission.canAskAgain ? (
                <Button
                  label={t(m.allowCamera)}
                  onPress={() => void requestPermission()}
                />
              ) : null}
            </View>
          )}

          <PairingLinkEntry onSubmit={(link) => void start(link)} />
        </ScrollView>
      ) : null}

      {stage.kind === "connecting" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.muted} />
          <Text style={type.body}>
            {t(m.connecting, { name: stage.link.computerName })}
          </Text>
        </View>
      ) : null}

      {stage.kind === "waiting" ? (
        <View style={styles.centered}>
          {code ? (
            <>
              <Text style={type.small}>{t(m.confirmationCode)}</Text>
              <Text
                style={styles.code}
                accessibilityLabel={t(m.confirmationCodeSpoken, {
                  digits: code.split("").join(" "),
                })}
              >
                {code.slice(0, 3)} {code.slice(3)}
              </Text>
              <Text style={[type.body, styles.center]}>{t(m.checkCode)}</Text>
            </>
          ) : (
            <>
              <ActivityIndicator color={colors.muted} />
              <Text style={[type.body, styles.center]}>
                {computer.status?.kind === "connected"
                  ? t(m.paired)
                  : t(m.reconnecting, { name: stage.link.computerName })}
              </Text>
            </>
          )}
        </View>
      ) : null}

      {stage.kind === "finishing" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.muted} />
          <Text style={type.body}>{t(m.opening)}</Text>
        </View>
      ) : null}

      {stage.kind === "error" ? (
        <View style={styles.centered}>
          <Text style={[type.body, styles.center]} accessibilityRole="alert">
            {t(stage.message)}
          </Text>
          <Button
            label={t(m.scanAgain)}
            onPress={() => {
              busy.current = false;
              setStage({ kind: "scan" });
            }}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const STEPS = [m.stepOpenSettings, m.stepPairPhone, m.stepPoint] as const;

/** Four soft corners that frame where the code goes. */
function CornerGuides(props: { readonly color: string }) {
  const color = { borderColor: props.color };
  return (
    <View style={styles.guides} pointerEvents="none">
      <View style={[styles.corner, styles.topLeft, color]} />
      <View style={[styles.corner, styles.topRight, color]} />
      <View style={[styles.corner, styles.bottomLeft, color]} />
      <View style={[styles.corner, styles.bottomRight, color]} />
    </View>
  );
}

/**
 * The way in for a phone that cannot scan, such as the iOS Simulator: the
 * computer's Copy pairing link, opened on the phone or pasted here.
 */
function PairingLinkEntry(props: {
  readonly onSubmit: (link: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!Device.isDevice);
  const [value, setValue] = useState("");
  const link = value.trim();
  return (
    <View style={styles.linkBox}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={({ pressed }) => [styles.linkToggle, pressed && styles.pressed]}
      >
        <Icon name="link" size={20} color={colors.muted} />
        <Text style={styles.linkTitle}>{t(m.linkToggle)}</Text>
        <View style={open ? styles.chevronOpen : undefined}>
          <Icon name="chevron" size={16} color={colors.muted} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.linkBody}>
          <Text style={styles.linkText}>{t(m.linkHelp)}</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder="linger://pair?d=…"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={() => link && props.onSubmit(link)}
            accessibilityLabel={t(m.linkLabel)}
            style={styles.input}
          />
          <Button
            label={t(m.pair)}
            variant="secondary"
            disabled={!link}
            onPress={() => props.onSubmit(link)}
          />
        </View>
      ) : null}
    </View>
  );
}

const CORNER = 28;
const CORNER_WIDTH = 3;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: {
    minHeight: touchTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: space.lg,
  },
  scroll: {
    paddingHorizontal: space.xl,
    paddingBottom: space.xxl,
    gap: space.xl,
  },
  mark: { width: 48, height: 48, borderRadius: radius.xl },
  intro: { gap: space.xs },
  lead: { fontSize: 15, lineHeight: 22, color: colors.muted },
  steps: { gap: space.md },
  step: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  stepNumber: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumberText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.secondary,
    fontVariant: ["tabular-nums"],
  },
  stepText: { flex: 1, fontSize: 15, lineHeight: 22, color: colors.body },
  viewfinder: {
    aspectRatio: 1,
    borderRadius: radius.xxl,
    overflow: "hidden",
  },
  viewfinderLive: { backgroundColor: colors.ink },
  viewfinderIdle: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xxl,
    gap: space.lg,
  },
  cameraBadge: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraText: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.muted,
    textAlign: "center",
  },
  guides: { ...StyleSheet.absoluteFill, margin: "14%" },
  corner: { position: "absolute", width: CORNER, height: CORNER },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderTopLeftRadius: radius.lg,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderTopRightRadius: radius.lg,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderBottomLeftRadius: radius.lg,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderBottomRightRadius: radius.lg,
  },
  linkBox: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  linkToggle: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  pressed: { backgroundColor: colors.surfaceSoft },
  linkTitle: { flex: 1, fontSize: 15, fontWeight: "500", color: colors.ink },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  linkBody: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.md,
  },
  linkText: { fontSize: 13, lineHeight: 18, color: colors.muted },
  input: {
    minHeight: touchTarget,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: 15,
    color: colors.ink,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xxl,
    gap: space.lg,
  },
  code: {
    fontSize: 48,
    fontWeight: "600",
    letterSpacing: 6,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  center: { textAlign: "center" },
});
