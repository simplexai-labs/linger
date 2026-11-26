import { describe, expect, it } from "vitest";
import { codexAgentInstructions } from "../../src/agent/codex-agent-instructions.js";
import { STATIC_PREFIX_END_MARKER } from "../../src/agent/prompt/index.js";

describe("Codex product instruction contract", () => {
  it("replaces native base behavior with the complete product instruction block", () => {
    const result = codexAgentInstructions({
      baseInstructions: "You are the assigned engineer.",
      developerInstructions: "Wait for approval before creating a Task.",
    });
    expect(result.developerInstructions).toBeUndefined();
    expect(result.baseInstructions).toContain("You are the assigned engineer.");
    expect(result.baseInstructions).toContain(
      "Wait for approval before creating a Task.",
    );
    expect(result.baseInstructions).toContain(
      "Continue after reporting progress",
    );
    expect(result.baseInstructions).toContain("AGENTS.md/AGENTS.override.md");
    expect(result.baseInstructions).toContain(
      "do not bypass them or duplicate a submitted operation",
    );
    expect(result.baseInstructions).toContain(
      "normal Runtime turn ending alone does not establish goal completion",
    );
  });

  it("keeps static rules before the slot marker and per-Agent base instructions after it", () => {
    const result = codexAgentInstructions({
      baseInstructions: "Per-agent instructions.",
      developerInstructions: `Static rules\n\n${STATIC_PREFIX_END_MARKER}\n\nDynamic context`,
    });
    expect(result.developerInstructions).toBeUndefined();
    const markerIdx = result.baseInstructions.indexOf(STATIC_PREFIX_END_MARKER);
    expect(markerIdx).toBeGreaterThan(0);
    const beforeMarker = result.baseInstructions.slice(0, markerIdx);
    const afterMarker = result.baseInstructions.slice(
      markerIdx + STATIC_PREFIX_END_MARKER.length,
    );
    expect(beforeMarker).toContain("<execution-responsibility>");
    expect(beforeMarker).toContain("Static rules");
    expect(beforeMarker).not.toContain("Per-agent instructions.");
    expect(afterMarker).toContain("Per-agent instructions.");
    expect(afterMarker).toContain("Dynamic context");
  });
});
