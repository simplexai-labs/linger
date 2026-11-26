// The decision cards about Connected Apps and what Another Me may read: the
// setup cards (connect apps; share links and files) and a connection
// authorization. A sign-in opens in the in-app browser; the card settles
// from the Room's events once TeamHub sees the Connection active.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  checkExternalConnection,
  createExternalConnection,
  deleteAttachmentUpload,
  getExternalConnection,
  listExternalApps,
  listExternalConnections,
  newIdempotencyKey,
  reauthorizeExternalConnection,
  uploadAttachment,
} from "../api/teamhub";
import type {
  DecisionCard as Card,
  ExternalApp,
  ExternalConnection,
  MessageAttachmentUpload,
} from "../api/types";
import type { Translate } from "../i18n/language";
import { useTranslation } from "../i18n/use-translation";
import { HttpError } from "../session/http";
import { SessionClosed } from "../session/session";
import { NotConnected, teamHubKey, useTeamHub } from "../state/queries";
import { colors, radius, space, touchTarget, type } from "../theme";
import { Button } from "../ui/controls";
import { Icon } from "../ui/icon";
import { Text, TextInput } from "../ui/text";
import { MAX_UPLOAD_BYTES } from "./composer";
import { chatComposerMessages } from "./composer.messages";
import {
  AppUnavailableForAgents,
  FEISHU_MAIL,
  accountChoices,
  canConnectNewAccount,
  connectLink,
  defaultAccount,
  openPendingConnection,
  prepareAuthorization,
  reauthorizationConnectUrl,
  usableConnectUrl,
  type ConnectionCalls,
} from "./connections";
import type { DecisionAnswering } from "./decision-answer";
import { chatDecisionMessages as m } from "./decision-card.messages";
import {
  ApprovalActions,
  SecretField,
  openInBrowser,
  styles as parts,
} from "./decision-parts";
import { saveComposioKey } from "./decision-key-views";
import {
  MAX_FILES,
  MAX_LINKS,
  formatFileSize,
  linkLabel,
  linkProblem,
  type LinkProblem,
} from "./setup-sources";
import { sendRetryingOnce } from "./upload-retry";

export interface DecisionViewProps {
  readonly card: Card;
  readonly roomId: string;
  /** This Human may answer the card now. */
  readonly canAnswer: boolean;
  readonly decision: DecisionAnswering;
}

function useExternalApps() {
  const teamHub = useTeamHub();
  return useQuery({
    queryKey: teamHubKey(teamHub.hostId, "external-apps"),
    enabled: teamHub.connected,
    staleTime: 5 * 60_000,
    queryFn: () => teamHub.run(listExternalApps),
  });
}

function useExternalConnections(enabled: boolean) {
  const teamHub = useTeamHub();
  return useQuery({
    queryKey: teamHubKey(teamHub.hostId, "external-connections"),
    enabled: teamHub.connected && enabled,
    queryFn: async () =>
      (await teamHub.run(listExternalConnections)).connections,
  });
}

/** The Connection calls over the current session, and the sign-in's end. */
function useConnectionCalls() {
  const teamHub = useTeamHub();
  const client = useQueryClient();
  const calls: ConnectionCalls = {
    get: (id) => teamHub.run((session) => getExternalConnection(session, id)),
    create: (appKey) =>
      teamHub.run((session) => createExternalConnection(session, appKey)),
    reauthorize: (connection) =>
      teamHub.run((session) =>
        reauthorizeExternalConnection(session, connection),
      ),
  };
  const reload = () =>
    client.invalidateQueries({
      queryKey: teamHubKey(teamHub.hostId, "external-connections"),
    });
  /**
   * Back from the browser: asks TeamHub to check the Connection now rather
   * than on its schedule. Best effort; the card follows the Room's events.
   */
  const afterSignIn = async (connection: ExternalConnection) => {
    try {
      const current = await calls.get(connection.id);
      if (current.status !== "active")
        await teamHub.run((session) =>
          checkExternalConnection(session, current),
        );
    } catch {
      // The scheduled check still runs.
    }
    await reload();
  };
  return { calls, reload, afterSignIn };
}

