import { AiChipIcon } from "@hugeicons/core-free-icons";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import { relativeTime } from "@/features/local-computer/computer-relative-time";
import { useDesktopComputer } from "@/features/local-computer/desktop-computer";
import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { formatBytes } from "@/lib/format-bytes";

import { AdvancedDialog } from "./local-model-details";
import { ModelRow } from "./local-model-row";
import {
  MakeRoomDialog,
  RemoveModelDialog,
  UnloadModelDialog,
} from "./local-model-dialogs";
import { actionErrorCopy, libraryUnavailableCopy } from "./local-models-copy";
import {
  actOnLocalComputerModel,
  localModelActionMutationKey,
  localModelsQueryKey,
  localModelsQueryOptions,
  type LocalModelActionInput,
  type LocalModelsView,
} from "./local-models-queries";
import {
  loadCheck,
  memorySummary,
  modelEntries,
  type ModelEntry,
  type ModelStatus,
} from "./local-models-rules";

type Dialog =
  | { kind: "advanced" }
  | { kind: "makeRoom"; modelId: string }
  | { kind: "remove"; modelId: string }
  | { kind: "unload"; modelId: string };

/** The model states each confirmed action applies to, as the row offers it. */
const actionStatuses: Record<"load" | "remove" | "unload", ModelStatus[]> = {
  load: ["idle", "failed"],
  remove: ["loaded", "idle", "failed"],
  unload: ["loaded"],
};

function computersPath(tenantId: string) {
  return `/t/${tenantId}/settings/computers`;
}

/**
 * The model library of one Computer, chosen by `?computer=`. Without it the
 * desktop app opens its own Computer and a browser the first one.
 */
export function LocalModelsPage() {
  const { client } = useTeamHubRuntime();
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const { data: inventory } = useSuspenseQuery(
    localComputersQueryOptions(client, tenantId),
  );
  const desktop = useDesktopComputer();
  const [searchParams, setSearchParams] = useSearchParams();
  const computers = inventory.items;
  const linkedId = searchParams.get("computer");
  const requestedId = linkedId ?? desktop?.status?.computerId;
  const owned = computers.find((item) => item.computer_id === requestedId);
  // A linked Computer the viewer does not own may be another member's: the
  // library API, not the owned inventory, decides whether they may read it.
  const sharedId = linkedId && !owned ? linkedId : undefined;
  const computer = sharedId ? undefined : (owned ?? computers[0]);

  function select(computerId: string) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("computer", computerId);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-(--app-settings-width) flex-col pb-4">
      {sharedId ? (
        <ComputerModels
          computerId={sharedId}
          computerPicker={null}
          key={sharedId}
          tenantId={tenantId}
        />
      ) : computer ? (
        <ComputerModels
          computerId={computer.computer_id}
          displayName={computer.display_name}
          computerPicker={
            computers.length > 1 ? (
              <Select
                aria-label="Computer"
                onValueChange={select}
                value={computer.computer_id}
                variant="pill"
              >
                {computers.map((item) => (
                  <SelectItem key={item.computer_id} value={item.computer_id}>
                    {item.status === "online"
                      ? item.display_name
                      : `${item.display_name} · Offline`}
                  </SelectItem>
                ))}
              </Select>
            ) : null
          }
          key={computer.computer_id}
          tenantId={tenantId}
        />
      ) : (
        <>
          <h1 className="text-2xl text-foreground">Local models</h1>
          <EmptyState title="No computers yet">
            Connect a computer in{" "}
            <Link
              className="text-foreground underline underline-offset-2"
              to={computersPath(tenantId)}
            >
              Computers
            </Link>{" "}
            to download and run models on it.
          </EmptyState>
        </>
      )}
    </main>
  );
}

function EmptyState({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section
      aria-label={title}
      className="mt-6 flex flex-col items-center px-4 pt-12 text-center"
    >
      <span className="flex size-16 items-center justify-center rounded-[20%] bg-muted text-foreground">
        <Icon icon={AiChipIcon} size={28} />
      </span>
      <h2 className="mt-6 text-xl">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {children}
      </p>
      {action}
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p
      className="mt-6 rounded-xl bg-muted px-3.5 py-3 text-sm text-muted-foreground"
      role="status"
    >
      {children}
    </p>
  );
}

