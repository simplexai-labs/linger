import { describe, expect, it } from "vitest";

import { translate } from "@/i18n/language";

import { runtimeFailureMessage } from "./runtime-failure-message";
import { runtimeStatusMessages as m } from "./runtime-status.messages";

describe("Runtime failure messages", () => {
  it.each(["claude", "codex"] as const)(
    "describes the classified outcome for %s without infrastructure details",
    (runtime_type) => {
      const message = runtimeFailureMessage(translate, {
        code: "execution_outcome_unknown",
        runtime_type,
      });
      expect(message).toBe(translate(m.failureExecutionOutcomeUnknown));
      expect(message).not.toMatch(
        /Pod|container|Kubernetes|token|network error/i,
      );
    },
  );

  it.each([
    ["model_unavailable", m.failureModelUnavailable],
    ["model_not_offered", m.failureModelNotOffered],
    ["local_model_unavailable", m.failureLocalModelUnavailable],
    ["model_gateway_unavailable", m.failureModelGatewayUnavailable],
    ["reply_undelivered", m.failureReplyUndelivered],
    ["reply_not_sent", m.failureReplyNotSent],
    ["context_too_long", m.failureContextTooLong],
    ["model_service_error", m.failureModelServiceError],
    ["timeout", m.failureTimeout],
    ["response_too_large", m.failureResponseTooLarge],
    ["cleanup_unconfirmed", m.failureCleanupUnconfirmed],
    ["unclassified", m.failureUnclassified],
  ] as const)("gives %s its own cause", (code, message) => {
    expect(
      runtimeFailureMessage(translate, { code, runtime_type: "codex" }),
    ).toBe(translate(message));
  });

  it("leaves the Runtime and its version out of the cause", () => {
    const message = runtimeFailureMessage(translate, {
      code: "model_unavailable",
      runtime_type: "codex",
      runtime_version: "0.153.4",
    });
    expect(message).not.toContain("Codex");
    expect(message).not.toContain("0.153.4");
  });

  it("names a failure the Agent Service observed without a Runtime", () => {
    expect(runtimeFailureMessage(translate, { code: "interrupted" })).toBe(
      translate(m.failureInterrupted),
    );
    expect(
      runtimeFailureMessage(translate, { code: "computer_unavailable" }),
    ).toBe(translate(m.failureComputerUnavailable));
  });

  it("gives every classified code a distinct cause", () => {
    const codes = [
      "protocol_incompatible",
      "authentication_required",
      "network_error",
      "rate_limited",
      "execution_failed",
    ] as const;
    const texts = codes.map((code) =>
      runtimeFailureMessage(translate, { code, runtime_type: "codex" }),
    );
    expect(new Set(texts).size).toBe(codes.length);
  });

  it("does not render raw version data and falls back for unknown causes", () => {
    expect(
      runtimeFailureMessage(translate, {
        code: "execution_failed",
        runtime_type: "codex",
        runtime_version: "/private/token",
      }),
    ).not.toContain("private");
    expect(runtimeFailureMessage(translate)).toBe(translate(m.runFailed));
  });
});
