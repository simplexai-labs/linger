import { useQuery, useQueryClient } from "@tanstack/react-query";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubRoomBackgroundTask } from "@/features/teamhub/teamhub-types";

const EMPTY_BACKGROUND_TASKS: readonly TeamHubRoomBackgroundTask[] = [];

export function roomBackgroundTasksQueryKey(tenantId: string, roomId: string) {
  return ["teamhub", tenantId, roomId, "background-tasks"] as const;
}

/**
 * The background Tasks this Room's Meta delegated that are still running. A
 * new Task arrives with the Room's work_item.changed event; while any run,
 * the list is polled so a finished one leaves it.
 */
export function useRoomBackgroundTasks({
  client,
  roomId,
  tenantId,
}: {
  client: TeamHubClient;
  roomId: string;
  tenantId: string;
}) {
  const tasks = useQuery({
    queryKey: roomBackgroundTasksQueryKey(tenantId, roomId),
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/rooms/{roomId}/background-tasks", {
          params: { path: { roomId } },
        }),
      ),
    enabled: Boolean(roomId),
    refetchInterval: (query) =>
      query.state.data?.items.length ? 10_000 : false,
  });
  return tasks.data?.items ?? EMPTY_BACKGROUND_TASKS;
}

/**
 * Cancels one of this Room's background Tasks, as its list and the Task's
 * conversation both offer. It settles once the list has refreshed.
 */
export function useCancelRoomBackgroundTask({
  client,
  roomId,
  tenantId,
}: {
  client: TeamHubClient;
  roomId: string;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  return async (taskId: string) => {
    await teamHubData(
      client.api.POST("/v0/rooms/{roomId}/background-tasks/{taskId}/cancel", {
        params: { path: { roomId, taskId } },
      }),
    );
    await queryClient.invalidateQueries({
      queryKey: roomBackgroundTasksQueryKey(tenantId, roomId),
    });
  };
}
