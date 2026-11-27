import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  createServiceProxy,
  createStaticHost,
  listenOnHosts,
  serviceProxyRoutes,
} from "../../../apps/web/static-host.mjs";

const [teamhub, evidence] = process.argv.slice(2);
const fixtureToken = "fixture" + "-mcp-token";
await mkdir(evidence, { recursive: true });
const serve = createStaticHost();
const proxy = createServiceProxy(
  serviceProxyRoutes({ TEAMHUB_BASE_URL: teamhub }),
);
const [host] = await listenOnHosts(
  () =>
    createServer((request, response) => {
      if (!proxy.request(request, response)) void serve(request, response);
    }),
  0,
  "127.0.0.1",
);

try {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || undefined,
  });
  try {
    const page = await browser.newPage({
      baseURL: `http://127.0.0.1:${host.address().port}`,
    });
    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@example.com");
    await page
      .getByLabel("Password", { exact: true })
      .fill("teamhub-dev-alice");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/t\/[^/]+\//);
    const tenantPrefix = /\/t\/[^/]+/.exec(new URL(page.url()).pathname)[0];
    await page.goto(`${tenantPrefix}/apps`);
    await page.getByRole("button", { name: "Add custom connector" }).click();
    const add = page.getByRole("dialog", { name: "Add custom connector" });
    await add.getByLabel("Name", { exact: true }).fill("Example MCP");
    await add.getByLabel("MCP URL").fill("https://mcp.example.test/echo");
    await add.getByLabel("Bearer token").fill(fixtureToken);
    await add.getByRole("button", { name: "Test connection" }).click();
    await expect(add.getByText("echo", { exact: true })).toBeVisible();
    await add.getByRole("button", { name: "Save", exact: true }).click();
    await expect(add).toHaveCount(0);
    await page.reload();
    await page.getByRole("tab", { name: "Custom", exact: true }).click();
    const custom = page.getByRole("region", { name: "Custom", exact: true });
    await expect(
      custom.getByText("Example MCP", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(evidence, "custom-connector.png") });
    await custom.getByRole("button", { name: "Manage", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit custom connector" });
    await expect(edit.getByLabel("Keep saved token")).toBeChecked();
    await expect(edit.getByLabel("Bearer token")).toHaveCount(0);
    await expect(edit.getByText("echo", { exact: true })).toBeVisible();
  } finally {
    await browser.close();
  }
} finally {
  host.closeAllConnections();
  await new Promise((resolve) => host.close(resolve));
}
