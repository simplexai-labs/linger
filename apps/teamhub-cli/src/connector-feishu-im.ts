import type {
  CommandArguments,
  CommandDefinition,
  CommandInputReader,
} from "./command-definition.js";
import {
  assertPositionals,
  bodySource,
  oneOf,
  option,
} from "./command-input.js";
import { number, schema, stringSchema, text } from "./connector-input.js";
import {
  connectorDefinition,
  optionalFields,
  record,
  requiredString,
  value,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import { CliError } from "./errors.js";
import { array, id, object, rootSchema, str } from "./connector-schemas.js";

/**
 * TeamHub runs Feishu IM's tools itself, without Composio, through the owner's
 * own lark-cli on their Computer, and they return chats and messages already in
 * the CLI's shape. Sending is one write, so TeamHub can hold it for the
 * sponsor's confirmation card.
 */
export const FEISHU_IM_TOOLS = {
  chats: "FEISHU_IM_LIST_CHATS",
  messages: "FEISHU_IM_LIST_MESSAGES",
  get: "FEISHU_IM_GET_MESSAGE",
  send: "FEISHU_IM_SEND_MESSAGE",
  reply: "FEISHU_IM_REPLY_MESSAGE",
} as const;
const T = FEISHU_IM_TOOLS;

const actions = ["chats", "messages", "get", "send", "reply"] as const;
type Action = (typeof actions)[number];

const descriptions: Record<Action, string> = {
  chats: "List the Feishu chats the owner can read.",
  messages: "List one chat's messages, newest first.",
  get: "Read one message without changing its read state.",
  send: "Send a text message to a chat or directly to a user.",
  reply: "Reply to a message in its own chat.",
};

const pageOptions = {
  "--limit": value("1–50 items per page; default 20."),
  "--cursor": value("Page token from the previous page's next_cursor."),
};
const bodyOptions = {
  "--content": value("Message text; exclusive with --file."),
  "--file": value("UTF-8 text file; - reads stdin."),
};
const targetOptions = {
  "--chat": value("Chat ID to send into."),
  "--user": value("User open_id to send to directly."),
  "--user-id": value("User ID to send to directly; skip the open_id."),
};
const options: Record<Action, Json> = {
  chats: pageOptions,
  messages: pageOptions,
  get: {},
  send: { ...targetOptions, ...bodyOptions },
  reply: bodyOptions,
};

function usageLines(action: Action): string[] {
  const prefix = `teamhub feishu-im ${action}`;
  switch (action) {
    case "messages":
      return [`${prefix} <chat-id> [flags]`];
    case "get":
      return [`${prefix} <message-id> [flags]`];
    case "send":
      return [
        `${prefix} (--chat <chat-id> | --user <open-id> | --user-id <user-id>) (--content <text> | --file <path|->) [flags]`,
      ];
    case "reply":
      return [
        `${prefix} <message-id> (--content <text> | --file <path|->) [flags]`,
      ];
    default:
      return [`${prefix} [flags]`];
  }
}

function examples(action: Action): string[] {
  switch (action) {
    case "messages":
      return ["teamhub feishu-im messages oc_0123456789abcdef"];
    case "get":
      return ["teamhub feishu-im get om_0123456789abcdef"];
    case "send":
      return [
        "teamhub feishu-im send --chat oc_0123456789abcdef --content 'Shipped the release.'",
        "teamhub feishu-im send --user ou_0123456789abcdef --file ./notice.txt",
      ];
    case "reply":
      return [
        "teamhub feishu-im reply om_0123456789abcdef --content 'Thanks.'",
      ];
    default:
      return ["teamhub feishu-im chats --limit 50"];
  }
}

const chatSchema = object(
  {
    chatId: id,
    name: str,
    description: str,
    ownerId: str,
    chatMode: str,
    chatType: str,
  },
  ["chatId"],
);
const messageSchema = object(
  {
    messageId: id,
    chatId: str,
    threadId: str,
    senderId: str,
    senderType: str,
    msgType: str,
    text: str,
    createdAt: str,
  },
  ["messageId"],
);
const writeSchema = object(
  {
    action: { const: "sent" },
    acknowledged: { const: true },
    messageId: id,
  },
  ["action", "acknowledged"],
);

function outputSchema(action: Action): Json {
  switch (action) {
    case "chats":
      return rootSchema(
        { chats: array(chatSchema), next_cursor: stringSchema },
        ["chats"],
      );
    case "messages":
      return rootSchema(
        {
          chatId: id,
          messages: array(messageSchema),
          next_cursor: stringSchema,
        },
        ["chatId", "messages"],
      );
    case "get":
      return rootSchema({ message: messageSchema });
    default:
      return rootSchema({ result: writeSchema });
  }
}

function inputSchema(action: Action): Json {
  switch (action) {
    case "chats":
    case "messages":
      return schema(
        {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          cursor: stringSchema,
          ...(action === "messages" ? { chatId: stringSchema } : {}),
        },
        action === "messages" ? ["chatId"] : [],
      );
    case "get":
      return schema({ messageId: stringSchema }, ["messageId"]);
    case "send":
      return schema({
        content: { type: "string", minLength: 1, maxLength: 4096 },
        chatId: stringSchema,
        openId: stringSchema,
        userId: stringSchema,
      });
    default:
      return schema(
        {
          messageId: stringSchema,
          content: { type: "string", minLength: 1, maxLength: 4096 },
        },
        ["messageId", "content"],
      );
  }
}

export const feishuImCommandDefinitions: CommandDefinition[] = actions.map(
  (action) =>
    connectorDefinition({
      command: ["feishu-im", action],
      description: descriptions[action],
      readOnly: action !== "send" && action !== "reply",
      options: options[action] as CommandDefinition["options"],
      usage: usageLines(action),
      examples: examples(action),
      notes: [
        "Feishu IM is the owner's own Feishu or Lark chats through lark-cli on their Computer; TeamHub checks the login and its scopes at execution time.",
        ...(action === "send" || action === "reply"
          ? [
              "The message is sent as plain Feishu text; Feishu renders no Markdown in it.",
            ]
          : []),
      ],
      inputSchema: inputSchema(action),
      outputSchema: outputSchema(action),
      normalize: async (args, reader) =>
        normalizeFeishuIm(action, args, reader),
      bindings: () => feishuImBindings(action),
      execute: (input, runtime) => executeFeishuIm(action, input, runtime),
    }),
);

export function feishuImBindings(action: string): string[] {
  switch (action) {
    case "chats":
      return [T.chats];
    case "messages":
      return [T.messages];
    case "send":
      return [T.send];
    case "reply":
      return [T.reply];
    default:
      return [T.get];
  }
}

async function normalizeFeishuIm(
  action: Action,
  args: CommandArguments,
  reader: CommandInputReader,
): Promise<{ input: Json }> {
  const input: Json = {};
  if (action === "chats") {
    assertPositionals(args, 0);
    input.limit = number(option(args, "--limit"), "--limit", 1, 50, 20);
    const cursor = option(args, "--cursor");
    if (cursor !== undefined) input.cursor = text(cursor, "--cursor");
  } else if (action === "messages") {
    assertPositionals(args, 1);
    input.chatId = text(args.positionals[0], "chat ID");
    input.limit = number(option(args, "--limit"), "--limit", 1, 50, 20);
    const cursor = option(args, "--cursor");
    if (cursor !== undefined) input.cursor = text(cursor, "--cursor");
  } else if (action === "get") {
    assertPositionals(args, 1);
    input.messageId = text(args.positionals[0], "message ID");
  } else {
    if (action === "reply") {
      assertPositionals(args, 1);
      input.messageId = text(args.positionals[0], "message ID");
    } else {
      assertPositionals(args, 0);
      const target = oneOf(args, ["--chat", "--user", "--user-id"]);
      if (target === "--chat")
        input.chatId = text(option(args, "--chat"), "--chat");
      else if (target === "--user")
        input.openId = text(option(args, "--user"), "--user");
      else if (target === "--user-id")
        input.userId = text(option(args, "--user-id"), "--user-id");
    }
    const content = await bodySource(args, reader);
    if (
      content === undefined ||
      !content.trim() ||
      [...content].length > 4096 ||
      content.includes("\u0000")
    )
      throw new CliError(
        "invalid_input",
        "The message must be nonblank UTF-8 text of at most 4,096 characters.",
      );
    input.content = content;
  }
  return { input };
}

export async function executeFeishuIm(
  action: string,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  switch (action) {
    case "chats":
      return listFeishuImChats(input, runtime);
    case "messages":
      return listFeishuImMessages(input, runtime);
    case "get":
      return readFeishuImMessage(input, runtime);
    default:
      return sendFeishuIm(action, input, runtime);
  }
}

async function listFeishuImChats(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const raw = await runtime.call(
    T.chats,
    optionalFields({ page_size: input.limit, page_token: input.cursor }),
  );
  return pageResult(
    { chats: pageRows(raw, "chats", "chat list").map(feishuImChat) },
    raw,
  );
}

async function listFeishuImMessages(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const raw = await runtime.call(
    T.messages,
    optionalFields({
      chat_id: input.chatId,
      page_size: input.limit,
      page_token: input.cursor,
    }),
  );
  return pageResult(
    {
      chatId: requiredString(input.chatId, "chat ID"),
      messages: pageRows(raw, "messages", "message list").map(feishuImMessage),
    },
    raw,
  );
}

/** Adds the next page's cursor a list result carries, so a caller can page on. */
function pageResult(result: Json, raw: Json): Json {
  const token = optionalFields({
    next_cursor: field(raw, "next_cursor", "next_page_token"),
  }).next_cursor;
  return token === undefined ? result : { ...result, next_cursor: token };
}

async function readFeishuImMessage(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const raw = await runtime.call(T.get, { message_id: input.messageId });
  return { message: feishuImMessage(raw.message ?? raw) };
}

/** Sends a new message, or a reply in the message's own chat. */
async function sendFeishuIm(
  action: string,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const raw = await runtime.call(
    action === "reply" ? T.reply : T.send,
    optionalFields({
      message_id: input.messageId,
      receive_id: input.chatId ?? input.openId ?? input.userId,
      receive_id_type:
        input.chatId !== undefined
          ? "chat_id"
          : input.openId !== undefined
            ? "open_id"
            : input.userId !== undefined
              ? "user_id"
              : undefined,
      text: input.content,
    }),
    true,
  );
  return {
    result: {
      action: "sent",
      acknowledged: true,
      ...optionalFields({
        messageId: raw.message_id ?? raw.messageId,
      }),
    },
  };
}

/**
 * TeamHub returns Feishu's own snake_case keys; the CLI's camelCase name is
 * accepted too, so a TeamHub that normalizes the fields still reads.
 */
function field(row: Json, name: string, raw: string): unknown {
  return row[name] ?? row[raw];
}

function pageRows(raw: Json, key: string, label: string): Json[] {
  if (!Array.isArray(raw[key]))
    throw new CliError("incomplete_response", `The ${label} is incomplete.`);
  return (raw[key] as unknown[]).map((x) => record(x, label));
}

function feishuImChat(value: unknown): Json {
  const row = record(value, "chat");
  return optionalFields({
    chatId: requiredString(field(row, "chatId", "chat_id"), "chat ID"),
    name: row.name,
    description: row.description,
    ownerId: field(row, "ownerId", "owner_id"),
    chatMode: field(row, "chatMode", "chat_mode"),
    chatType: field(row, "chatType", "chat_type"),
  });
}

function feishuImMessage(value: unknown): Json {
  const row = record(value, "message");
  return optionalFields({
    messageId: requiredString(
      field(row, "messageId", "message_id"),
      "message ID",
    ),
    chatId: field(row, "chatId", "chat_id"),
    threadId: field(row, "threadId", "thread_id"),
    senderId: field(row, "senderId", "sender_id"),
    senderType: field(row, "senderType", "sender_type"),
    msgType: field(row, "msgType", "msg_type"),
    text: row.text,
    createdAt: field(row, "createdAt", "create_time"),
  });
}
