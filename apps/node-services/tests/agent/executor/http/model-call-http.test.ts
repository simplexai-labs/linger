import { describe, expect, it } from "vitest";
import {
  answerModelCall,
  readModelCallRequest,
} from "../../../../src/agent/executor/http/model-call-http.js";
import type { ModelCall } from "../../../../src/runtime-model-call.js";
import { stubModelCall } from "../../../model-call-stub.js";

/** Answers after ms unless the caller stops waiting first. */
function slowText(ms: number): ModelCall["text"] {
  return (request) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ output: "late", model: "codex" }),
        ms,
      );
      request.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(request.signal!.reason);
      });
    });
}

describe("answerModelCall", () => {
  it("answers pending when work nobody waits on outlasts the wait", async () => {
    const modelCall = stubModelCall({ text: slowText(1_000) });
    await expect(
      answerModelCall(modelCall, { kind: "memory", key: "k", input: "x" }, 20),
    ).rejects.toMatchObject({ name: "ModelCallError", kind: "pending" });
  });

  it("waits for interactive work and reports the caller leaving as such", async () => {
    const modelCall = stubModelCall({ text: slowText(40) });
    await expect(
      answerModelCall(
        modelCall,
        { kind: "approval", key: "k", input: "x" },
        20,
      ),
    ).resolves.toEqual({ model: "codex", text: "late" });

    const leave = new AbortController();
    const answer = answerModelCall(
      modelCall,
      { kind: "memory", key: "k", input: "x", signal: leave.signal },
      1_000,
    );
    leave.abort(new Error("client closed"));
    await expect(answer).rejects.toThrow("client closed");
  });
});

describe("readModelCallRequest model", () => {
  const body = { kind: "dictation_polish", key: "k", input: "x" };

  it("reads a model alias or catalog id", () => {
    for (const model of ["haiku", "claude-opus-4-1[1m]", "vendor/model:beta"])
      expect(readModelCallRequest({ ...body, model })).toMatchObject({ model });
  });

  it("leaves the model out when the request names none", () => {
    expect(readModelCallRequest(body)).not.toHaveProperty("model");
  });

  it("refuses a name the CLI could read as a flag or that is not text", () => {
    for (const model of [
      "",
      "--model",
      "-p",
      " haiku",
      "a b",
      7,
      "a".repeat(101),
    ])
      expect(readModelCallRequest({ ...body, model })).toBeUndefined();
  });
});
