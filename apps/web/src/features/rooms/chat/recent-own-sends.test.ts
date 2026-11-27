import { describe, expect, it } from "vitest";

import {
  OWN_ENTRANCE_MS,
  ownSendStartedAt,
  rememberOwnSend,
} from "./recent-own-sends";

describe("recentOwnSends", () => {
  it("keeps the start time of a send inside the entrance window", () => {
    rememberOwnSend("m1", 1_000);
    expect(ownSendStartedAt("m1")).toBe(1_000);
  });

  it("evicts entries older than the entrance window as newer sends arrive", () => {
    rememberOwnSend("m1", 1_000);
    rememberOwnSend("m2", 1_000 + OWN_ENTRANCE_MS);
    expect(ownSendStartedAt("m1")).toBeUndefined();
    expect(ownSendStartedAt("m2")).toBe(1_000 + OWN_ENTRANCE_MS);
  });

  it("keeps entries still inside the entrance window", () => {
    rememberOwnSend("m1", 1_000);
    rememberOwnSend("m2", 1_000 + OWN_ENTRANCE_MS - 1);
    expect(ownSendStartedAt("m1")).toBe(1_000);
    expect(ownSendStartedAt("m2")).toBe(1_000 + OWN_ENTRANCE_MS - 1);
  });
});
