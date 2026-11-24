import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPlacementFields } from "./agent-placement-fields";
import type { useLocalRuntimeSelection } from "./use-local-runtime-selection";

function emptySelection(): ReturnType<typeof useLocalRuntimeSelection> {
  return {
    computers: [],
    computer: undefined,
    runtime: undefined,
    runtimeDiagnostic: undefined,
    isPending: false,
    error: null,
    refetch: vi.fn(async () => undefined),
    selectComputer: vi.fn(),
    selectRuntime: vi.fn(),
  } as unknown as ReturnType<typeof useLocalRuntimeSelection>;
}

describe("AgentPlacementFields", () => {
  afterEach(() => {
    delete (window as { lingerDesktop?: unknown }).lingerDesktop;
  });

  it("hides CLI setup commands when running against the desktop app's own local server", async () => {
    const available = vi.fn(async () => true);
    (window as { lingerDesktop?: unknown }).lingerDesktop = {
      localAccount: { available },
    };

    render(
      <AgentPlacementFields
        onSelectionChange={vi.fn()}
        selection={emptySelection()}
      />,
    );

    await vi.waitFor(() => expect(available).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Retry Local Computers" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Connect a Local Computer" }),
    ).not.toBeInTheDocument();
  });

  it("shows CLI setup commands in a browser when no Computer is online", () => {
    render(
      <AgentPlacementFields
        onSelectionChange={vi.fn()}
        selection={emptySelection()}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Connect a Local Computer" }),
    ).toBeVisible();
  });
});
