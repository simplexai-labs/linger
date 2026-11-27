import { Fragment } from "react";
import { Link } from "react-router";

import { useTranslation } from "@/i18n/use-translation";

import {
  cardNoticeLines,
  type CardNotice,
  type NoticeTarget,
} from "../cards/card-notice";

const pillClass =
  "inline-block max-w-full rounded-xl bg-muted px-3 py-1 text-center text-xs leading-[18px] text-muted-foreground [overflow-wrap:anywhere]";

/**
 * A settled card as one centered system line, like a Room notice. Once
 * decided it is only a record; the object in the line links to where the
 * result lives.
 */
export function CardNoticeRows({
  notice,
  tenantId,
}: {
  notice: CardNotice;
  tenantId: string;
}) {
  const translation = useTranslation();
  return (
    <div
      className="room-notice-row flex flex-col items-center gap-1.5 py-1 [text-autospace:normal]"
      data-message-kind="card_notice"
      role="note"
    >
      {cardNoticeLines(notice, translation).map((line, lineIndex) => (
        <span className={pillClass} key={lineIndex}>
          {line.parts.map((part, partIndex) =>
            part.tag === "link" && line.link ? (
              <Link
                className="font-medium text-app-ink underline-offset-2 hover:underline"
                key={partIndex}
                to={targetPath(tenantId, line.link)}
              >
                {part.text}
              </Link>
            ) : (
              <Fragment key={partIndex}>{part.text}</Fragment>
            ),
          )}
        </span>
      ))}
    </div>
  );
}

function targetPath(tenantId: string, to: NoticeTarget) {
  const tenant = `/t/${encodeURIComponent(tenantId)}`;
  return to === "apps"
    ? `${tenant}/apps`
    : `${tenant}/rooms/${encodeURIComponent(to.room)}/chat`;
}
