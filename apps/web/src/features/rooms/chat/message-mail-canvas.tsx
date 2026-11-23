import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowExpand01Icon,
  Cancel01Icon,
  HelpCircleIcon,
  Loading03Icon,
  Mail01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { AutoHeight } from "@/components/ui/auto-height";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { useWikiDocumentLinks } from "@/features/wiki/wiki-document-links";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";
import { CardActions, CardRowDetails } from "../cards/approval-card-parts";
import { CardBox, CardDone } from "../cards/card-shell";
import {
  progressText,
  useMailCanvasSend,
} from "../documents/canvas/canvas-mail-send";
import "../documents/room-document-blocknote.css";
import { UnifiedDocumentBody } from "../documents/unified-document-body";
import { useUnifiedDocumentPageModel } from "../documents/use-unified-document-page-model";
import { chatMessages } from "./chat.messages";

const iconButton =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-app-muted transition-colors duration-150 hover:bg-accent hover:text-app-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus motion-reduce:transition-none";

/**
 * A gmail canvas in the timeline is the email itself, laid out like an
 * approval card: subject, recipients, Send. Expanded it is the same editor
 * as the side panel; anything that is not a gmail canvas renders `fallback`.
 */
export function MessageMailCanvas({
  documentId,
  fallback,
  onOpen,
  tenantId,
}: {
  documentId: string;
  fallback: ReactNode;
  onOpen: () => void;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const [open, setOpen] = useState(false);
  // The editor stays mounted once opened, so its unsaved edits count even
  // while the card is collapsed again.
  const [editorSaved, setEditorSaved] = useState(true);
  const mail = useMailCanvasSend(client, documentId, editorSaved);
  const { refresh } = mail;
  const editorId = useId();
  const t = useT();
  if (!mail.mail) return fallback;
  const { subject, to } = mail.mail;
  return (
    <CardBox label={t(chatMessages.email)}>
      <h3 className="-mx-2 flex min-h-9 w-[calc(100%+1rem)] items-center gap-1 rounded-lg pr-1 transition-colors duration-150 hover:bg-accent motion-reduce:transition-none">
        <button
          aria-controls={editorId}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <Icon
            className="shrink-0 text-app-muted"
            icon={Mail01Icon}
            size={16}
          />
          <span className="min-w-0 flex-1 text-sm font-semibold text-app-ink [overflow-wrap:anywhere]">
            {subject.trim() || t(chatMessages.emailNoSubject)}
          </span>
        </button>
        <button
          aria-label={t(chatMessages.openInSidePanel)}
          className={iconButton}
          onClick={onOpen}
          title={t(chatMessages.openInSidePanel)}
          type="button"
        >
          <Icon icon={ArrowExpand01Icon} size={14} />
        </button>
        <button
          aria-controls={editorId}
          aria-expanded={open}
          aria-label={
            open ? t(chatMessages.collapseEmail) : t(chatMessages.expandEmail)
          }
          className={iconButton}
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <Icon
            className={cn(
              "transition-transform duration-(--chat-resize-duration) ease-(--app-out-quint) motion-reduce:transition-none",
              open && "rotate-180",
            )}
            icon={ArrowDown01Icon}
            size={14}
          />
        </button>
      </h3>
      <AutoHeight open={!open}>
        <p className="pt-1 text-sm text-app-muted [overflow-wrap:anywhere]">
          {to
            ? t(chatMessages.emailTo, { recipients: to })
            : t(chatMessages.emailNoRecipients)}
        </p>
      </AutoHeight>
      <div id={editorId}>
        <CardRowDetails open={open}>
          <MailCanvasEditor
            documentId={documentId}
            onSaved={refresh}
            onSavedChange={setEditorSaved}
            tenantId={tenantId}
          />
        </CardRowDetails>
      </div>
      <MailCardFooter mail={mail} />
    </CardBox>
  );
}

/** Opens the collaborative session only while the card is expanded. */
function MailCanvasEditor({
  documentId,
  onSaved,
  onSavedChange,
  tenantId,
}: {
  documentId: string;
  onSaved: () => void;
  onSavedChange: (saved: boolean) => void;
  tenantId: string;
}) {
  const model = useUnifiedDocumentPageModel({ documentId, tenantId });
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wikiLinks = useWikiDocumentLinks(model.client, undefined, contentRef);
  return (
    <div className="-mx-1">
      {model.session ? (
        <SaveStateProbe
          onSaved={onSaved}
          onSavedChange={onSavedChange}
          session={model.session}
        />
      ) : null}
      <div className="room-document-main flex max-h-[520px] min-h-0 flex-col [&_.room-document-content-lane]:px-1 [&_.room-document-layout]:pb-2">
        <UnifiedDocumentBody
          documentContentRef={contentRef}
          isWikiPage={false}
          knowledgeTitle={undefined}
          model={model}
          wikiLinks={wikiLinks}
        />
      </div>
    </div>
  );
}

/**
 * Reports whether the editor has unsaved edits, and asks for the email's new
 * digest each time a change becomes durable, so Send pins what is shown.
 */
function SaveStateProbe({
  onSaved,
  onSavedChange,
  session,
}: {
  onSaved: () => void;
  onSavedChange: (saved: boolean) => void;
  session: NonNullable<
    ReturnType<typeof useUnifiedDocumentPageModel>["session"]
  >;
}) {
  const save = useSyncExternalStore(
    session.subscribeSaveState,
    session.getSaveSnapshot,
    session.getSaveSnapshot,
  );
  const saved = save.status === "Saved" && save.protocolError === undefined;
  useEffect(() => {
    onSavedChange(saved);
  }, [onSavedChange, saved]);
  const sequence = save.durableSequence;
  useEffect(() => {
    if (saved && sequence !== undefined) onSaved();
  }, [onSaved, saved, sequence]);
  return null;
}

/**
 * The same receipts and buttons as an approval card for an email: one line
 * once it is decided, Send and Don't send while it waits. An unknown result
 * keeps both, so the Human can act after checking Gmail.
 */
function MailCardFooter({
  mail,
}: {
  mail: ReturnType<typeof useMailCanvasSend>;
}) {
  const t = useT();
  const { status } = mail;
  const error = mail.mail?.error;
  if (status === "sent")
    return (
      <CardDone
        icon={Tick02Icon}
        text={t(chatMessages.emailSent)}
        tone="success"
      />
    );
  if (status === "declined")
    return (
      <CardDone
        icon={Cancel01Icon}
        text={t(chatMessages.notSent)}
        tone="muted"
      />
    );
  if (mail.busy)
    return (
      <CardDone
        icon={Loading03Icon}
        text={
          progressText(status ?? "queued", mail.app, t) ??
          t(chatMessages.emailSending)
        }
        tone="muted"
      />
    );
  const receipt =
    status === "unknown" ? (
      <CardDone
        icon={HelpCircleIcon}
        text={
          error
            ? t(chatMessages.emailResultUnknownWithError, { error })
            : t(chatMessages.emailResultUnknown)
        }
        tone="warning"
      />
    ) : status === "failed" ? (
      <CardDone
        icon={AlertCircleIcon}
        text={
          error
            ? t(chatMessages.emailFailedWithError, { error })
            : t(chatMessages.emailFailed)
        }
        tone="danger"
      />
    ) : null;
  // Only someone who may change the email decides it.
  if (!mail.canEdit) return receipt;
  return (
    <>
      {receipt}
      <CardActions>
        <div
          aria-label={t(chatMessages.approvalActions)}
          className="flex gap-2"
          role="group"
        >
          <Button
            data-voice-risk="never"
            disabled={!mail.canSend || mail.declining}
            onClick={mail.send}
            size="large"
            tone="primary"
          >
            {status === "unknown"
              ? t(chatMessages.emailSendAgain)
              : t(chatMessages.emailSend)}
          </Button>
          <Button
            data-voice-risk="never"
            disabled={mail.declining}
            onClick={mail.decline}
            size="large"
            tone="ghost"
          >
            {t(chatMessages.emailDontSend)}
          </Button>
        </div>
        {mail.accounts.length > 1 && mail.account ? (
          <Select
            aria-label={t(chatMessages.emailSendFrom)}
            onValueChange={mail.choose}
            value={mail.account.id}
            variant="pill"
          >
            {mail.accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.identity_label ||
                  t(chatMessages.mailAccount, { app: mail.app })}
              </SelectItem>
            ))}
          </Select>
        ) : null}
        {mail.note ? (
          <span className="text-xs text-app-muted" role="status">
            {mail.note}
          </span>
        ) : null}
      </CardActions>
      {mail.problem && status !== "failed" ? (
        <p className="pb-1.5 text-xs text-app-danger" role="alert">
          {mail.problem}
        </p>
      ) : null}
    </>
  );
}
