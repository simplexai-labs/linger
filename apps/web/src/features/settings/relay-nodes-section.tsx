import { Delete02Icon } from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/features/local-computer/computer-row";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import {
  addRelayNode,
  type RelayNode,
  relayNodesQueryKey,
  relayNodesQueryOptions,
  removeRelayNode,
  setRelayNodeEnabled,
} from "./phone-queries";
import { phonesMessages as m } from "./phones-settings.messages";

/**
 * The Relay nodes this computer keeps a link to. Phones away from its network
 * reach it through any enabled node and pick the fastest themselves; official
 * nodes can be turned off, custom ones also removed.
 */
export function RelayNodesSection() {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const nodes = useQuery(relayNodesQueryOptions(client));
  const [url, setUrl] = useState("");
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: relayNodesQueryKey() });
  const add = useMutation({
    mutationFn: () => addRelayNode(client, url.trim()),
    onSuccess: async () => {
      setUrl("");
      await invalidate();
    },
  });
  const addError =
    add.error instanceof TeamHubError && add.error.code === "INVALID_RELAY_URL"
      ? t(m.invalidRelayUrl)
      : add.error instanceof TeamHubError && add.error.code === "RELAY_EXISTS"
        ? t(m.relayExists)
        : add.error instanceof TeamHubError &&
            add.error.code === "TOO_MANY_RELAYS"
          ? t(m.tooManyRelays)
          : add.error?.message;

  return (
    <section
      aria-labelledby="relay-nodes-title"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <h2
          className="text-sm font-medium text-foreground"
          id="relay-nodes-title"
        >
          {t(m.relaysTitle)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(m.relaysDescription)}
        </p>
      </div>
      {nodes.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : nodes.isError ? (
        <div className="flex flex-col items-start gap-3">
          <FormFeedback tone="danger">{nodes.error.message}</FormFeedback>
          <Button onClick={() => void nodes.refetch()}>
            {t(commonMessages.retry)}
          </Button>
        </div>
      ) : (
        <>
          {nodes.data.links_off ? (
            <FormFeedback tone="warning">{t(m.relayLinksOff)}</FormFeedback>
          ) : null}
          <ul
            aria-label={t(m.relaysTitle)}
            className="divide-y divide-border rounded-2xl border border-border bg-background"
          >
            {nodes.data.items.map((node) => (
              <RelayNodeRow
                key={node.id}
                linksOff={nodes.data.links_off}
                node={node}
                onChanged={invalidate}
              />
            ))}
          </ul>
          <form
            className="flex items-start gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (url.trim()) add.mutate();
            }}
          >
            <Field
              autoCapitalize="none"
              autoComplete="off"
              className="flex-1"
              error={addError}
              label={t(m.relayUrlLabel)}
              onChange={(event) => {
                setUrl(event.target.value);
                add.reset();
              }}
              placeholder="ws://203.0.113.7:7787"
              spellCheck={false}
              value={url}
            />
            <Button
              className="mt-6"
              disabled={!url.trim()}
              loading={add.isPending}
              type="submit"
            >
              {t(m.addRelay)}
            </Button>
          </form>
        </>
      )}
    </section>
  );
}

function RelayNodeRow({
  linksOff,
  node,
  onChanged,
}: {
  linksOff: boolean;
  node: RelayNode;
  onChanged: () => Promise<unknown>;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      setRelayNodeEnabled(client, node.id, enabled),
    onSettled: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => removeRelayNode(client, node.id),
    onSettled: onChanged,
  });
  const state =
    !node.enabled || linksOff
      ? { tone: "neutral" as const, text: t(m.relayOff) }
      : node.connected
        ? { tone: "success" as const, text: t(m.relayConnected) }
        : { tone: "neutral" as const, text: t(m.relayConnecting) };
  return (
    <li className="flex items-center gap-3 px-6 py-4">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm text-foreground">
          <span className="truncate">{node.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(node.kind === "official" ? m.relayOfficial : m.relayCustom)}
          </span>
        </p>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <StatusDot tone={state.tone} />
          {state.text}
          <span aria-hidden>·</span>
          <span className="truncate font-mono text-xs">{node.url}</span>
        </p>
      </div>
      {node.kind === "custom" ? (
        <Button
          aria-label={t(m.removeRelay, { name: node.label })}
          data-voice-risk="never"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          size="compact"
          tone="ghost"
        >
          <Icon icon={Delete02Icon} size={16} />
        </Button>
      ) : null}
      <button
        aria-checked={node.enabled}
        aria-label={t(m.relayToggle, { name: node.label })}
        className={`relative h-4 w-7 shrink-0 rounded-full shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${node.enabled ? "bg-primary" : "bg-input"}`}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(!node.enabled)}
        role="switch"
        type="button"
      >
        <span
          className={`absolute left-0 top-0.5 size-3 rounded-full bg-card shadow-sm transition-transform duration-150 ${node.enabled ? "translate-x-3.5" : "translate-x-0.5"}`}
        />
      </button>
    </li>
  );
}
