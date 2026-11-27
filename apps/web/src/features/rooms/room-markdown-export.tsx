import { useMutation } from "@tanstack/react-query";
import { Download01Icon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { useT } from "@/i18n/use-translation";

import { readRoomMessagePage } from "./room-queries";
import { roomSettingsMessages as m } from "./room-settings.messages";

function fencedBody(body: string) {
  // A fence longer than every tilde run keeps the entire original body literal.
  let fenceLength = 3;
  for (const [run] of body.matchAll(/~{3,}/gu)) {
    fenceLength = Math.max(fenceLength, run.length + 1);
  }
  const fence = "~".repeat(fenceLength);
  return `${fence}\n${body}${body.endsWith("\n") ? "" : "\n"}${fence}`;
}

function roomExportFilename(roomName: string, roomId: string) {
  const label = roomName.replace(/[\s\p{Cc}\\/:*?"<>|.-]+/gu, "-");
  const stem = [...label.replace(/^-/u, "")]
    .slice(0, 48)
    .join("")
    .replace(/-$/u, "");
  return stem ? `${stem}-${roomId}.md` : `${roomId}.md`;
}

export function RoomMarkdownExport({
  roomId,
  roomName,
  tenantId,
}: {
  roomId: string;
  roomName: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const download = useMutation({
    mutationFn: async () => {
      const { items } = await readRoomMessagePage(client, tenantId, roomId);
      if (!items.length) return "empty" as const;

      const entries = items.map((message) => {
        const author = message.author.display_name
          .replace(/\s+/gu, " ")
          .trim()
          .replace(/[\\`*_[\]<>#~&]/gu, "\\$&");
        return `## ${author} · ${message.created_at}\n\n${fencedBody(message.raw_message)}`;
      });
      const file = new Blob([entries.join("\n\n") + "\n"], {
        type: "text/markdown;charset=utf-8",
      });
      const { triggerArtifactDownload } =
        await import("./files/artifact-preview-loader");
      triggerArtifactDownload(file, roomExportFilename(roomName, roomId));
      return "downloaded" as const;
    },
  });

  return (
    <>
      <Button
        className="w-full"
        loading={download.isPending}
        onClick={() => download.mutate()}
      >
        <Icon icon={Download01Icon} size={16} />
        {t(m.exportRecentMessages)}
      </Button>
      {download.isError ? (
        <p role="alert" className="text-xs text-app-danger">
          {t(m.exportRecentMessagesFailed)}
        </p>
      ) : null}
      {download.data === "empty" ? (
        <p role="status" className="text-xs text-app-muted">
          {t(m.exportRecentMessagesEmpty)}
        </p>
      ) : null}
    </>
  );
}