function appName(app: ExternalApp | undefined, key: string): string {
  return app?.display_name ?? key;
}

/** Why a sign-in did not start, in the words the Human can act on. */
function connectProblem(error: unknown, appKey: string, t: Translate): string {
  if (error instanceof AppUnavailableForAgents)
    return t(m.appUnavailableForAgents);
  if (appKey === FEISHU_MAIL && error instanceof HttpError)
    return t(m.feishuOnComputer);
  if (error instanceof HttpError && error.code === "COMPOSIO_KEY_REJECTED")
    return t(m.composioKeyRejected);
  return t(m.connectionNotStarted);
}

/** How a settled setup card ended, in a few words. */
function setupOutcome(card: Card, t: Translate): string | undefined {
  if (card.status === "pending") return undefined;
  const decision =
    card.status === "answered" ? card.answer?.decision : undefined;
  if (decision === "connected") return t(m.connected);
  if (decision === "skipped") return t(m.skipped);
  if (decision !== "done") return undefined;
  const links = card.answer?.links?.length ?? 0;
  const files = card.answer?.attachment_upload_ids?.length ?? 0;
  const linkCount = t(m.linkCount, { count: links });
  const fileCount = t(m.fileCount, { count: files });
  if (links && files)
    return t(m.sharedLinksAndFiles, { links: linkCount, files: fileCount });
  if (links || files)
    return t(m.sharedItems, { items: links ? linkCount : fileCount });
  return t(m.nothingShared);
}

/** The apps Another Me offers to connect, each with its own Connect. */
export function ProfileSetupApps(props: DecisionViewProps) {
  const { t } = useTranslation();
  const { card, canAnswer, decision } = props;
  const catalog = useExternalApps();
  const connections = useExternalConnections(canAnswer);
  const { calls, afterSignIn } = useConnectionCalls();
  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState<string | undefined>();
  const [keyNeeded, setKeyNeeded] = useState(false);
  const apps = card.profile_setup?.apps ?? [];
  const moreApps = card.profile_setup?.more_apps ?? [];
  const configured = catalog.data?.provider_configured === true;
  const outcome = setupOutcome(card, t);

  const connect = async (app: ExternalApp) => {
    if (!configured) {
      setKeyNeeded(true);
      return;
    }
    setConnecting(app.key);
    decision.setProblem(undefined);
    try {
      const { connection, connectUrl } = await connectLink(
        app.key,
        connections.data ?? [],
        calls,
      );
      if (connectUrl) await openInBrowser(connectUrl);
      await afterSignIn(connection);
    } catch (error) {
      decision.setProblem(connectProblem(error, app.key, t));
    } finally {
      setConnecting(undefined);
    }
  };

  return (
    <>
      <View>
        {[...apps, ...(expanded ? moreApps : [])].map((key) => {
          const app = catalog.data?.apps.find((item) => item.key === key);
          const ofApp = (connections.data ?? []).filter(
            (item) => item.provider === key,
          );
          const active = ofApp.find((item) => item.status === "active");
          const verifying = ofApp.some(
            (item) =>
              item.status === "pending" &&
              item.status_error_code === "provider_identity_unavailable",
          );
          const pending = openPendingConnection(ofApp, key);
          const name = appName(app, key);
          return (
            <View key={key} style={parts.row}>
              <Text style={parts.rowLabel} numberOfLines={1}>
                {name}
              </Text>
              {!canAnswer ? null : active ? (
                <View style={styles.account}>
                  <View style={parts.dot} />
                  <Text style={parts.rowMeta} numberOfLines={1}>
                    {active.identity_label || t(m.connected)}
                  </Text>
                </View>
              ) : verifying ? (
                <Text style={parts.rowMeta}>{t(m.verifyingConnection)}</Text>
              ) : app ? (
                <Button
                  compact
                  variant="secondary"
                  label={t(pending ? m.continueConnecting : m.connect)}
                  accessibilityLabel={t(m.connectApp, { name })}
                  onPress={() => void connect(app)}
                  busy={connecting === key}
                  disabled={
                    !!connecting ||
                    (configured && app.availability !== "available")
                  }
                />
              ) : catalog.isSuccess ? (
                <Text style={parts.rowMeta}>{t(m.notAvailableYet)}</Text>
              ) : null}
            </View>
          );
        })}
        {moreApps.length > 0 && !expanded && card.status === "pending" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setExpanded(true)}
            style={parts.row}
          >
            <Text style={[parts.rowLabel, styles.muted]}>{t(m.more)}</Text>
          </Pressable>
        ) : null}
      </View>
      {canAnswer && keyNeeded && !configured ? (
        <ComposioKeyNeeded
          canSave={catalog.data?.provider_key.can_save !== false}
          onSaved={() => setKeyNeeded(false)}
        />
      ) : null}
      {outcome ? <Text style={type.small}>{outcome}</Text> : null}
      {canAnswer ? (
        <View style={parts.actions}>
          <Button
            label={t(m.replyConnected)}
            onPress={() => void decision.answer({ decision: "connected" })}
            busy={decision.busy}
            disabled={!!connecting}
            style={parts.action}
          />
          <Button
            label={t(m.skipForNow)}
            variant="secondary"
            onPress={() => void decision.answer({ decision: "skipped" })}
            disabled={decision.busy || !!connecting}
            style={parts.action}
          />
        </View>
      ) : null}
    </>
  );
}

