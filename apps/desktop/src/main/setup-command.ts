import { z } from "zod";

import type { SetupCommand } from "../shared/setup.js";

// A provider key, or "" to remove the saved one; the installer checks the
// same shape before saving.
const providerKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._~+/=:-]{0,512}$/, "Invalid key");

const runtimeApiKey = z
  .string()
  .trim()
  .min(1, "Enter an API key.")
  .max(4096, "The API key is too long.")
  .refine(
    (key) =>
      [...key].every(
        (character) =>
          character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
      ),
    "The API key must not contain spaces or control characters.",
  );

const piCredentials = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.enum(["openai", "anthropic"]),
      apiKey: runtimeApiKey,
    })
    .strict(),
  z
    .object({
      provider: z.literal("openai-compatible"),
      apiKey: runtimeApiKey,
      baseUrl: z
        .string()
        .trim()
        .max(2048)
        .refine((value) => {
          try {
            const url = new URL(value);
            return (
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              (url.protocol === "https:" ||
                (url.protocol === "http:" &&
                  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
            );
          } catch {
            return false;
          }
        }, "Use a credential-free HTTPS endpoint, or HTTP on localhost."),
      model: z
        .string()
        .trim()
        .regex(/^[-a-zA-Z0-9_./:]{1,256}$/, "Enter a valid model ID."),
    })
    .strict(),
]);

const setupCommand = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("server.set"), serverUrl: z.string().max(2048) })
    .strict(),
  z
    .object({
      op: z.literal("local.start"),
      runtime: z
        .enum(["recommended", "codex", "claude", "pi", "local"])
        .optional(),
      keys: z
        .object({
          composio: providerKey.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("local.signin.configure"),
      credentials: piCredentials,
    })
    .strict(),
  z.object({ op: z.literal("local.cancel") }).strict(),
  z.object({ op: z.literal("local.location.pick") }).strict(),
  z.object({ op: z.literal("local.location.reset") }).strict(),
  z
    .object({
      op: z.literal("local.signin.start"),
      code: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  z.object({ op: z.literal("local.signin.open") }).strict(),
  z.object({ op: z.literal("local.signin.cancel") }).strict(),
  z
    .object({
      op: z.literal("local.signin.switch"),
      runtime: z.enum(["codex", "claude", "pi"]),
    })
    .strict(),
  z.object({ op: z.literal("local.account.show"), on: z.boolean() }).strict(),
  z.object({ op: z.literal("local.account.copy") }).strict(),
  z.object({ op: z.literal("local.account.reveal") }).strict(),
  z.object({ op: z.literal("signin.open") }).strict(),
  z.object({ op: z.literal("computer.connect") }).strict(),
  z.object({ op: z.literal("notifications.test") }).strict(),
  z.object({ op: z.literal("prevent-sleep.set"), on: z.boolean() }).strict(),
  z.object({ op: z.literal("open-at-login.set"), on: z.boolean() }).strict(),
  z.object({ op: z.literal("folder.add") }).strict(),
  z
    .object({
      op: z.literal("permission.request"),
      id: z.enum(["folders", "automation"]),
    })
    .strict(),
  z
    .object({
      op: z.literal("permission.settings"),
      id: z.enum(["full-disk", "folders", "automation"]),
    })
    .strict(),
  z.object({ op: z.literal("finish") }).strict(),
  z.object({ op: z.literal("logs.open") }).strict(),
  z.object({ op: z.literal("diagnostics.save") }).strict(),
]);

// Commands come from a local page, but are still validated at the boundary.
export function parseSetupCommand(value: unknown): SetupCommand {
  const result = setupCommand.safeParse(value);
  if (result.success) return result.data;
  if (
    value !== null &&
    typeof value === "object" &&
    "op" in value &&
    value.op === "local.signin.configure"
  )
    throw new Error(
      "Check the provider settings. Enter an API key without spaces and, for a compatible provider, a valid HTTPS or localhost endpoint and model ID.",
    );
  throw result.error;
}
