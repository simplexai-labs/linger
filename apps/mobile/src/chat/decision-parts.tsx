// Pieces several decision cards share: approve or deny with an optional
// reason, a secret key field, and the in-app browser a sign-in opens in.
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../i18n/use-translation";
import { colors, radius, space, touchTarget, type } from "../theme";
import { Button } from "../ui/controls";
import { Text, TextInput } from "../ui/text";
import { chatDecisionMessages as m } from "./decision-card.messages";

/**
 * Approve, or deny with a reason the Human may add. When a denial needs a
 * reason, deny opens the field first and only a written reason denies.
 */
export function ApprovalActions(props: {
  readonly approveLabel: string;
  readonly approveAccessibilityLabel?: string;
  readonly approveDisabled?: boolean;
  readonly denyLabel: string;
  readonly reasonRequired?: boolean;
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onDeny: (reason: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [composing, setComposing] = useState(false);
  const [reason, setReason] = useState("");
  const written = reason.trim();
  const deny = () => {
    if (props.reasonRequired && !written) {
      setComposing(true);
      return;
    }
    props.onDeny(composing && written ? written : undefined);
  };
  return (
    <View style={styles.stack}>
      {composing ? (
        <TextInput
          style={styles.input}
          placeholder={t(m.reasonPlaceholder)}
          placeholderTextColor={colors.placeholder}
          value={reason}
          onChangeText={setReason}
          accessibilityLabel={t(m.denyReason)}
          editable={!props.busy}
          autoFocus
          multiline
        />
      ) : null}
      <View style={styles.actions}>
        <Button
          label={props.approveLabel}
          accessibilityLabel={props.approveAccessibilityLabel}
          onPress={props.onApprove}
          busy={props.busy}
          disabled={props.approveDisabled}
          style={styles.action}
        />
        <Button
          label={props.denyLabel}
          variant="secondary"
          onPress={deny}
          disabled={
            props.busy || (composing && !!props.reasonRequired && !written)
          }
          style={styles.action}
        />
      </View>
      {composing || props.reasonRequired ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setComposing(true)}
          hitSlop={8}
          style={styles.reasonLink}
        >
          <Text style={styles.link}>{t(m.addReason)}</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * One API key field with its Save button. The key goes to TeamHub, never
 * into the chat or the log; the field clears once TeamHub keeps it.
 * `save` resolves the reason it was refused, or undefined once saved.
 */
export function SecretField(props: {
  readonly label: string;
  readonly hint?: { readonly text: string; readonly url: string };
  readonly secondary?: boolean;
  readonly save: (key: string) => Promise<string | undefined>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const key = value.trim();
  const submit = async () => {
    if (!key || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const refused = await props.save(key);
      if (refused) setError(refused);
      else setValue("");
    } finally {
      setSaving(false);
    }
  };
  return (
    <View style={styles.field}>
      <Text style={type.caption}>{props.label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={(text) => {
          setValue(text);
          setError(undefined);
        }}
        onSubmitEditing={() => void submit()}
        accessibilityLabel={props.label}
        editable={!saving}
        secureTextEntry
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        textContentType="none"
        importantForAutofill="no"
        returnKeyType="done"
      />
      {error ? (
        <Text style={[type.small, styles.problem]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Button
        label={saving ? t(m.checkingKey) : t(m.saveKey)}
        variant={props.secondary ? "secondary" : "primary"}
        onPress={() => void submit()}
        disabled={!key || saving}
      />
      {props.hint ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => void openInBrowser(props.hint?.url ?? "")}
          hitSlop={8}
        >
          <Text style={styles.link}>{props.hint.text}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Opens a page in the in-app browser and resolves once the Human is back in
 * the app. iOS resolves when the browser is closed; Android as soon as the
 * tab opens, so the app's return to the foreground marks the end there.
 */
export async function openInBrowser(url: string): Promise<void> {
  let result: WebBrowser.WebBrowserResult;
  try {
    result = await WebBrowser.openBrowserAsync(url, {
      dismissButtonStyle: "close",
    });
  } catch {
    // Another browser is already up; the Human is in it.
    return;
  }
  if (result.type !== WebBrowser.WebBrowserResultType.OPENED) return;
  await new Promise<void>((resolve) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      subscription.remove();
      resolve();
    });
  });
}

export const styles = StyleSheet.create({
  stack: { gap: space.sm },
  field: { gap: space.sm },
  actions: { flexDirection: "row", gap: space.md },
  action: { flex: 1 },
  input: {
    ...StyleSheet.flatten(type.body),
    minHeight: touchTarget,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  reasonLink: { alignSelf: "flex-start" },
  link: {
    ...StyleSheet.flatten(type.small),
    color: colors.link,
  },
  problem: { color: colors.danger },
  // A row in a card's list: an app, a link or a file.
  row: {
    minHeight: touchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  rowLabel: { ...StyleSheet.flatten(type.chat), flex: 1, color: colors.ink },
  rowMeta: { ...StyleSheet.flatten(type.small) },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
});