/** Connected Apps need the deployment's Composio key before any sign-in. */
function ComposioKeyNeeded(props: {
  readonly canSave: boolean;
  readonly onSaved: () => void;
}) {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const client = useQueryClient();
  return (
    <View style={parts.field}>
      <Text style={type.small}>{t(m.composioKeyNeeded)}</Text>
      {props.canSave ? (
        <SecretField
          label={t(m.composioApiKey)}
          save={async (key) => {
            const refused = await saveComposioKey(teamHub, key, t);
            if (refused) return refused;
            await client.invalidateQueries({
              queryKey: teamHubKey(teamHub.hostId, "external-apps"),
            });
            props.onSaved();
            return undefined;
          }}
        />
      ) : (
        <Text style={type.small}>{t(m.keysCannotBeSaved)}</Text>
      )}
    </View>
  );
}

interface PickedFile {
  readonly localId: string;
  readonly name: string;
  readonly size?: number;
  readonly upload?: MessageAttachmentUpload;
  readonly failed?: boolean;
}

function linkProblemText(problem: LinkProblem, t: Translate): string {
  if (problem === "limit") return t(m.linkLimit, { max: MAX_LINKS });
  return t(problem === "duplicate" ? m.linkAlreadyAdded : m.linkInvalid);
}

/** Links and files the Human shares with Another Me, then That's All. */
export function ProfileSetupSources(props: DecisionViewProps) {
  const { t } = useTranslation();
  const { card, canAnswer, decision, roomId } = props;
  const teamHub = useTeamHub();
  const [links, setLinks] = useState<readonly string[]>([]);
  const [files, setFiles] = useState<readonly PickedFile[]>([]);
  const [draft, setDraft] = useState("");
  const [inputProblem, setInputProblem] = useState<string | undefined>();
  // Files removed while uploading; their upload is released once it lands.
  const removed = useRef(new Set<string>());
  const latestTeamHub = useRef(teamHub);
  useEffect(() => {
    latestTeamHub.current = teamHub;
  }, [teamHub]);
  const uploading = files.some((file) => !file.upload && !file.failed);
  const failed = files.some((file) => file.failed);
  const outcome = setupOutcome(card, t);

  const addLink = () => {
    const link = draft.trim();
    if (!link) return;
    const problem = linkProblem(link, links);
    setInputProblem(problem ? linkProblemText(problem, t) : undefined);
    if (problem) return;
    setLinks((current) => [...current, link]);
    setDraft("");
  };

  const release = (uploadId: string) =>
    void teamHub
      .run((session) => deleteAttachmentUpload(session, roomId, uploadId))
      .catch(() => undefined);

  const upload = async (file: PickedFile, uri: string, mediaType?: string) => {
    try {
      const bytes = await new File(uri).bytes();
      const hostId = teamHub.hostId;
      // Read through the ref so a retry uses the session open now, as the
      // composer does; the same key lets the computer keep one copy.
      const send = () => {
        const current = latestTeamHub.current;
        if (current.hostId !== hostId)
          return Promise.reject(new Error("The computer changed."));
        return current.run((session) =>
          uploadAttachment(
            session,
            roomId,
            { name: file.name, mediaType, bytes },
            file.localId,
          ),
        );
      };
      const result = await sendRetryingOnce(
        send,
        (error) =>
          error instanceof SessionClosed || error instanceof NotConnected,
      );
      if (removed.current.has(file.localId)) {
        release(result.id);
        return;
      }
      setFiles((current) =>
        current.map((item) =>
          item.localId === file.localId ? { ...item, upload: result } : item,
        ),
      );
    } catch {
      setFiles((current) =>
        current.map((item) =>
          item.localId === file.localId ? { ...item, failed: true } : item,
        ),
      );
    }
  };

  const pick = async () => {
    setInputProblem(undefined);
    const picked = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
    }).catch(() => undefined);
    if (!picked || picked.canceled) return;
    const room = MAX_FILES - files.length;
    const assets = picked.assets.slice(0, Math.max(room, 0));
    if (picked.assets.length > room)
      setInputProblem(t(m.fileLimit, { max: MAX_FILES }));
    for (const asset of assets) {
      if (asset.size !== undefined && asset.size > MAX_UPLOAD_BYTES) {
        setInputProblem(t(chatComposerMessages.fileTooLarge));
        continue;
      }
      const file: PickedFile = {
        localId: newIdempotencyKey(),
        name: asset.name,
        size: asset.size,
      };
      setFiles((current) => [...current, file]);
      void upload(file, asset.uri, asset.mimeType);
    }
  };

  const remove = (file: PickedFile) => {
    removed.current.add(file.localId);
    if (file.upload) release(file.upload.id);
    setFiles((current) =>
      current.filter((item) => item.localId !== file.localId),
    );
    setInputProblem(undefined);
  };

  const done = () => {
    const pendingLink = draft.trim();
    const problem = pendingLink ? linkProblem(pendingLink, links) : undefined;
    if (problem) {
      setInputProblem(linkProblemText(problem, t));
      return;
    }
    const shared = pendingLink ? [...links, pendingLink] : links;
    const uploads = files.flatMap((file) =>
      file.upload ? [file.upload.id] : [],
    );
    void decision.answer(
      {
        decision: "done",
        ...(shared.length ? { links: [...shared] } : {}),
        ...(uploads.length ? { attachment_upload_ids: uploads } : {}),
      },
      (error) =>
        error instanceof HttpError &&
        error.code === "ATTACHMENT_UPLOAD_UNAVAILABLE"
          ? t(m.fileNoLongerAvailable)
          : undefined,
    );
  };

  if (!canAnswer) {
    const shared = card.answer?.decision === "done" ? card.answer.links : [];
    return (
      <>
        {(shared ?? []).map((link) => (
          <View key={link} style={parts.row}>
            <Icon name="link" size={16} color={colors.muted} />
            <Text style={parts.rowLabel} numberOfLines={1}>
              {linkLabel(link)}
            </Text>
          </View>
        ))}
        {outcome ? <Text style={type.small}>{outcome}</Text> : null}
      </>
    );
  }

  return (
    <>
      {links.map((link) => (
        <View key={link} style={parts.row}>
          <Icon name="link" size={16} color={colors.muted} />
          <Text style={parts.rowLabel} numberOfLines={1}>
            {linkLabel(link)}
          </Text>
          <RemoveButton
            label={t(m.removeItem, { name: link })}
            onPress={() =>
              setLinks((current) => current.filter((item) => item !== link))
            }
          />
        </View>
      ))}
      {files.map((file) => (
        <View key={file.localId} style={parts.row}>
          <Icon name="file" size={16} color={colors.muted} />
          <Text style={parts.rowLabel} numberOfLines={1}>
            {file.name}
          </Text>
          <Text
            style={[parts.rowMeta, file.failed && parts.problem]}
            numberOfLines={1}
          >
            {file.failed
              ? t(m.uploadFailed)
              : file.upload
                ? t(m.uploadedSize, {
                    size: formatFileSize(file.upload.size_bytes),
                  })
                : t(m.uploading)}
          </Text>
          <RemoveButton
            label={t(m.removeItem, { name: file.name })}
            onPress={() => remove(file)}
          />
        </View>
      ))}
      <View style={styles.linkRow}>
        <TextInput
          style={[parts.input, styles.linkInput]}
          placeholder={t(m.pasteLink)}
          placeholderTextColor={colors.placeholder}
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            setInputProblem(undefined);
          }}
          onSubmitEditing={addLink}
          accessibilityLabel={t(m.pasteLink)}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
        />
        <Button
          compact
          variant="secondary"
          label={t(m.addLink)}
          onPress={addLink}
          disabled={!draft.trim()}
        />
      </View>
      <Button
        variant="secondary"
        label={t(m.uploadFiles)}
        onPress={() => void pick()}
        disabled={files.length >= MAX_FILES}
      />
      <Text style={type.small} accessibilityRole="text">
        {links.length || files.length
          ? t(m.sourcesAddedHint)
          : t(m.sourcesEmptyHint)}
      </Text>
      {inputProblem ? (
        <Text style={[type.small, parts.problem]} accessibilityRole="alert">
          {inputProblem}
        </Text>
      ) : null}
      <View style={parts.actions}>
        <Button
          label={t(m.thatsAll)}
          onPress={done}
          busy={decision.busy}
          disabled={uploading || failed}
          style={parts.action}
        />
        <Button
          label={t(m.skip)}
          variant="secondary"
          onPress={() => void decision.answer({ decision: "skipped" })}
          disabled={decision.busy}
          style={parts.action}
        />
      </View>
    </>
  );
}

