import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/sensitive-text.js";

describe("redactSensitiveText", () => {
  it("redacts PEM private keys, Bearer/Basic auth headers, and full cookie headers", () => {
    expect(
      redactSensitiveText(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      ),
    ).toBe("[Redacted private key]");

    expect(redactSensitiveText("Authorization: Bearer tok-secret-12345")).toBe(
      "Authorization: Bearer [Redacted]",
    );

    expect(redactSensitiveText("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic [Redacted]",
    );

    expect(redactSensitiveText("Proxy-Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Proxy-Authorization: Basic [Redacted]",
    );

    expect(
      redactSensitiveText(
        "Authorization: CustomScheme secret-val\nCookie: a=1; session=secret\nSet-Cookie: sid=xyz; HttpOnly",
      ),
    ).toBe(
      "Authorization: [Redacted]\nCookie: [Redacted]\nSet-Cookie: [Redacted]",
    );
  });

  it("does not over-redact ordinary prose containing the word Basic", () => {
    expect(redactSensitiveText("Basic usage of the tool failed")).toBe(
      "Basic usage of the tool failed",
    );
    expect(redactSensitiveText("Basic authentication failed")).toBe(
      "Basic authentication failed",
    );
  });
});
