import { afterEach, describe, expect, it } from "vitest";

import { resetLanguageForTest, setLanguage, translate } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";

import {
  resolveRuntimeModelLabel,
  runtimeModelLabels,
  withDisambiguatedModelLabels,
} from "./use-agent-model-selection";

afterEach(() => resetLanguageForTest());

describe("runtimeModelLabels", () => {
  it("keeps unique labels untouched", () => {
    const labels = runtimeModelLabels([
      { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "gpt-5.4", label: "GPT-5.4" },
    ]);

    expect(labels.get("claude-sonnet-4")).toBe("Claude Sonnet 4");
    expect(labels.get("gpt-5.4")).toBe("GPT-5.4");
  });

  it("appends the model ID only to entries that share a display label", () => {
    const labels = runtimeModelLabels([
      { id: "server/group/wb-gpt-5.5", label: "WorkBuddy Site" },
      { id: "server/group/wb-glm-5.3", label: "WorkBuddy Site" },
      { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
    ]);

    expect(labels.get("server/group/wb-gpt-5.5")).toBe(
      "WorkBuddy Site (server/group/wb-gpt-5.5)",
    );
    expect(labels.get("server/group/wb-glm-5.3")).toBe(
      "WorkBuddy Site (server/group/wb-glm-5.3)",
    );
    expect(labels.get("claude-sonnet-4")).toBe("Claude Sonnet 4");
  });

  it("treats labels that match after trimming whitespace as collisions", () => {
    const labels = runtimeModelLabels([
      { id: "model-a", label: "Relay Model" },
      { id: "model-b", label: "  Relay Model  " },
    ]);

    expect(labels.get("model-a")).toBe("Relay Model (model-a)");
    expect(labels.get("model-b")).toBe("Relay Model (model-b)");
  });

  it("falls back to the model ID when the display label is blank", () => {
    const labels = runtimeModelLabels([
      { id: "server/wb-gpt-5.5", label: "" },
      { id: "server/wb-glm-5.3", label: "   " },
    ]);

    expect(labels.get("server/wb-gpt-5.5")).toBe("server/wb-gpt-5.5");
    expect(labels.get("server/wb-glm-5.3")).toBe("server/wb-glm-5.3");
  });

  it("avoids repeating the ID when a colliding entry already uses its ID as its label", () => {
    const labels = runtimeModelLabels([
      { id: "workbuddy", label: "workbuddy" },
      { id: "proxy/workbuddy-2", label: "workbuddy" },
    ]);

    expect(labels.get("workbuddy")).toBe("workbuddy");
    expect(labels.get("proxy/workbuddy-2")).toBe(
      "workbuddy (proxy/workbuddy-2)",
    );
  });

  it("ignores repeated entries with the same model ID", () => {
    const labels = runtimeModelLabels([
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.4", label: "GPT-5.4" },
    ]);

    expect(labels.get("gpt-5.4")).toBe("GPT-5.4");
  });

  it("resolves secondary collisions introduced by a disambiguation suffix", () => {
    const labels = runtimeModelLabels([
      { id: "model-a", label: "Relay Model" },
      { id: "model-b", label: "Relay Model" },
      { id: "model-c", label: "Relay Model (model-a)" },
    ]);

    expect(new Set(labels.values()).size).toBe(3);
    expect(labels.get("model-a")).toBe("Relay Model (model-a)");
    expect(labels.get("model-b")).toBe("Relay Model (model-b)");
    expect(labels.get("model-c")).toBe("Relay Model (model-a) (model-c)");
  });

  it("falls back to distinct model IDs when colliding labels already match suffixes", () => {
    const labels = runtimeModelLabels([
      { id: "a", label: "x (a)" },
      { id: "x (a)", label: "x (a)" },
    ]);

    expect(new Set(labels.values()).size).toBe(2);
    expect(labels.get("a")).toBe("a");
    expect(labels.get("x (a)")).toBe("x (a)");
  });

  it("disambiguates against translated stand-in default model labels", async () => {
    await setLanguage("zh-CN");
    const translatedDefault = zhCN.runtimeModel.hostDefault.replace(
      "{app}",
      "Codex",
    );
    const labels = runtimeModelLabels(
      [
        { id: "codex-default", label: "Codex default" },
        { id: "custom/codex-default", label: translatedDefault },
      ],
      translate,
    );

    expect(labels.get("codex-default")).toBe(
      `${translatedDefault} (codex-default)`,
    );
    expect(labels.get("custom/codex-default")).toBe(
      `${translatedDefault} (custom/codex-default)`,
    );
  });
});

describe("withDisambiguatedModelLabels", () => {
  it("preserves extra model metadata while disambiguating colliding labels", () => {
    const models = withDisambiguatedModelLabels([
      {
        id: "server/group/wb-gpt-5.5",
        label: "WorkBuddy Site",
        allowed_reasoning_effort: ["low", "high"] as const,
      },
      {
        id: "server/group/wb-glm-5.3",
        label: "WorkBuddy Site",
        allowed_reasoning_effort: ["medium"] as const,
      },
    ]);

    expect(models).toEqual([
      {
        id: "server/group/wb-gpt-5.5",
        label: "WorkBuddy Site (server/group/wb-gpt-5.5)",
        allowed_reasoning_effort: ["low", "high"],
      },
      {
        id: "server/group/wb-glm-5.3",
        label: "WorkBuddy Site (server/group/wb-glm-5.3)",
        allowed_reasoning_effort: ["medium"],
      },
    ]);
  });
});

describe("resolveRuntimeModelLabel", () => {
  it("returns the disambiguated label when present and undefined otherwise", () => {
    const models = [
      { id: "server/group/wb-gpt-5.5", label: "WorkBuddy Site" },
      { id: "server/group/wb-glm-5.3", label: "WorkBuddy Site" },
      { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
    ];

    expect(resolveRuntimeModelLabel(models, "server/group/wb-gpt-5.5")).toBe(
      "WorkBuddy Site (server/group/wb-gpt-5.5)",
    );
    expect(resolveRuntimeModelLabel(models, "claude-sonnet-4")).toBe(
      "Claude Sonnet 4",
    );
    expect(resolveRuntimeModelLabel(models, "missing")).toBeUndefined();
    expect(
      resolveRuntimeModelLabel(undefined, "claude-sonnet-4"),
    ).toBeUndefined();
    expect(resolveRuntimeModelLabel(models, undefined)).toBeUndefined();
  });
});