function RemoveButton(props: {
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      hitSlop={10}
    >
      <Icon name="close" size={14} color={colors.muted} />
    </Pressable>
  );
}

/** The account picker's choice for a new account; never a Connection ID. */
const NEW_ACCOUNT = "new-account";

/**
 * A connection authorization: the Human picks or connects an account of the
 * app the Agent needs. Approving records their consent to that Connection
 * before the sign-in opens; TeamHub settles the card once it is active.
 */
export function ConnectionAuth(props: DecisionViewProps) {
  const { t } = useTranslation();
  const { card, canAnswer, decision } = props;
  const view = card.connection_auth;
  const appKey = view?.app_key ?? "";
  const authorizing = card.status === "authorizing";
  const catalog = useExternalApps();
  const connections = useExternalConnections(canAnswer && !authorizing);
  const { calls, reload, afterSignIn } = useConnectionCalls();
  const [choice, setChoice] = useState<string | undefined>();
  const [started, setStarted] = useState<ExternalConnection | undefined>();
  const [working, setWorking] = useState(false);
  const app = catalog.data?.apps.find((item) => item.key === appKey);
  const name = appName(app, appKey);
  const choices = accountChoices(connections.data ?? [], appKey, started);
  const canConnectNew = canConnectNewAccount(app);
  const fallback = defaultAccount(choices, view?.account, canConnectNew);
  const selected =
    choice === NEW_ACCOUNT
      ? undefined
      : (choices.find((item) => item.id === choice) ?? fallback);
  const loading = !authorizing && (connections.isPending || catalog.isPending);
  const busy = working || decision.busy;
  const showPicker =
    canAnswer &&
    !authorizing &&
    choices.length > 0 &&
    (canConnectNew || choices.length > 1);

  const approve = async () => {
    setWorking(true);
    decision.setProblem(undefined);
    try {
      const prepared = await prepareAuthorization({
        app,
        chosen: selected,
        connections: connections.data ?? [],
        calls,
      });
      if (prepared.started) {
        setStarted(prepared.connection);
        setChoice(prepared.connection.id);
      }
      const approved = await decision.answer({
        decision: "approve",
        connection_id: prepared.connection.id,
      });
      if (approved && prepared.connectUrl) {
        await openInBrowser(prepared.connectUrl);
        await afterSignIn(prepared.connection);
      }
    } catch (error) {
      decision.setProblem(
        error instanceof AppUnavailableForAgents ||
          (appKey === FEISHU_MAIL && error instanceof HttpError)
          ? connectProblem(error, appKey, t)
          : t(m.authorizationNotStarted),
      );
    } finally {
      await reload();
      setWorking(false);
    }
  };

  // While authorizing, the bound Connection's sign-in can be opened again.
  const reopen = async () => {
    const id = view?.connection_id;
    if (!id) return;
    setWorking(true);
    decision.setProblem(undefined);
    try {
      const bound = await calls.get(id);
      const url = reauthorizationConnectUrl(bound) ?? usableConnectUrl(bound);
      if (!url) {
        decision.setProblem(t(m.authorizationNotStarted));
        return;
      }
      await openInBrowser(url);
      await afterSignIn(bound);
    } catch {
      decision.setProblem(t(m.authorizationNotStarted));
    } finally {
      setWorking(false);
    }
  };

  const deny = (reason: string | undefined) =>
    void decision.answer({
      decision: "deny",
      ...(reason ? { comment: reason } : {}),
    });

  const approveLabel = selected
    ? t(selected.status === "active" ? m.allow : m.connect)
    : t(m.connect);
  const canApprove = !!selected || loading || canConnectNew;

  return (
    <>
      <Text style={type.label}>{name}</Text>
      {view?.account ? (
        <Text style={type.small}>
          {t(m.requestedAccount, { account: view.account })}
        </Text>
      ) : null}
      {authorizing ? <Text style={type.small}>{t(m.authorizing)}</Text> : null}
      {showPicker ? (
        <View accessibilityLabel={t(m.appAccount, { app: name })}>
          {choices.map((connection) => {
            const account = connection.identity_label || name;
            return (
              <AccountOption
                key={connection.id}
                label={
                  connection.status === "active"
                    ? account
                    : connection.status === "pending"
                      ? t(m.accountPending, { account })
                      : t(m.accountNeedsReconnecting, { account })
                }
                selected={selected?.id === connection.id}
                disabled={busy}
                onPress={() => setChoice(connection.id)}
              />
            );
          })}
          {canConnectNew ? (
            <AccountOption
              label={t(m.connectNewAccount)}
              selected={!selected}
              disabled={busy}
              onPress={() => setChoice(NEW_ACCOUNT)}
            />
          ) : null}
        </View>
      ) : null}
      {connections.isError || catalog.isError ? (
        <Text style={[type.small, parts.problem]}>
          {t(m.accountsNotLoaded)}
        </Text>
      ) : null}
      {canAnswer && authorizing ? (
        <View style={parts.actions}>
          {view?.connection_id ? (
            <Button
              label={t(m.open)}
              onPress={() => void reopen()}
              busy={working}
              style={parts.action}
            />
          ) : null}
          <Button
            label={t(m.notNow)}
            variant="secondary"
            onPress={() => deny(undefined)}
            disabled={busy}
            style={parts.action}
          />
        </View>
      ) : null}
      {canAnswer && !authorizing && canApprove ? (
        <ApprovalActions
          approveLabel={approveLabel}
          approveAccessibilityLabel={
            selected?.status === "active"
              ? t(m.allowAgent, { name: card.requester.display_name })
              : t(m.connectApp, { name })
          }
          approveDisabled={loading}
          denyLabel={t(m.notNow)}
          busy={busy}
          onApprove={() => void approve()}
          onDeny={deny}
        />
      ) : null}
      {canAnswer && !authorizing && !canApprove ? (
        <Button
          label={t(m.notNow)}
          variant="secondary"
          onPress={() => deny(undefined)}
          disabled={busy}
        />
      ) : null}
    </>
  );
}

function AccountOption(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.option, props.selected && styles.optionSelected]}
    >
      <View style={[styles.mark, props.selected && styles.markOn]} />
      <Text style={[type.body, styles.optionLabel]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  account: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  muted: { color: colors.muted },
  linkRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  linkInput: { flex: 1 },
  option: {
    minHeight: touchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    marginBottom: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  optionLabel: { flex: 1 },
  mark: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  markOn: { borderColor: colors.accent, backgroundColor: colors.accent },
});