function ComputerModels({
  computerId,
  computerPicker,
  displayName,
  tenantId,
}: {
  computerId: string;
  computerPicker: ReactNode;
  /** Absent for a Computer outside the viewer's own inventory. */
  displayName?: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const query = useQuery(localModelsQueryOptions(client, tenantId, computerId));
  const view = query.data;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const summary = view?.available ? memorySummary(view) : undefined;

  return (
    <>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl text-foreground">Local models</h1>
          {summary?.totalBytes ? (
            <p className="mt-1.5 text-sm text-muted-foreground">
              {formatBytes(summary.usedBytes)} of{" "}
              {formatBytes(summary.totalBytes)}{" "}
              {summary.gpu ? "GPU memory" : "memory"} in use
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {computerPicker}
          {view?.available ? (
            <Button
              onClick={() => setDialog({ kind: "advanced" })}
              size="compact"
            >
              Details
            </Button>
          ) : null}
        </div>
      </header>

      {view ? (
        <Library
          dialog={dialog}
          setDialog={setDialog}
          tenantId={tenantId}
          view={view}
        />
      ) : query.isError ? (
        <EmptyState
          action={
            <Button
              className="mt-6"
              onClick={() => void query.refetch()}
              size="compact"
            >
              Try again
            </Button>
          }
          title={`Couldn't load the models of ${displayName ?? "this computer"}`}
        >
          {actionErrorCopy(
            query.error instanceof TeamHubError ? query.error.code : undefined,
          )}
        </EmptyState>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground" role="status">
          Loading models
        </p>
      )}
    </>
  );
}

function Library({
  dialog,
  setDialog,
  tenantId,
  view,
}: {
  dialog: Dialog | null;
  setDialog: (dialog: Dialog | null) => void;
  tenantId: string;
  view: LocalModelsView;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const computerId = view.computer.computer_id;
  const name = view.computer.display_name;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    code?: string;
    modelId: string;
  } | null>(null);
  const mutationKey = localModelActionMutationKey(tenantId, computerId);
  const action = useMutation({
    mutationFn: (input: LocalModelActionInput) =>
      actOnLocalComputerModel(client, tenantId, computerId, input),
    mutationKey,
    onError: (error, input) =>
      setFailure({
        code: error instanceof TeamHubError ? error.code : undefined,
        modelId: input.modelId,
      }),
    onMutate: () => setFailure(null),
    // The Computer answers at once; a fresh read shows what it started even
    // before its next snapshot hint.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: localModelsQueryKey(tenantId, computerId),
      }),
  });
  const pendingIds = new Set(
    useMutationState({
      filters: { mutationKey, status: "pending" },
      select: (mutation) =>
        (mutation.state.variables as LocalModelActionInput | undefined)
          ?.modelId,
    }),
  );
  const offline = view.computer.status === "offline";
  const readOnly = !view.viewer_is_owner;
  // A dialog stays open across snapshots, so its confirm checks the model
  // and Computer as they are now, the way the row's buttons do.
  const confirmable = (
    entry: ModelEntry,
    action: "load" | "remove" | "unload",
  ) =>
    !offline &&
    !readOnly &&
    !pendingIds.has(entry.model.id) &&
    actionStatuses[action].includes(entry.status);
  const entries = view.available ? modelEntries(view) : [];
  const find = (modelId: string) =>
    entries.find((entry) => entry.model.id === modelId);
  const dialogEntry =
    dialog && dialog.kind !== "advanced" ? find(dialog.modelId) : undefined;
  const makeRoom =
    dialog?.kind === "makeRoom" && dialogEntry
      ? loadCheck(view, dialogEntry.model)
      : null;
  const failedEntry = failure ? find(failure.modelId) : undefined;

  function act(input: LocalModelActionInput) {
    setDialog(null);
    action.mutate(input);
  }

  function load(entry: ModelEntry) {
    if (loadCheck(view, entry.model))
      setDialog({ kind: "makeRoom", modelId: entry.model.id });
    else act({ action: "load", modelId: entry.model.id });
  }

  function unload(entry: ModelEntry) {
    if (entry.used_by.length)
      setDialog({ kind: "unload", modelId: entry.model.id });
    else act({ action: "unload", modelId: entry.model.id });
  }

  const unavailable = view.available
    ? undefined
    : libraryUnavailableCopy(view.reason?.code, name);

  return (
    <>
      {offline ? (
        <Notice>
          <span className="text-foreground">
            {name} is offline
            {view.computer.last_seen_at
              ? ` (last seen ${relativeTime(view.computer.last_seen_at)})`
              : ""}
            .
          </span>{" "}
          This is what it last reported.
          {readOnly ? null : (
            <>
              {" "}
              Reconnect it in{" "}
              <Link
                className="text-foreground underline underline-offset-2"
                to={computersPath(tenantId)}
              >
                Computers
              </Link>{" "}
              to manage its models.
            </>
          )}
        </Notice>
      ) : null}
      {readOnly ? (
        <Notice>
          Only the person who connected {name} can download, load or remove its
          models.
        </Notice>
      ) : null}

      {unavailable ? (
        <EmptyState title={unavailable.title}>{unavailable.body}</EmptyState>
      ) : (
        <>
          {failure ? (
            <div className="mt-6">
              <FormFeedback tone="danger">
                {failedEntry ? `${failedEntry.model.name}: ` : null}
                {actionErrorCopy(failure.code)}
              </FormFeedback>
            </div>
          ) : null}
          <section aria-label="Models" className="mt-6 grid gap-2">
            {entries.map((entry) => {
              const modelId = entry.model.id;
              return (
                <ModelRow
                  disabled={offline || readOnly || pendingIds.has(modelId)}
                  entry={entry}
                  expanded={expandedId === modelId}
                  key={modelId}
                  onCancel={() => act({ action: "cancel", modelId })}
                  onDownload={() => act({ action: "download", modelId })}
                  onLoad={() => load(entry)}
                  onRemove={() => setDialog({ kind: "remove", modelId })}
                  onToggle={() =>
                    setExpandedId((current) =>
                      current === modelId ? null : modelId,
                    )
                  }
                  onUnload={() => unload(entry)}
                  view={view}
                />
              );
            })}
          </section>
        </>
      )}

      {dialog?.kind === "advanced" ? (
        <AdvancedDialog onClose={() => setDialog(null)} view={view} />
      ) : null}
      {dialogEntry && makeRoom ? (
        <MakeRoomDialog
          check={makeRoom}
          disabled={!confirmable(dialogEntry, "load")}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={(unloadFirst) =>
            act({
              action: "load",
              modelId: dialogEntry.model.id,
              unloadFirst,
            })
          }
          view={view}
        />
      ) : null}
      {dialogEntry && dialog?.kind === "unload" ? (
        <UnloadModelDialog
          disabled={!confirmable(dialogEntry, "unload")}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            act({ action: "unload", modelId: dialogEntry.model.id })
          }
          view={view}
        />
      ) : null}
      {dialogEntry && dialog?.kind === "remove" ? (
        <RemoveModelDialog
          disabled={!confirmable(dialogEntry, "remove")}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            act({ action: "remove", modelId: dialogEntry.model.id })
          }
          view={view}
        />
      ) : null}
    </>
  );
}
