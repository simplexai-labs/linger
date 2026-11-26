import { describe, expect, it } from "vitest";

import { MemoryFiles } from "../testing/memory";
import {
  GRANT_REFRESH_MS,
  notificationTarget,
  pushSetupFrom,
  readPushRecord,
  shouldRefreshGrant,
  updatePushRecord,
  writePushRecord,
} from "./grant";

const now = Date.parse("2026-11-22T10:00:00Z");

describe("shouldRefreshGrant", () => {
  it("asks for a grant when there is none or the token changed", () => {
    expect(
      shouldRefreshGrant({ enabled: true }, "ExponentPushToken[a]", "en", now),
    ).toBe(true);
    expect(
      shouldRefreshGrant(
        {
          enabled: true,
          grantedAt: new Date(now - 1000).toISOString(),
          expoToken: "ExponentPushToken[b]",
        },
        "ExponentPushToken[a]",
        "en",
        now,
      ),
    ).toBe(true);
  });

  it("refreshes a grant older than seven days and keeps a newer one", () => {
    const record = (age: number) => ({
      enabled: true,
      grantedAt: new Date(now - age).toISOString(),
      expoToken: "ExponentPushToken[a]",
    });
    expect(
      shouldRefreshGrant(
        record(GRANT_REFRESH_MS - 1000),
        "ExponentPushToken[a]",
        "en",
        now,
      ),
    ).toBe(false);
    expect(
      shouldRefreshGrant(
        record(GRANT_REFRESH_MS),
        "ExponentPushToken[a]",
        "en",
        now,
      ),
    ).toBe(true);
  });

  it("renews when the interface language changes", () => {
    const record = {
      enabled: true,
      grantedAt: new Date(now - 1000).toISOString(),
      expoToken: "ExponentPushToken[a]",
    };
    // A grant from before phones sent a language is English.
    expect(shouldRefreshGrant(record, "ExponentPushToken[a]", "en", now)).toBe(
      false,
    );
    expect(
      shouldRefreshGrant(record, "ExponentPushToken[a]", "zh-CN", now),
    ).toBe(true);
    expect(
      shouldRefreshGrant(
        { ...record, language: "zh-CN" },
        "ExponentPushToken[a]",
        "zh-CN",
        now,
      ),
    ).toBe(false);
  });

  it("never asks while push is off", () => {
    expect(
      shouldRefreshGrant({ enabled: false }, "ExponentPushToken[a]", "en", now),
    ).toBe(false);
  });
});

describe("push setup and notification data", () => {
  it("needs both the EAS project and the Push Service URL", () => {
    expect(
      pushSetupFrom({
        eas: { projectId: "p1" },
        pushServiceUrl: "https://push.example/",
      }),
    ).toEqual({
      projectId: "p1",
      serviceUrl: "https://push.example",
    });
    expect(pushSetupFrom({ eas: { projectId: "p1" } })).toBeUndefined();
    expect(
      pushSetupFrom({ pushServiceUrl: "https://push.example" }),
    ).toBeUndefined();
    expect(pushSetupFrom(undefined)).toBeUndefined();
  });

  it("reads the computer and Room a notification names", () => {
    expect(
      notificationTarget({
        host_id: "a".repeat(32),
        room_id: "room_1",
        event_id: "e1",
        kind: "message",
      }),
    ).toEqual({ hostId: "a".repeat(32), roomId: "room_1" });
    expect(
      notificationTarget({ host_id: "nope", room_id: "room_1" }),
    ).toBeUndefined();
    expect(
      notificationTarget({ host_id: "a".repeat(32), room_id: "../x" }),
    ).toBeUndefined();
  });

  it("stores the record per computer and defaults to on", async () => {
    const files = new MemoryFiles();
    expect(await readPushRecord(files, "a".repeat(32))).toEqual({
      enabled: true,
    });
    await writePushRecord(files, "a".repeat(32), { enabled: false });
    expect((await readPushRecord(files, "a".repeat(32))).enabled).toBe(false);
    expect((await readPushRecord(files, "b".repeat(32))).enabled).toBe(true);
  });

  it("keeps the preferences when another field changes", async () => {
    const files = new MemoryFiles();
    const host = "a".repeat(32);
    const preferences = { replies: false, decisions: true, whenActive: true };
    await updatePushRecord(files, host, {
      preferences,
      preferencesPending: true,
    });
    await updatePushRecord(files, host, { grantedAt: "2026-11-26T00:00:00Z" });
    const record = await readPushRecord(files, host);
    expect(record.preferences).toEqual(preferences);
    expect(record.preferencesPending).toBe(true);
    expect(record.grantedAt).toBe("2026-11-26T00:00:00Z");
  });
});
