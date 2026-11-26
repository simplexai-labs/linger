// Home: the direct chat with Another Me.
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AgentStage } from "../../chat/agent-stage";
import { ChatHeader, ChatRoom } from "../../chat/chat-room";
import { useTranslation } from "../../i18n/use-translation";
import { roomsMessages as m } from "../../screens/rooms.messages";
import { useAnotherMe, useDirectAgent, useTeamHub } from "../../state/queries";
import { colors } from "../../theme";
import { EmptyState } from "../../ui/controls";
import { StatusStrip } from "../../ui/status-strip";

export default function AnotherMeScreen() {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const anotherMe = useAnotherMe();
  const roomId = anotherMe.data?.room_id;
  const agent = useDirectAgent(roomId);
  const name = agent?.display_name ?? "Linger";
  if (roomId)
    return (
      <ChatRoom
        roomId={roomId}
        header={
          agent ? (
            <AgentStage roomId={roomId} agent={agent} record />
          ) : (
            <ChatHeader title={name} />
          )
        }
        runsInHeader={!!agent}
        placeholder={t(m.messagePlaceholder, { name })}
        emptyTitle={t(m.anotherMeEmpty, { name })}
      />
    );
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ChatHeader title={name} />
      <StatusStrip />
      {!teamHub.connected || anotherMe.isPending ? (
        <EmptyState title={t(m.waiting)} busy={teamHub.connected} />
      ) : anotherMe.isError ? (
        <EmptyState
          title={t(m.couldNotLoad, { name })}
          action={{
            label: t(m.tryAgain),
            onPress: () => void anotherMe.refetch(),
          }}
        />
      ) : (
        <EmptyState
          title={t(m.gettingReady, { name })}
          body={t(m.gettingReadyBody)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
});
