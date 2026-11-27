// Tells the computer the Human is looking at a Room, as the Web does, while
// its chat is on screen and the app is in the foreground. The computer holds
// back pushes for a Room someone is looking at, and gets its Agents ready.
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { AppState } from "react-native";

import { notifyRoomPresence } from "../api/teamhub";
import { useTeamHub } from "../state/queries";

/** The Web's heartbeat; the computer counts a Room as watched for 30 s. */
const HEARTBEAT_MS = 20_000;

export function useRoomPresence(roomId: string): void {
  const teamHub = useTeamHub();
  useFocusEffect(
    useCallback(() => {
      if (!teamHub.connected) return;
      const send = () => {
        if (AppState.currentState !== "active") return;
        void teamHub
          .run((session) => notifyRoomPresence(session, roomId))
          .catch(() => undefined);
      };
      send();
      const timer = setInterval(send, HEARTBEAT_MS);
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active") send();
      });
      return () => {
        clearInterval(timer);
        appState.remove();
      };
    }, [roomId, teamHub]),
  );
}
