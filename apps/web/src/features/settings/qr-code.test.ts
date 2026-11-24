import { describe, expect, it } from "vitest";

import { encodeQrMatrix } from "./qr-code";

describe("encodeQrMatrix", () => {
  it("encodes a WeChat pairing URL into a valid QR matrix with finder patterns", () => {
    const qr = encodeQrMatrix(
      "https://liteapp.weixin.qq.com/q/7QeAa1?qrcode=abc123",
    );
    expect(qr).toBeDefined();
    const { size, modules } = qr!;
    expect(size).toBeGreaterThanOrEqual(21);
    expect(modules).toHaveLength(size * size);
    // Top-left 7x7 finder outer border and 3x3 center are dark.
    expect(modules[0]).toBe(true);
    expect(modules[3 * size + 3]).toBe(true);
    // Separator around top-left finder is light.
    expect(modules[7]).toBe(false);
    expect(modules[7 * size]).toBe(false);
    // Dark module at (size - 8, 8) is always set.
    expect(modules[(size - 8) * size + 8]).toBe(true);
  });

  it("returns undefined for payloads beyond Version 10 capacity", () => {
    expect(encodeQrMatrix("x".repeat(300))).toBeUndefined();
  });
});
