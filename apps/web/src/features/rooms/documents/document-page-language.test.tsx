import { useLayoutEffect } from "react";
import { materializeRoomDocument } from "@linger/document-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LibraryLayout } from "@/features/library/library-layout";
import type {
  TeamHubDocumentHistoryContent,
  TeamHubDocumentHistoryEntry,
} from "@/features/teamhub/teamhub-types";
import {
  TeamHubRuntimeProvider,
  type TeamHubRuntime,
} from "@/features/teamhub/teamhub-runtime";
import { resetLanguageForTest, setLanguage } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";
import { formatDateTime } from "@/lib/date-format";
import {
  createDocumentTestRuntime,
  seedNativeDocument,
} from "@/test/document-scenarios";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { UnifiedDocumentPage } from "./room-document-surface";
import { UnifiedDocumentTimelineDialog } from "./unified-document-timeline-dialog";

const page = zhCN.documentPage;

vi.mock("@/features/rooms/files/pdf-preview-adapter-loader", () => ({
  PdfPreviewAdapterLoader: () => <div>PDF preview</div>,
}));

vi.mock("./room-document-collaboration", async (importOriginal) => {
  const { openLocalDocumentSession } =
    await import("@/test/local-document-session");
  return {
    ...(await importOriginal<typeof import("./room-document-collaboration")>()),
    openRoomDocumentSession: vi.fn(openLocalDocumentSession),
  };
});

vi.mock("./room-document-blocknote-editor-loader", () => ({
  RoomDocumentBlockNoteEditor: ({
    onCanvasTargetChange,
  }: {
    onCanvasTargetChange?: (target?: string) => void;
  }) => {
    // Like the real editor, report the body's canvas target once mounted.
    useLayoutEffect(
      () => onCanvasTargetChange?.(undefined),
      [onCanvasTargetChange],
    );
    return <div className="bn-editor">Room BlockNote editor</div>;
  },
}));

function renderDocumentPage(runtime: TeamHubRuntime, documentId: string) {
  const router = createMemoryRouter(
    [
      {
        element: <LibraryLayout />,
        children: [
          {
            element: <UnifiedDocumentPage />,
            path: "/t/:tenantId/documents/:documentId",
          },
        ],
      },
    ],
    { initialEntries: [`/t/tenant-northstar/documents/${documentId}`] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("the Document page in the language on screen", () => {
  afterEach(() => {
    resetLanguageForTest();
  });

  it("words the header, the actions menu and Page history in Chinese", async () => {
    await setLanguage("zh-CN");
    const runtime = createDocumentTestRuntime();
    const document = seedNativeDocument(runtime, "language-page-document");

    renderDocumentPage(runtime, document.id);

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    expect(screen.getByRole("button", { name: page.comments })).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: page.breadcrumb }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: page.documentMode }),
    ).toHaveTextContent(new RegExp(`${page.editMode}|${page.readMode}`));

    fireEvent.click(screen.getByRole("button", { name: page.moreActions }));
    expect(
      await screen.findByRole("menuitem", { name: zhCN.common.delete }),
    ).toHaveAttribute("data-voice-risk", "never");
    fireEvent.click(screen.getByRole("menuitem", { name: page.pageHistory }));

    const dialog = await screen.findByRole("dialog", {
      name: page.pageHistory,
    });
    expect(
      within(dialog).getByRole("heading", { name: page.pageHistory }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: page.closePageHistory }),
    ).toHaveAttribute("data-voice-close");
    expect(await within(dialog).findByText(page.noPageHistory)).toBeVisible();
  });

  it("dates checkpoints in Chinese and marks Restore as a decision", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    const state = await materializeRoomDocument({
      materializationId: "language-history",
      schemaVersion: 1,
      sourceBytes: new TextEncoder().encode("# Release notes\n\nA line."),
      sourceKind: "markdown",
    });
    const actor = {
      display_name: "Jenny Bin",
      id: "actor-jenny",
      kind: "human" as const,
      tenant_id: "tenant-northstar",
    };
    const entry: TeamHubDocumentHistoryEntry = {
      contributors: [actor],
      created_at: "2026-08-27T12:00:00.000Z",
      created_by: actor,
      document_id: "document-language-history",
      id: "history-language",
      persisted_seq: 1,
      revision_id: "revision-language",
      trigger: "manual",
    };
    runtime.server.on("GET", "/v0/documents/{documentId}/history", () => ({
      items: [entry],
      page: { has_more: false },
    }));
    runtime.server.on(
      "GET",
      "/v0/document-history/{historyEntryId}/content",
      (): TeamHubDocumentHistoryContent => ({
        asset_manifest: [],
        full_state_fingerprint: state.bytesSha256,
        history_entry: entry,
        state_bytes: btoa(String.fromCharCode(...state.stateBytes)),
        state_bytes_sha256: state.bytesSha256,
        state_vector: "",
      }),
    );

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <UnifiedDocumentTimelineDialog
          client={runtime.client}
          documentId={entry.document_id}
          onClose={() => undefined}
          tenantId="tenant-northstar"
        />
      </QueryClientProvider>,
    );

    const restore = await screen.findByRole("button", {
      name: page.restoreCheckpoint,
    });
    expect(restore).toHaveAttribute("data-voice-risk", "confirm");
    const date = formatDateTime(
      entry.created_at,
      { dateStyle: "medium", timeStyle: "short" },
      "zh-CN",
    );
    expect(date).not.toBe(
      formatDateTime(
        entry.created_at,
        { dateStyle: "medium", timeStyle: "short" },
        "en-US",
      ),
    );
    expect(screen.getAllByText(date).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("region", { name: page.historyPreview }),
    ).toBeVisible();
  });
});
