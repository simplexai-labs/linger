import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { Field } from "@/components/ui/field";
import { GlobalSearchField } from "@/features/search/global-search-sections";
import { BackgroundTasksPill } from "./background-tasks-indicator";
import { JumpToLatestButton } from "./jump-to-latest-button";
import { AgentStreamingStatusDock } from "./message-timeline";
import { RoomComposerDock } from "./room-composer-dock";

const globalStyles = readFileSync(
  resolve(import.meta.dirname, "../../../app/globals.css"),
  "utf8",
).replace(/^@import .*;$/gm, "");
const markdownStyles = readFileSync(
  resolve(import.meta.dirname, "./message-markdown.css"),
  "utf8",
);
const modelSwitchStyles = readFileSync(
  resolve(import.meta.dirname, "./direct-agent-model-switch.css"),
  "utf8",
);

let stylesheet: HTMLStyleElement;

beforeEach(() => {
  stylesheet = document.createElement("style");
  stylesheet.textContent = `${globalStyles}\n${markdownStyles}\n${modelSwitchStyles}`;
  document.head.append(stylesheet);
});

describe("narrow chat layout contracts", () => {
  it("gives every Message row the full lane and top-strip actions below 768px", () => {
    const narrowRules = mediaStyleRules(
      stylesheet.sheet!.cssRules,
      "(max-width: 767px)",
    );
    const reserve = narrowRules.find(
      (rule) =>
        normalizeSelector(rule.selectorText) ===
        ".room-message-card[data-current-actor]",
    );
    expect(
      reserve?.style.getPropertyValue("--message-actions-room").trim(),
    ).toBe("0px");

    const actions = narrowRules.find(
      (rule) =>
        normalizeSelector(rule.selectorText) ===
        ".room-message-card.message-row[data-current-actor] :is(.room-message-body-line, .room-message-bubble) > .message-row-actions",
    );
    expect(actions?.style.right).toBe("0px");
    expect(actions?.style.left).toBe("auto");
    expect(actions?.style.transform).toBe("none");

    const fineHeaderRoom = narrowRules.find(
      (rule) =>
        normalizeSelector(rule.selectorText) ===
        '.room-message-card[data-current-actor="false"] .room-message-header',
    );
    expect(fineHeaderRoom?.style.paddingRight).toBe("84px");

    const coarseNarrowRules = mediaStyleRules(
      stylesheet.sheet!.cssRules,
      "(max-width: 767px) and (pointer: coarse)",
    );
    const coarseHeaderRoom = coarseNarrowRules.find(
      (rule) =>
        normalizeSelector(rule.selectorText) ===
        '.room-message-card[data-current-actor="false"] .room-message-header',
    );
    expect(coarseHeaderRoom?.style.paddingRight).toBe("132px");

    const continuationRoom = narrowRules.find((rule) =>
      normalizeSelector(rule.selectorText).includes(
        '[data-group-start="false"]',
      ),
    );
    expect(continuationRoom?.selectorText).toContain(
      '.room-message-card[data-current-actor="true"][data-group-start]',
    );
    expect(continuationRoom?.style.paddingTop).toBe("32px");

    const orderedList = narrowRules.find(
      (rule) => normalizeSelector(rule.selectorText) === ".message-markdown ol",
    );
    expect(orderedList?.style.marginLeft).toBe("24px");
  });

  it("marks the status dock, jump button, and background-tasks pill with data attributes for dock clearance", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <div className="room-chat-column">
          <div className="relative">
            <JumpToLatestButton agentWorking onClick={() => undefined} />
          </div>
          <RoomComposerDock
            onRetry={() => undefined}
            state={{
              deleted: false,
              directoryUnavailable: false,
              runtimeIssue: undefined,
              runtimeStatusUnavailable: false,
            }}
          >
            <BackgroundTasksPill
              tasks={[
                {
                  created_at: "2026-10-28T14:27:00Z",
                  id: "task-1",
                  requirement: "Check narrow layout.",
                  title: "Audit phone widths",
                },
              ]}
            />
            <AgentStreamingStatusDock
              cancelRoomRun={async () => ({
                agent_actor_id: "actor-sol",
                message_ids: [],
                run_id: "run-1",
                status: "cancel_requested",
              })}
              runStatuses={[
                {
                  agent: {
                    display_name: "Sol",
                    id: "actor-sol",
                    kind: "agent",
                  },
                  created_at: "2026-10-28T14:28:00Z",
                  id: "run-1",
                  replied: false,
                  revision: 1,
                  room_id: "room-1",
                  run_id: "run-1",
                  status: "active",
                  updated_at: "2026-10-28T14:28:00Z",
                },
              ]}
              scopeKey={["room-1"]}
            />
          </RoomComposerDock>
        </div>
      </QueryClientProvider>,
    );

    const dock = screen.getByTestId("agent-streaming-status-dock");
    const jump = screen.getByRole("button", {
      name: "Jump to latest messages",
    });
    const pill = screen
      .getByRole("button", { name: "1 task running in the background" })
      .closest("[data-background-tasks-pill]");

    expect(dock).toHaveAttribute("data-streaming-status-dock");
    expect(jump).toHaveAttribute("data-jump-to-latest");
    expect(pill).not.toBeNull();
    expect(
      container.querySelector(
        ".room-chat-column:has([data-streaming-status-dock]) [data-jump-to-latest]",
      ),
    ).toBe(jump);
    expect(
      container.querySelector(
        ".room-composer-dock:has([data-streaming-status-dock]) [data-background-tasks-pill]",
      ),
    ).toBe(pill);

    const allRules = styleRules(stylesheet.sheet!.cssRules);
    const pillLiftRule = allRules.find(
      (rule) =>
        normalizeSelector(rule.selectorText) ===
        ".room-composer-dock:has([data-streaming-status-dock]) [data-background-tasks-pill]",
    );
    expect(pillLiftRule?.style.bottom).toBe(
      "calc(0.5rem + var(--streaming-dock-lift, 2rem))",
    );

    const jumpLiftRule = allRules.find(
      (rule) =>
        normalizeSelector(rule.selectorText) ===
        ":is(.room-chat-column, .room-thread-panel):has([data-streaming-status-dock]) [data-jump-to-latest]",
    );
    expect(jumpLiftRule?.style.bottom).toBe(
      "calc(0.75rem + var(--streaming-dock-lift, 2rem))",
    );

    const stackedLiftRule = allRules.find(
      (rule) =>
        normalizeSelector(rule.selectorText) ===
        ":is(.room-chat-column, .room-thread-panel):has([data-streaming-status-dock]):has([data-background-tasks-pill]) [data-jump-to-latest]",
    );
    expect(stackedLiftRule?.style.bottom).toBe(
      "calc(2.75rem + var(--streaming-dock-lift, 2rem))",
    );

    const narrowTouchRules = mediaStyleRules(
      stylesheet.sheet!.cssRules,
      "(pointer: coarse), (max-width: 47.999rem)",
    );
    const dockLiftVarRule = narrowTouchRules.find(
      (rule) =>
        normalizeSelector(rule.selectorText) ===
        ":is(.room-chat-column, .room-thread-panel)",
    );
    expect(
      dockLiftVarRule?.style.getPropertyValue("--streaming-dock-lift").trim(),
    ).toBe("2.75rem");
    expect(
      allRules.some(
        (rule) =>
          (rule.selectorText.includes("data-streaming-status-dock") ||
            rule.style.getPropertyValue("--streaming-dock-lift").trim() !==
              "") &&
          normalizeSelector(rule.selectorText).includes("aside"),
      ),
    ).toBe(false);
  });

  it("scopes thread dock clearance to .room-thread-panel so sibling tabs inside aside.panel-sidebar do not bleed", () => {
    const threadPanelSource = readFileSync(
      resolve(import.meta.dirname, "./thread-panel.tsx"),
      "utf8",
    );
    expect(threadPanelSource).toMatch(/<aside[\s\S]*?room-thread-panel/);

    const { container } = render(
      <aside className="panel-sidebar">
        <aside className="room-thread-panel" hidden>
          <div data-streaming-status-dock="" />
        </aside>
        <aside className="room-thread-panel">
          <JumpToLatestButton agentWorking={false} onClick={() => undefined} />
        </aside>
      </aside>,
    );

    expect(
      container.querySelector(
        ":is(.room-chat-column, .room-thread-panel):has([data-streaming-status-dock]) [data-jump-to-latest]",
      ),
    ).toBeNull();

    const { container: ownDockContainer } = render(
      <aside className="panel-sidebar">
        <aside className="room-thread-panel">
          <div data-streaming-status-dock="" />
          <JumpToLatestButton agentWorking={false} onClick={() => undefined} />
        </aside>
      </aside>,
    );

    expect(
      ownDockContainer.querySelector(
        ":is(.room-chat-column, .room-thread-panel):has([data-streaming-status-dock]) [data-jump-to-latest]",
      ),
    ).not.toBeNull();
  });

  it("lets the model picker shrink and applies 16px touch text to Field and global search inputs", () => {
    const rules = styleRules(stylesheet.sheet!.cssRules);
    const modelRoot = rules.find(
      (rule) => normalizeSelector(rule.selectorText) === ".agent-model-switch",
    );
    const modelTrigger = rules.find(
      (rule) =>
        normalizeSelector(rule.selectorText) === ".agent-model-switch-trigger",
    );
    expect(modelRoot?.style.minWidth).toBe("0px");
    expect(modelTrigger?.style.minWidth).toBe("0px");
    expect(modelTrigger?.style.maxWidth).toBe("min(220px, 100%)");

    render(
      <>
        <Field label="Room name" />
        <GlobalSearchField
          activeIndex={0}
          enterScope={() => undefined}
          inputRef={createRef()}
          onClose={() => undefined}
          onInputKeyDown={() => undefined}
          onQueryChange={() => undefined}
          pending={false}
          query=""
          rowCount={0}
          scope={undefined}
          tab="all"
        />
      </>,
    );
    expect(screen.getByLabelText("Room name")).toHaveClass("ui-field-control");
    expect(
      screen.getByRole("combobox", {
        name: "Search messages, docs, people, agents and rooms",
      }),
    ).toHaveClass("global-search-input");

    const touchRules = mediaStyleRules(
      stylesheet.sheet!.cssRules,
      "(pointer: coarse), (max-width: 47.999rem)",
    );
    const touchFontRule = touchRules.find((rule) =>
      normalizeSelector(rule.selectorText).includes(".global-search-input"),
    );
    expect(touchFontRule?.selectorText).toContain(".ui-field-control");
    expect(touchFontRule?.style.fontSize).toBe("16px");
  });
});

function normalizeSelector(selector: string): string {
  return selector
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function styleRules(rules: CSSRuleList): CSSStyleRule[] {
  return Array.from(rules).flatMap((rule) => {
    if (rule instanceof CSSStyleRule) return [rule];
    if ("cssRules" in rule)
      return styleRules((rule as CSSGroupingRule).cssRules);
    return [];
  });
}

function mediaStyleRules(rules: CSSRuleList, media: string): CSSStyleRule[] {
  return Array.from(rules).flatMap((rule) => {
    if (rule instanceof CSSMediaRule && rule.conditionText === media) {
      return styleRules(rule.cssRules);
    }
    return [];
  });
}
