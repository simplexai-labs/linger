// Edits to the cached message pages. Pages are newest first; inside a page
// messages run oldest to newest, as TeamHub returns them.
import type { InfiniteData } from "@tanstack/react-query";

import type { Message, MessagePage } from "../api/types";

export type MessagePages = InfiniteData<MessagePage, string | undefined>;

/** The phone never shows Runtime plumbing messages, as Web does not. */
export function visible(message: Message): boolean {
  return message.message_kind !== "agent_runtime";
}

export function findMessage(
  data: MessagePages | undefined,
  id: string,
): Message | undefined {
  for (const page of data?.pages ?? []) {
    const found = page.items.find((message) => message.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Appends a message to the newest page unless it is already cached. */
export function insertMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  if (!data || !visible(message) || findMessage(data, message.id)) return data;
  const [newest, ...rest] = data.pages;
  if (!newest) return data;
  return {
    ...data,
    pages: [{ ...newest, items: [...newest.items, message] }, ...rest],
  };
}

export function replaceMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      // Reads finish out of order: an older card never replaces a newer one.
      items: page.items.map((item) =>
        item.id === message.id &&
        !(item.card && message.card && item.card.version > message.card.version)
          ? message
          : item,
      ),
    })),
  };
}

/** Newest first, for an inverted list. */
export function newestFirst(data: MessagePages | undefined): Message[] {
  const out: Message[] = [];
  for (const page of data?.pages ?? []) {
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      const message = page.items[index];
      if (message && visible(message)) out.push(message);
    }
  }
  return out;
}
