import {
  BYOK_URL_PATH_PATTERN,
  MAX_BYOK_URL_PATH,
} from "@linger/service-kit/byok-endpoint";
import { z } from "zod";

import { SETUP_EXTERNAL_URLS, type SetupCommand } from "../shared/setup.js";

// A provider key, or "" to remove the saved one; the installer checks the
// same shape before saving.
const providerKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._~+/=:-]{0,512}$/, "Invalid key");

// Empty, or whole segments each led by one slash, so a path or endpoint can
// only extend the base URL's path.
const byokUrlPath = z
  .string()
  .max(MAX_BYOK_URL_PATH)
  .regex(BYOK_URL_PATH_PATTERN, "Invalid path");

const byokEndpointFields = {
  baseUrl: z.string().trim().min(1).max(2048),
  path: byokUrlPath,
  endpoint: byokUrlPath,
  protocol: z.enum(["openai-chat", "openai-responses", "anthropic"]),
  apiKey: z.string().max(4096).optional(),
};

const byokConfig = z
  .object({
    ...byokEndpointFields,
    modelId: z
      .string()
      .trim()
      .regex(/^[-a-zA-Z0-9_./:@]{1,256}$/, "Invalid model ID"),
    runtime: z.enum(["claude", "codex", "pi"]),
  })
  .strict();

const externalUrl = z.enum(SETUP_EXTERNAL_URLS);

const setupCommand = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("server.set"), serverUrl: z.string().max(2048) })
    .strict(),
  z.object({ op: z.literal("external.open"), url: externalUrl }).strict(),
  z.object({ op: z.literal("driver.open-nvidia-app") }).strict(),
  z
    .object({
      op: z.literal("driver.start-install"),
      requiredCuda: z
        .string()
        .trim()
        .regex(/^\d+(?:\.\d+){0,2}$/)
        .optional(),
    })
    .strict(),
  z.object({ op: z.literal("driver.clear-state") }).strict(),
  z
    .object({
      op: z.literal("local.start"),
      runtime: z
        .enum(["recommended", "codex", "claude", "pi", "local"])
        .optional(),
      byok: byokConfig.optional(),
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
      op: z.literal("local.byok.check"),
      byok: byokConfig,
    })
    .strict(),
  z
    .object({
      op: z.literal("local.byok.models"),
      byok: z.object(byokEndpointFields).strict(),
    })
    .strict(),
  z.object({ op: z.literal("local.recheck") }).strict(),
  z.object({ op: z.literal("local.location.pick") }).strict(),
  z.object({ op: z.literal("local.location.reset") }).strict(),
  z
    .object({
      op: z.literal("local.signin.start"),
      code: z.string().trim().min(1).max(4096).optional(),
      device: z.literal(true).optional(),
    })
    .strict(),
  z.object({ op: z.literal("local.signin.open") }).strict(),
  z
    .object({
      op: z.literal("local.signin.copy"),
      what: z.enum(["url", "code"]),
    })
    .strict(),
  z.object({ op: z.literal("local.signin.cancel") }).strict(),
  z
    .object({
      op: z.literal("local.signin.switch"),
      runtime: z.enum(["codex", "claude", "pi"]),
    })
    .strict(),
  z
    .object({
      op: z.literal("local.signin.byok"),
      byok: byokConfig,
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
  z
    .object({
      op: z.literal("diagnostics.send"),
      action: z.enum(["start", "confirm", "retry", "cancel", "copy"]),
    })
    .strict(),
]);

// Commands come from a local page, but are still validated at the boundary.
export const parseSetupCommand = (value: unknown): SetupCommand =>
  setupCommand.parse(value) as SetupCommand;
