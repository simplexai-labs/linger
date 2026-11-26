import { HashtagIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { lazy, Suspense, useState } from "react";
import { useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";

import { requireRoomRouteParam } from "./room-route-params";
import { roomSurfaceMessages } from "./room-surface.messages";

// Opened on demand, so it stays off the initial JavaScript graph.
const RoomCreator = lazy(async () => ({
  default: (await import("./room-creator")).RoomCreator,
}));

export function RoomEmptyPage() {
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const [createOpen, setCreateOpen] = useState(false);
  const t = useT();

  return (
    <main className="flex flex-1 items-center justify-center bg-app-surface p-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon icon={HashtagIcon} size={20} />
        </span>
        <h1 className="mt-4 text-lg">
          {t(roomSurfaceMessages.createFirstRoom)}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(roomSurfaceMessages.firstRoomBody)}
        </p>
        <Button
          className="mt-5"
          onClick={() => setCreateOpen(true)}
          tone="primary"
        >
          <Icon icon={PlusSignIcon} size={16} />
          {t(roomSurfaceMessages.createRoom)}
        </Button>
      </div>
      {createOpen ? (
        <Suspense fallback={null}>
          <RoomCreator
            onClose={() => setCreateOpen(false)}
            tenantId={tenantId}
          />
        </Suspense>
      ) : null}
    </main>
  );
}
