import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

import base from "../../../e2e/playwright.room-document.config";

if (
  process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1" ||
  process.env.TEST_DATABASE_URL
) {
  throw new Error("Verification requires its own managed servers and database");
}
const evidence = process.env.VERIFY_LINGER_EVIDENCE;
if (!evidence)
  throw new Error("Launch with scripts/verify.sh to allocate evidence");

const specOverride = process.env.VERIFY_SPEC?.trim() || undefined;
if (
  specOverride &&
  (specOverride.startsWith("/") || specOverride.includes(".."))
) {
  throw new Error(
    `VERIFY_SPEC must name a spec under apps/web/e2e, got ${specOverride}`,
  );
}
const specMatch = specOverride?.replace(/^apps\/web\/e2e\//, "");
const roomStartupProof = process.env.VERIFY_ROOM_STARTUP === "1";
const productionStartupProof =
  process.env.VERIFY_ROOM_STARTUP_PRODUCTION === "1";
const connectorProof = process.env.VERIFY_CONNECTOR_CLI === "1";
const appsProof = process.env.VERIFY_CONNECTED_APPS === "1" || connectorProof;
const providerPort = process.env.VERIFY_COMPOSIO_PORT ?? "28087";
const backendEnv = {
  COMPOSIO_API_KEY: "disposable-provider-key",
  TEAMHUB_COMPOSIO_ENVIRONMENT_KEY: "browser-proof",
  WEB_PUBLIC_ORIGIN: `http://127.0.0.1:${process.env.PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT ?? "23008"}`,
};

export default defineConfig({
  ...base,
  webServer: Array.isArray(base.webServer)
    ? [
        ...(appsProof
          ? [
              {
                command: "node .agents/skills/verify-linger/apps-provider.mjs",
                url: `http://127.0.0.1:${providerPort}/healthz`,
                reuseExistingServer: false,
                cwd: fileURLToPath(new URL("../../..", import.meta.url)),
              },
            ]
          : []),
        ...base.webServer.map((server, index) => ({
          ...(appsProof ? { env: backendEnv } : {}),
          ...server,
          // TeamHub reaches the disposable provider through the harness.
          ...(appsProof && index === 1
            ? {
                command: `${server.command} -composio-base-url=http://127.0.0.1:${providerPort}`,
              }
            : {}),
          ...(productionStartupProof && index === 0
            ? { timeout: 300_000 }
            : {}),
          cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        })),
      ]
    : base.webServer,
  testDir: fileURLToPath(
    new URL(
      specMatch || roomStartupProof || productionStartupProof
        ? "../../../apps/web/e2e"
        : ".",
      import.meta.url,
    ),
  ),
  testMatch:
    specMatch ??
    (roomStartupProof
      ? "room-startup.spec.ts"
      : productionStartupProof
        ? "room-startup-production.spec.ts"
        : connectorProof
          ? "connector-cli.spec.ts"
          : appsProof
            ? "apps.spec.ts"
            : "document.spec.ts"),
  timeout: 120_000,
  workers: 1,
  retries: 0,
  shard: undefined,
  outputDir: `${evidence}/browser`,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: `${evidence}/report` }],
  ],
  use: {
    ...base.use,
    actionTimeout: 30_000,
    trace: productionStartupProof ? "retain-on-failure" : "on",
    screenshot: "on",
    video: productionStartupProof ? "off" : "on",
  },
});
