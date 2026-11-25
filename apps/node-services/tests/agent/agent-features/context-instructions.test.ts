import { describe, expect, it } from "vitest";

import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import {
  assembleExecutionContextDeveloperInstructions,
  createContextInstructionsFeature,
  type ExecutionContextDeveloperInstructionsInput,
} from "../../../src/agent/agent-features/context-instructions/index.js";
import { createToolApprovalFeature } from "../../../src/agent/agent-features/tool-approval/index.js";
import type { AgentCapability } from "../../../src/agent/executor/types.js";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import { makeTestFeatureContext } from "./fixtures.js";

const sponsor = { actorId: "actor:sponsor", displayName: "Test Sponsor" };
const representedHuman = {
  actorId: "actor:human",
  displayName: "Memory Owner",
  memory: {
    version: 7,
    markdown: "# Memory\n- Prefers evidence. [2026-11-01]",
  },
};

type Scene = Pick<ExecutionContextDeveloperInstructionsInput, "agentType"> &
  (
    | {
        readonly contextKind: "meta";
        readonly roomId: string;
        readonly roomKind: "direct" | "collaboration";
      }
    | { readonly contextKind: "alter_ego"; readonly taskId: string }
    | { readonly contextKind: "document" }
  );

/** TeamHub sends the app catalog with or without a Composio key. */
const catalogAppKeys = ["gmail", "google_calendar", "linear"];

const render = (scene: Scene): string =>
  assembleExecutionContextDeveloperInstructions({
    agentName: "Research Partner",
    agentActorId: "actor:agent-1",
    developerInstructions: undefined,
    sponsor,
    connectedApps: true,
    connectedAppKeys: ["gmail", "google_calendar"],
    connectableAppKeys: catalogAppKeys,
    compactInstructions: false,
    ...(scene.agentType === "anotherme" ? { representedHuman } : {}),
    ...scene,
  });

/** The Context instructions an Agent reads, as the composed features build them. */
interface Deployment {
  readonly capabilities: readonly AgentCapability[];
  readonly connectedApps: boolean;
  readonly connectedAppKeys: readonly string[];
  readonly connectableAppKeys: readonly string[];
  /** The placed model's context window is at most 128K tokens. */
  readonly compactInstructions?: boolean;
}

/** `.env.example`: a permission judge and no Composio key. */
const defaultDeployment: Deployment = {
  capabilities: ["permissionReview"],
  connectedApps: false,
  connectedAppKeys: [],
  connectableAppKeys: catalogAppKeys,
};
const fullDeployment: Deployment = {
  capabilities: ["permissionReview"],
  connectedApps: true,
  connectedAppKeys: ["gmail", "google_calendar"],
  connectableAppKeys: catalogAppKeys,
};
const unconfiguredDeployment: Deployment = {
  capabilities: [],
  connectedApps: false,
  connectedAppKeys: [],
  connectableAppKeys: catalogAppKeys,
};
const compactDeployment: Deployment = {
  ...fullDeployment,
  compactInstructions: true,
};

const renderComposed = (
  scene: Scene,
  deployment: Deployment,
): string | undefined => {
  const ref: ExecutionContextRef =
    scene.contextKind === "meta"
      ? { kind: "meta", agentId: "agent-1", roomId: scene.roomId }
      : scene.contextKind === "alter_ego"
        ? { kind: "alter_ego", agentId: "agent-1", taskId: scene.taskId }
        : { kind: "document", agentId: "agent-1", documentId: "document-1" };
  const { context } = makeTestFeatureContext({
    ref,
    ...(scene.contextKind === "meta" ? { roomKind: scene.roomKind } : {}),
    identity: {
      actorId: "actor:agent-1",
      agentType: scene.agentType,
      sponsor,
      ...(scene.agentType === "anotherme" ? { representedHuman } : {}),
    },
    agentName: "Research Partner",
    agent: { name: "Research Partner", instructions: "unused" },
    capabilities: deployment.capabilities,
  });
  return composeContextFeatures({
    context,
    features: [createContextInstructionsFeature(), createToolApprovalFeature()],
  }).contextInstructions({
    connectedApps: deployment.connectedApps,
    connectedAppKeys: deployment.connectedAppKeys,
    connectableAppKeys: deployment.connectableAppKeys,
    compactInstructions: deployment.compactInstructions === true,
  });
};

