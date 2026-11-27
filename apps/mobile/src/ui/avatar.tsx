// Avatars as the desktop draws them: an Agent is a rounded square with its
// character (or uploaded image) on its own background, a Human a soft circle
// with initials.
import { useQuery } from "@tanstack/react-query";
import { Image, StyleSheet, View } from "react-native";

import { agentAvatarImage } from "../api/teamhub";
import type { ActorRef } from "../api/types";
import { toBase64 } from "../lib/bytes";
import { teamHubKey, useAgentLooks, useTeamHub } from "../state/queries";
import { colors } from "../theme";
import { AGENT_FIGURE_IMAGES } from "./agent-figure-images.generated";
import { avatarAppearance, initials } from "./avatar-key";
import { Text } from "./text";

function useUploadedImage(url: string | undefined): string | undefined {
  const teamHub = useTeamHub();
  const image = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "agent-avatar-image", url),
    enabled: teamHub.connected && !!url,
    // The URL carries the image version, so one fetch per version is enough.
    staleTime: Infinity,
    queryFn: async () => {
      const file = await teamHub.run((session) =>
        agentAvatarImage(session, url ?? ""),
      );
      return `data:${file.contentType};base64,${toBase64(file.bytes)}`;
    },
  });
  return image.data;
}

/** The background an Agent's avatar is drawn on, its brand color. */
export function useAgentBrand(actorId: string | undefined): string | undefined {
  const look = useAgentLooks().get(actorId ?? "");
  return actorId ? avatarAppearance(look?.avatarKey, actorId).color : undefined;
}

export function AgentAvatar(props: {
  readonly actorId: string;
  readonly size?: number;
  /** Overrides the 20% corner, such as a tile set flush in a card. */
  readonly radius?: number;
}) {
  const size = props.size ?? 28;
  const look = useAgentLooks().get(props.actorId);
  const appearance = avatarAppearance(look?.avatarKey, props.actorId);
  const uploaded = useUploadedImage(
    appearance.kind === "image" ? look?.avatarImageUrl : undefined,
  );
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          // An Agent is a square with 20% corners; a person is a circle.
          borderRadius: props.radius ?? Math.round(size * 0.2),
          backgroundColor: appearance.color,
        },
      ]}
    >
      <Image
        source={
          uploaded ? { uri: uploaded } : AGENT_FIGURE_IMAGES[appearance.figure]
        }
        style={styles.fill}
      />
    </View>
  );
}

export function HumanAvatar(props: {
  readonly name: string;
  readonly size?: number;
  readonly radius?: number;
}) {
  const size = props.size ?? 28;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.human,
        { width: size, height: size, borderRadius: props.radius ?? size / 2 },
      ]}
    >
      <Text style={[styles.initials, { fontSize: Math.round(size * 0.4) }]}>
        {initials(props.name)}
      </Text>
    </View>
  );
}

export function ActorAvatar(props: {
  readonly actor: Pick<ActorRef, "id" | "kind" | "display_name">;
  readonly size?: number;
  /** Overrides the shape's corner, such as a tile inside a group stack. */
  readonly radius?: number;
}) {
  return props.actor.kind === "agent" ? (
    <AgentAvatar
      actorId={props.actor.id}
      size={props.size}
      radius={props.radius}
    />
  ) : (
    <HumanAvatar
      name={props.actor.display_name}
      size={props.size}
      radius={props.radius}
    />
  );
}

const styles = StyleSheet.create({
  tile: { overflow: "hidden" },
  fill: { width: "100%", height: "100%" },
  human: {
    backgroundColor: colors.sidebarMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { fontWeight: "600", color: colors.secondary },
});
