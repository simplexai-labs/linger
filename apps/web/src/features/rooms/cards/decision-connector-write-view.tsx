import DOMPurify from "dompurify";
import {
  ArrowDown01Icon,
  Attachment01Icon,
  Mail01Icon,
} from "@hugeicons/core-free-icons";
import { Fragment, useId, useMemo, useState } from "react";

import { AutoHeight } from "@/components/ui/auto-height";
import { Icon } from "@/components/ui/icon";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { MessageMarkdown } from "../chat/message-markdown";
import { CardRowDetails, FullCallBlock } from "./approval-card-parts";
import { cardsMessages } from "./cards.messages";
import type { DecisionMessageCard } from "./decision-card";
import { SlackMrkdwn } from "./slack-mrkdwn";

type ConnectorWriteView = NonNullable<DecisionMessageCard["connector_write"]>;
type ConnectorWriteMessage = NonNullable<ConnectorWriteView["message"]>;
type ConnectorWriteField = NonNullable<ConnectorWriteView["fields"]>[number];

/** Email headers replace the compact recipient line when the preview opens. */
export function EmailDecisionView({
  account,
  message,
}: {
  account: string;
  message: ConnectorWriteMessage;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const previewId = useId();
  return (
    <>
      <h3>
        <button
          aria-controls={previewId}
          aria-expanded={open}
          className="-mx-2 flex min-h-9 w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus motion-reduce:transition-none"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <Icon
            className="shrink-0 text-app-muted"
            icon={Mail01Icon}
            size={16}
          />
          <span className="min-w-0 flex-1 text-sm font-semibold text-app-ink [overflow-wrap:anywhere]">
            {message.subject?.trim() || t(cardsMessages.noSubject)}
          </span>
          <Icon
            className={cn(
              "shrink-0 text-app-muted transition-transform duration-(--chat-resize-duration) ease-(--app-out-quint) motion-reduce:transition-none",
              open && "rotate-180",
            )}
            icon={ArrowDown01Icon}
            size={14}
          />
        </button>
      </h3>
      {message.to?.length ? (
        <AutoHeight open={!open}>
          <p className="pt-1 text-sm text-app-muted [overflow-wrap:anywhere]">
            {t(cardsMessages.emailToLine, {
              recipients: message.to.map(displayEmailAddress).join(", "),
            })}
          </p>
        </AutoHeight>
      ) : null}
      <div id={previewId}>
        <CardRowDetails open={open}>
          <MessagePreview emailFrom={account} message={message} />
        </CardRowDetails>
      </div>
    </>
  );
}

function displayEmailAddress(address: string) {
  return address.trim().replace(/^<([^<>]+)>$/, "$1");
}

/**
 * The full view of one connected app write that TeamHub holds: the message or
 * changed fields for a tool with its own layout, and otherwise the full call,
 * which is then all there is to see. The app and account it acts as read in
 * the card's summary row.
 */
export function ConnectorWriteDecisionView({
  view,
}: {
  view: ConnectorWriteView;
}) {
  const fields = view.fields?.length ? view.fields : undefined;
  return (
    <>
      {view.message ? <MessagePreview message={view.message} /> : null}
      {fields ? <ChangeFields fields={fields} /> : null}
      {!view.message && !fields ? (
        <FullCallBlock input={view.input} tool={view.tool} />
      ) : null}
    </>
  );
}

/** The message exactly as it will be sent: headers, body, attachments. */
function MessagePreview({
  emailFrom,
  message,
}: {
  emailFrom?: string;
  message: ConnectorWriteMessage;
}) {
  const t = useT();
  const email = emailFrom !== undefined;
  function recipients(addresses?: string[]) {
    return (email ? addresses?.map(displayEmailAddress) : addresses)?.join(
      ", ",
    );
  }
  const rows: [Message<string>, string | undefined][] = [
    [
      cardsMessages.emailFrom,
      emailFrom === undefined ? undefined : displayEmailAddress(emailFrom),
    ],
    [cardsMessages.emailTo, recipients(message.to)],
    [
      cardsMessages.emailCc,
      recipients(message.cc) || (email ? t(cardsMessages.none) : undefined),
    ],
    [cardsMessages.emailBcc, recipients(message.bcc)],
    [cardsMessages.emailSubject, email ? undefined : message.subject],
    [cardsMessages.messageWhere, message.destination],
  ];
  const shown = rows.filter((row): row is [Message<string>, string] =>
    Boolean(row[1]),
  );
  return (
    <section
      aria-label={t(cardsMessages.messagePreview)}
      className={cn(
        email
          ? "mt-2"
          : "overflow-hidden rounded-lg border border-app-border bg-app-surface",
      )}
    >
      {shown.length ? (
        <dl
          className={cn(
            email
              ? "text-sm"
              : "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 py-2 text-xs leading-5",
          )}
        >
          {shown.map(([label, value]) => (
            <div
              className={
                email
                  ? "grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 py-3"
                  : "contents"
              }
              key={label.id}
            >
              <dt className="text-app-muted">{t(label)}</dt>
              <dd
                className={`[overflow-wrap:anywhere] text-app-ink ${label === cardsMessages.emailSubject ? "font-semibold" : ""}`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {message.body.trim() ? (
        <MessageBody
          body={message.body}
          expanded={email}
          format={message.format}
        />
      ) : (
        <p className="px-3 py-2.5 text-xs text-app-muted">
          {t(cardsMessages.noMessageText)}
        </p>
      )}
      {message.attachments?.length ? (
        <ul
          aria-label={t(cardsMessages.attachments)}
          className="flex flex-wrap gap-1.5 px-3 py-2"
        >
          {message.attachments.map((name, index) => (
            <li
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-app-border bg-app-surface-soft px-2 py-0.5 text-xs text-app-body"
              key={`${index}:${name}`}
            >
              <Icon
                className="shrink-0 text-app-muted"
                icon={Attachment01Icon}
                size={12}
              />
              <span className="truncate">{name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function MessageBody({
  body,
  expanded = false,
  format,
}: {
  body: string;
  expanded?: boolean;
  format: ConnectorWriteMessage["format"];
}) {
  if (format === "html")
    return <HtmlMessageBody expanded={expanded} html={body} />;
  return (
    <div
      className={expanded ? "py-4" : "max-h-80 overflow-auto px-3 py-2.5"}
      data-testid="message-body"
    >
      {format === "markdown" ? (
        <MessageMarkdown authorKind="agent" body={body} readOnlyReferences />
      ) : format === "mrkdwn" ? (
        <SlackMrkdwn text={body} />
      ) : (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-app-ink">
          {body}
        </p>
      )}
    </div>
  );
}

const htmlBodyMinHeight = 48;
const htmlBodyMaxHeight = 320;

/**
 * An HTML email in its own sandboxed document, so its styles stay inside the
 * preview. Nothing in it runs or loads: DOMPurify strips scripts, the
 * sandbox has no allow-scripts, and the policy blocks remote resources. The
 * frame grows with an expanded email; compact message previews cap its height.
 */
function HtmlMessageBody({
  expanded,
  html,
}: {
  expanded: boolean;
  html: string;
}) {
  const t = useT();
  const [height, setHeight] = useState(120);
  const source = useMemo(
    () => htmlEmailDocument(html, expanded),
    [html, expanded],
  );
  return (
    <iframe
      className="block w-full border-0 bg-white"
      onLoad={(event) => {
        const root = event.currentTarget.contentDocument?.documentElement;
        if (!root) return;
        setHeight(
          Math.min(
            Math.max(root.scrollHeight, htmlBodyMinHeight),
            expanded ? Infinity : htmlBodyMaxHeight,
          ),
        );
      }}
      // Same origin only lets the card measure the email; without
      // allow-scripts nothing inside can use it. Links open a new tab.
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      srcDoc={source}
      style={{ height }}
      title={t(cardsMessages.messageBody)}
    />
  );
}

function htmlEmailDocument(html: string, expanded: boolean) {
  const root = DOMPurify.sanitize(html, {
    RETURN_DOM: true,
    WHOLE_DOCUMENT: true,
  }) as HTMLElement;
  const owner = root.ownerDocument;
  let head = root.querySelector("head");
  if (!head) {
    head = owner.createElement("head");
    root.prepend(head);
  }
  const policy = owner.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
  const charset = owner.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  // The email's own styles come later and win.
  const base = owner.createElement("style");
  base.textContent = `html{color-scheme:light}body{margin:0;padding:${expanded ? "16px 0" : "10px 12px"};background:#fff;color:#202020;font:14px/1.5 Inter,system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}`;
  head.prepend(charset, policy, base);
  for (const link of root.querySelectorAll("a[href]")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  return `<!doctype html>${root.outerHTML}`;
}

/** A change's target and key values; multi-line values keep their lines. */
function ChangeFields({ fields }: { fields: ConnectorWriteField[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs leading-5">
      {fields.map((field, index) => (
        <Fragment key={`${index}:${field.label}`}>
          <dt className="text-app-muted">{field.label}</dt>
          <dd className="min-w-0 text-app-ink">
            {field.value.includes("\n") ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-app-surface-soft px-2 py-1.5 font-mono [overflow-wrap:anywhere]">
                {field.value}
              </pre>
            ) : (
              <span className="[overflow-wrap:anywhere]">{field.value}</span>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