const meta = (
  agentType: Scene["agentType"],
  roomKind: "direct" | "collaboration",
): Scene => ({ agentType, contextKind: "meta", roomId: "room-1", roomKind });

// Each snapshot is the full prompt one identity reads; review prompt changes as
// diffs of these files rather than as substring assertions.
const scenes: readonly (readonly [string, Scene])[] = [
  ["meta-anotherme-direct", meta("anotherme", "direct")],
  ["meta-anotherme-collaboration", meta("anotherme", "collaboration")],
  ["meta-general-direct", meta("general", "direct")],
  ["meta-general-collaboration", meta("general", "collaboration")],
  [
    "alter-ego-anotherme",
    { agentType: "anotherme", contextKind: "alter_ego", taskId: "task-1" },
  ],
  [
    "alter-ego-general",
    { agentType: "general", contextKind: "alter_ego", taskId: "task-1" },
  ],
  ["document-anotherme", { agentType: "anotherme", contextKind: "document" }],
  ["document-general", { agentType: "general", contextKind: "document" }],
];

describe("execution Context instructions", () => {
  // The fully configured deployment (permission judge and Composio key).
  it.each(scenes)("renders the %s prompt", async (name, scene) => {
    await expect(renderComposed(scene, fullDeployment)).toMatchFileSnapshot(
      `./__snapshots__/context-instructions/${name}.txt`,
    );
  });

  // Neither a permission judge nor a Composio key.
  it.each(scenes)(
    "renders the %s prompt without optional features",
    async (name, scene) => {
      await expect(
        renderComposed(scene, unconfiguredDeployment),
      ).toMatchFileSnapshot(
        `./__snapshots__/context-instructions/${name}-unconfigured.txt`,
      );
    },
  );

  // A small-context model, such as a local model, reads the compact version
  // of every section.
  it.each(scenes)("renders the compact %s prompt", async (name, scene) => {
    const compact = renderComposed(scene, compactDeployment)!;
    expect(compact.length).toBeLessThan(
      renderComposed(scene, fullDeployment)!.length / 2,
    );
    await expect(compact).toMatchFileSnapshot(
      `./__snapshots__/context-instructions/${name}-compact.txt`,
    );
  });

  // Without a permission judge only the tool approval protocol is left out.
  it.each(scenes)(
    "leaves the tool approval protocol out of %s without a judge",
    (_, scene) => {
      const reviewed = renderComposed(scene, fullDeployment)!;
      const unreviewed = renderComposed(scene, {
        ...fullDeployment,
        capabilities: [],
      })!;
      expect(unreviewed).not.toContain("<tool-approval-protocol>");
      expect(unreviewed).toBe(
        reviewed.replace(
          /\n\n<tool-approval-protocol>[\s\S]*<\/tool-approval-protocol>/u,
          "",
        ),
      );
    },
  );

  // Without a Composio key a Room conversation still names the catalog and
  // routes a request about one of its apps to teamhub apps connect, which asks
  // for the key first; other contexts teach no connected app command.
  it.each(scenes)(
    "routes catalog apps to an authorization card in %s even without a Composio key",
    (_, scene) => {
      const withApps = renderComposed(scene, fullDeployment)!;
      const withoutApps = renderComposed(scene, defaultDeployment)!;
      if (scene.contextKind === "meta") {
        expect(withoutApps).toContain(
          "Apps the Human can connect: gmail, google_calendar, linear.",
        );
        expect(withoutApps).toContain("run teamhub apps connect <app-key>");
      } else {
        for (const text of [
          "Connected app",
          "Connected Apps",
          "teamhub apps",
        ]) {
          expect(withoutApps).not.toContain(text);
        }
      }
      expect(withApps).toContain("Connected app");
      if (scene.contextKind !== "document") {
        expect(withoutApps).toContain("<tool-approval-protocol>");
      }
      if (scene.contextKind === "meta") {
        expect(withoutApps).toContain("- Routines:");
      }
    },
  );

  // The personal context sources name only the apps the Agent can query, so it
  // never runs a command for an app without a granted account. Document
  // contexts carry no personal context method.
  it.each(scenes.filter(([, scene]) => scene.contextKind !== "document"))(
    "lists only the connected app sources in %s",
    (_, scene) => {
      const gmailOnly = renderComposed(scene, {
        ...fullDeployment,
        connectedAppKeys: ["gmail"],
      })!;
      expect(gmailOnly).toContain("- mail (teamhub gmail list / read)");
      if (scene.contextKind === "meta") {
        expect(gmailOnly).toContain(
          "when this Run started, these apps had an account you can use: gmail",
        );
      }
      expect(gmailOnly).not.toContain("teamhub gcal");
      expect(gmailOnly).not.toContain("teamhub slack");
      expect(gmailOnly).not.toContain("other connected apps");
      const outlookOnly = renderComposed(scene, {
        ...fullDeployment,
        connectedAppKeys: ["outlook"],
      })!;
      expect(outlookOnly).toContain(
        "- calendar (teamhub outlook-calendar list / free / read)",
      );
      expect(outlookOnly).toContain("- mail (teamhub outlook list / read)");
      const outlookCalendar = renderComposed(scene, {
        ...fullDeployment,
        connectedAppKeys: ["outlook_calendar"],
      })!;
      expect(outlookCalendar).toContain(
        "- other connected apps (outlook_calendar): find a tool with teamhub apps search",
      );
      const both = renderComposed(scene, fullDeployment)!;
      expect(both).toContain("- calendar (teamhub gcal list / free / read)");
      const none = renderComposed(scene, defaultDeployment)!;
      expect(none).not.toContain("teamhub gmail");
      expect(none).toContain("- Tracking Items (teamhub tracking-items list)");
    },
  );

  it.each(scenes)(
    "leaves memory.md to the user-memory feature for %s",
    (_, scene) => {
      const prompt = render(scene);
      expect(prompt).not.toContain("Prefers evidence");
      expect(prompt).not.toContain("profile-data");
    },
  );

  it("renders deterministic compact personal context method significantly smaller than full", () => {
    const fullDirect = renderComposed(
      meta("general", "direct"),
      fullDeployment,
    )!;
    const compactDirect = renderComposed(
      meta("general", "direct"),
      compactDeployment,
    )!;
    const compactDirectRepeat = renderComposed(
      meta("general", "direct"),
      compactDeployment,
    )!;
    expect(compactDirect).toBe(compactDirectRepeat);
    expect(compactDirect.length).toBeLessThan(fullDirect.length * 0.4);
    expect(compactDirect).toContain("<personal-context-method>");
    expect(compactDirect).toContain(
      "- calendar (teamhub gcal list / free / read)",
    );
    expect(compactDirect).toContain("- mail (teamhub gmail list / read)");
    expect(compactDirect).toContain(
      "- web: prices, availability, schedules and public facts, checked now.",
    );
    expect(compactDirect).not.toContain("teamhub slack");

    const compactOutlook = renderComposed(meta("general", "direct"), {
      ...compactDeployment,
      connectedAppKeys: ["outlook"],
    })!;
    expect(compactOutlook).toContain(
      "- calendar (teamhub outlook-calendar list / free / read)",
    );
    expect(compactOutlook).toContain("- mail (teamhub outlook list / read)");
  });
});

describe("context-instructions feature", () => {
  it("contributes assembled instructions through the composed port", () => {
    const { context } = makeTestFeatureContext({
      roomKind: "direct",
      agent: { name: "Research Partner", instructions: "be helpful" },
    });
    const composed = composeContextFeatures({
      context,
      features: [createContextInstructionsFeature()],
    });
    expect(
      composed.contextInstructions({
        connectedApps: true,
        connectedAppKeys: [],
        connectableAppKeys: [],
        compactInstructions: false,
      }),
    ).toContain('"display_name":"Research Partner"');
  });
});
