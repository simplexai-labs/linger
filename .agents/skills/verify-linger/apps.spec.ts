import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RoomDocumentE2EHarnessClient } from "../../../apps/web/e2e/room-document-e2e-harness-client";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByLabel("Password", { exact: true }).fill("teamhub-dev-alice");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+\//);
}

function tenantAppsUrl(page: Page, query = "") {
  const match = /^(.*\/t\/[^/]+)\//.exec(new URL(page.url()).pathname);
  if (!match) throw new Error(`Expected a tenant route, got ${page.url()}`);
  return `${match[1]}/apps${query}`;
}

test("apps: browse connectors, authorize, reopen and disconnect", async ({
  page,
  browser,
  request,
  baseURL,
}, info) => {
  // Includes the server's one-minute pending-authorization poll.
  test.setTimeout(180_000);
  await test.step("Doctor and disposable account setup", async () => {
    await writeFile(
      info.outputPath("doctor.txt"),
      execFileSync(
        fileURLToPath(new URL("scripts/doctor.sh", import.meta.url)),
        { encoding: "utf8" },
      ),
    );
    await new RoomDocumentE2EHarnessClient(request).reset();
    await login(page);
    const response = await page.request.get("/v0/external-apps");
    expect(response.ok()).toBe(true);
    const { apps } = await response.json();
    expect(
      apps.find((app: { key: string }) => app.key === "linear"),
    ).toMatchObject({ availability: "available" });
  });
  await test.step("Browse connector categories", async () => {
    await page.goto(tenantAppsUrl(page));
    const categories = page.getByRole("tablist", {
      name: "Connector categories",
    });
    const connectedOnly = page.getByRole("button", {
      name: "Connected only",
      exact: true,
    });
    await expect(
      categories.getByRole("tab", { name: "All", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("heading", { name: "Productivity", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Gmail", exact: true }),
    ).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath("connectors.png") });
    await categories
      .getByRole("tab", { name: "Productivity", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Linear", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Gmail", exact: true }),
    ).toHaveCount(0);
    await connectedOnly.click();
    await expect(connectedOnly).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByText("No connected apps yet.", { exact: true }),
    ).toBeVisible();
    await connectedOnly.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await categories.getByRole("tab", { name: "All", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Linear", exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await page.screenshot({ path: info.outputPath("connectors-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 720 });
  });
  await test.step("Authorize through the provider popup", async () => {
    const popupPromise = page.waitForEvent("popup");
    await page
      .getByRole("button", { name: "Connect Linear", exact: true })
      .click();
    const popup = await popupPromise;
    const popupClosed = popup.waitForEvent("close");
    await popup.getByRole("button", { name: "Authorize Linear" }).click();
    await popupClosed;
    // The popup closes itself after redirecting to /oauth/composio-complete,
    // which immediately wakes TeamHub reconciliation (with a 5-second fallback
    // poll for 3 minutes and 1 minute thereafter). A returning user observes
    // the Active status on reload.
    await expect(async () => {
      await page.goto(tenantAppsUrl(page, "?app=linear"));
      await expect(
        page
          .getByRole("dialog", { name: "Linear", exact: true })
          .getByText("Active", { exact: true }),
      ).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 90_000, intervals: [2000] });
    await page.screenshot({ path: info.outputPath("connected.png") });
  });
  await test.step("Read persisted connection in a new session and disconnect", async () => {
    const context = await browser.newContext({ baseURL });
    try {
      const fresh = await context.newPage();
      await login(fresh);
      await fresh.goto(tenantAppsUrl(fresh));
      await fresh
        .getByRole("button", { name: "Connected only", exact: true })
        .click();
      await fresh.getByRole("button", { name: "Linear", exact: true }).click();
      const manage = fresh.getByRole("dialog", { name: "Linear", exact: true });
      await expect(manage.getByText("Active", { exact: true })).toBeVisible();
      await fresh.screenshot({ path: info.outputPath("reopened.png") });
      await manage.getByRole("button", { name: /^Disconnect / }).click();
      const dialog = fresh.getByRole("dialog", {
        name: "Disconnect account?",
      });
      await dialog
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      const closeConfirmation = dialog.getByRole("button", {
        name: "Close",
        exact: true,
      });
      await expect(closeConfirmation).toBeVisible();
      await closeConfirmation.click();
      await fresh.goto(tenantAppsUrl(fresh, "?app=linear"));
      await expect(
        fresh
          .getByRole("dialog", { name: "Linear", exact: true })
          .getByRole("button", { name: "Connect Linear", exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await fresh.screenshot({ path: info.outputPath("disconnected.png") });
      await writeFile(
        info.outputPath("proof.json"),
        JSON.stringify(
          {
            feature: "managed-apps",
            realTeamHub: true,
            realPostgres: true,
            provider:
              "Composio HTTP simulation; real OAuth and Agent execution not verified",
            freshSession: true,
            disconnectedAfterReload: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await context.close();
    }
  });
});
