import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ConfigStore,
  IMessageHandlesError,
  normalizeIMessageHandle,
  normalizeIMessageHandles,
} from "./config.js";
import { tempDirectory } from "./test-support.js";

describe("ConfigStore iMessage settings", () => {
  it("reads a config file from before iMessage", () => {
    const file = path.join(tempDirectory(), "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        serverUrl: "http://localhost:3000",
        computerId: "c1",
        permissionsAsked: ["automation"],
      }),
    );
    const config = new ConfigStore(file).get();
    expect(config.computerId).toBe("c1");
    expect(config.imessage).toEqual({
      enabled: false,
      handles: [],
      automationAsked: false,
    });
  });

  it("resets only a damaged iMessage block", () => {
    const file = path.join(tempDirectory(), "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        computerId: "c1",
        imessage: { enabled: true, handles: [42] },
      }),
    );
    const config = new ConfigStore(file).get();
    expect(config.computerId).toBe("c1");
    expect(config.imessage.enabled).toBe(false);
  });
});

describe("normalizeIMessageHandle", () => {
  it("normalizes phone numbers and emails", () => {
    expect(normalizeIMessageHandle("+86 138-0013-8000")).toBe("+8613800138000");
    expect(normalizeIMessageHandle(" +1 (415) 555.0100 ")).toBe("+14155550100");
    expect(normalizeIMessageHandle(" Me@iCloud.COM ")).toBe("me@icloud.com");
  });

  it("rejects what is neither", () => {
    expect(normalizeIMessageHandle("12345")).toBeUndefined();
    expect(normalizeIMessageHandle("+12345")).toBeUndefined();
    expect(normalizeIMessageHandle("+1234567890123456")).toBeUndefined();
    expect(normalizeIMessageHandle("me@")).toBeUndefined();
    expect(normalizeIMessageHandle("")).toBeUndefined();
  });
});

describe("normalizeIMessageHandles", () => {
  it("deduplicates after normalizing", () => {
    expect(
      normalizeIMessageHandles(["+1 415 555 0100", "+14155550100", "A@b.co"]),
    ).toEqual(["+14155550100", "a@b.co"]);
  });

  it("rejects an invalid handle with a typed error", () => {
    expect(() => normalizeIMessageHandles(["a@b.co", "12345"])).toThrow(
      expect.objectContaining({ code: "invalid_handle" }),
    );
  });

  it("rejects more than ten handles", () => {
    const handles = Array.from({ length: 11 }, (_, i) => `+1415555010${i}`);
    let error: unknown;
    try {
      normalizeIMessageHandles(handles);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IMessageHandlesError);
    expect((error as IMessageHandlesError).code).toBe("too_many_handles");
  });
});
