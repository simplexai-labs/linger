import { describe, expect, it } from "vitest";

import { readVoiceConfig } from "../../src/voice/config.js";
import { workerKeys } from "../../src/voice/service.js";

const base = {
  LINGER_SECRET_SEED: "local-development-secret-seed-not-for-production",
  TEAMHUB_BASE_URL: "http://127.0.0.1:8080",
};

describe("readVoiceConfig local ASR", () => {
  it("keeps local dictation off by default", () => {
    const config = readVoiceConfig(base);
    expect(config.localAsr).toBe(false);
    expect(config.localAsrModelDir).toBe("");
  });

  it("reads the model directory when local dictation is on", () => {
    const config = readVoiceConfig({
      ...base,
      VOICE_LOCAL_ASR: "on",
      VOICE_LOCAL_ASR_MODEL_DIR: "/models/zipformer",
    });
    expect(config.localAsr).toBe(true);
    expect(config.localAsrModelDir).toBe("/models/zipformer");
  });

  it("refuses local dictation without a model directory", () => {
    expect(() => readVoiceConfig({ ...base, VOICE_LOCAL_ASR: "on" })).toThrow(
      /VOICE_LOCAL_ASR_MODEL_DIR/,
    );
  });

  it("refuses a value other than on or off", () => {
    expect(() => readVoiceConfig({ ...base, VOICE_LOCAL_ASR: "true" })).toThrow(
      /on or off/,
    );
  });
});

describe("workerKeys", () => {
  it("runs transcription and recording on a Soniox key", () => {
    const workers = workerKeys({ soniox_api_key: "soniox" }, false);
    expect([...workers.keys()].sort()).toEqual(["asr", "recorder"]);
    expect(workers.get("asr")).toEqual({
      kind: "key",
      variable: "SONIOX_API_KEY",
      key: "soniox",
    });
  });

  it("runs only dictation on the local engine without a key", () => {
    const workers = workerKeys({}, true);
    expect([...workers.keys()]).toEqual(["asr"]);
    expect(workers.get("asr")).toEqual({ kind: "local" });
  });

  it("keeps dictation on Soniox when a key and the local engine exist", () => {
    const workers = workerKeys({ soniox_api_key: "soniox" }, true);
    expect(workers.get("asr")).toEqual({
      kind: "key",
      variable: "SONIOX_API_KEY",
      key: "soniox",
    });
    expect(workers.has("recorder")).toBe(true);
  });

  it("keeps Live on its own key", () => {
    const workers = workerKeys({ xai_api_key: "xai" }, false);
    expect([...workers.keys()]).toEqual(["live"]);
    expect(workers.get("live")).toEqual({
      kind: "key",
      variable: "XAI_API_KEY",
      key: "xai",
    });
  });

  it("starts nothing without a key or local dictation", () => {
    expect(workerKeys({}, false).size).toBe(0);
  });
});
