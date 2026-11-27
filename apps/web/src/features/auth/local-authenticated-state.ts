import type { QueryClient } from "@tanstack/react-query";

import { clearLastModelsComputer } from "@/features/local-models/last-models-computer";
import { clearAllDismissedBackgroundFailures } from "@/features/rooms/chat/another-me-background-failure-dismissal";
import { clearRoomDrafts } from "@/features/rooms/room-drafts";
import { clearTeamHubQueries } from "@/features/rooms/room-queries";
import { clearGlobalSearchHistory } from "@/features/search/global-search-recent";

export function clearLocalAuthenticatedState(queryClient: QueryClient) {
  clearTeamHubQueries(queryClient);
  clearRoomDrafts();
  clearGlobalSearchHistory();
  clearLastModelsComputer();
  clearAllDismissedBackgroundFailures();
}
