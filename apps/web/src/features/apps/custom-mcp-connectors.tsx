import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type {
  CustomMCPConnection,
  CustomMCPTool,
  TeamHubExternalSourceClient,
} from "@/features/teamhub/teamhub-external-source-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { connectorMessages as m } from "./connectors.messages";

export const customMCPQueryKey = ["teamhub", "custom-mcp-connections"] as const;

export function customMCPQueryOptions(client: TeamHubExternalSourceClient) {
  return {
    queryKey: customMCPQueryKey,
    queryFn: () => client.listCustomMCP(),
  };
}

export function CustomMCPSection({
  connections,
  onEdit,
}: {
  connections: CustomMCPConnection[];
  onEdit: (connection: CustomMCPConnection) => void;
}) {
  const t = useT();
  if (connections.length === 0) return null;
  return (
    <section className="mt-7" aria-label={t(m.customGroup)}>
      <h2 className="mb-2.5 text-sm font-medium text-muted-foreground">
        {t(m.customGroup)}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {connections.map((connection) => (
          <div
            key={connection.id}
            className="flex items-center gap-3 rounded-xl border p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{connection.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {connection.endpoint}
              </p>
            </div>
            <Button size="compact" onClick={() => onEdit(connection)}>
              {t(m.manage)}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

const inputClass = "w-full rounded-md border bg-background px-3 py-2";

export function CustomMCPDialog({
  connection,
  onClose,
}: {
  connection: CustomMCPConnection | null;
  onClose: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(connection?.name ?? "");
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? "");
  const [token, setToken] = useState("");
  const [keepToken, setKeepToken] = useState(connection?.has_token ?? false);
  const [tools, setTools] = useState<CustomMCPTool[] | undefined>(
    connection?.tools,
  );
  const [disconnect, setDisconnect] = useState(false);
  const retainToken = keepToken && endpoint.trim() === connection?.endpoint;
  const test = useMutation({
    mutationFn: () => client.testCustomMCP(endpoint.trim(), token),
    onSuccess: (result) => setTools(result.tools),
  });
  const save = useMutation({
    mutationFn: () =>
      client.saveCustomMCP({
        id: connection?.id,
        revision: connection?.revision,
        name: name.trim(),
        endpoint: endpoint.trim(),
        token: retainToken ? undefined : token,
      }),
    onSuccess: finish,
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.deleteCustomMCP(id),
    onSuccess: finish,
  });
  const pending = test.isPending || save.isPending || remove.isPending;
  const error = test.error ?? save.error ?? remove.error;

  async function finish() {
    await queryClient.invalidateQueries({ queryKey: customMCPQueryKey });
    onClose();
  }

  function resetPreview() {
    setTools(undefined);
    test.reset();
    save.reset();
  }

  return (
    <ModalDialog
      size="md"
      title={t(connection ? m.editCustomConnector : m.addCustomConnector)}
      onClose={onClose}
      footer={
        <>
          {connection ? (
            <Button
              disabled={pending}
              onClick={() =>
                disconnect ? remove.mutate(connection.id) : setDisconnect(true)
              }
            >
              {t(disconnect ? m.customConnectorDisconnect : m.disconnect)}
            </Button>
          ) : null}
          <Button onClick={onClose}>{t(commonMessages.cancel)}</Button>
          <Button
            tone="primary"
            disabled={pending || !name.trim() || !endpoint.trim() || disconnect}
            onClick={() => save.mutate()}
          >
            {t(commonMessages.save)}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-3" disabled={pending || disconnect}>
        <label className="block space-y-1 text-sm">
          <span>{t(m.customConnectorName)}</span>
          <input
            className={inputClass}
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t(m.customConnectorEndpoint)}</span>
          <input
            className={inputClass}
            type="url"
            maxLength={2048}
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              resetPreview();
            }}
          />
        </label>
        {connection?.has_token && endpoint.trim() === connection.endpoint ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={keepToken}
              onChange={(e) => {
                setKeepToken(e.target.checked);
                resetPreview();
              }}
            />
            {t(m.customConnectorKeepToken)}
          </label>
        ) : null}
        {!retainToken ? (
          <label className="block space-y-1 text-sm">
            <span>{t(m.customConnectorToken)}</span>
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              maxLength={8192}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                resetPreview();
              }}
            />
          </label>
        ) : null}
        {retainToken ? (
          <p className="text-sm text-muted-foreground">
            {t(m.customConnectorTestedOnSave)}
          </p>
        ) : (
          <Button disabled={!endpoint.trim()} onClick={() => test.mutate()}>
            {t(m.customConnectorTest)}
          </Button>
        )}
      </fieldset>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-app-danger">
          {error.message}
        </p>
      ) : null}
      {tools ? (
        <section
          className="mt-3 text-sm"
          aria-label={t(m.customConnectorToolList)}
        >
          <p className="font-medium">{t(m.customConnectorToolList)}</p>
          {tools.length ? (
            <ul className="max-h-40 overflow-y-auto">
              {tools.map((tool) => (
                <li key={tool.name}>{tool.name}</li>
              ))}
            </ul>
          ) : (
            <p>{t(m.customConnectorNoTools)}</p>
          )}
        </section>
      ) : null}
    </ModalDialog>
  );
}
