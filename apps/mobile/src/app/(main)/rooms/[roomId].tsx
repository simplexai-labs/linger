// Any other Room's conversation: a direct Agent chat puts the Agent on
// stage, a group shows its members.
import { useLocalSearchParams } from "expo-router";

import { AgentStage, GroupStage } from "../../../chat/agent-stage";
import { ChatRoom } from "../../../chat/chat-room";
import { useTranslation } from "../../../i18n/use-translation";
import { roomsMessages as m } from "../../../screens/rooms.messages";
import { useDirectAgent, useRoom } from "../../../state/queries";

export default function RoomScreen() {
  const { t } = useTranslation();
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const room = useRoom(roomId);
  const agent = useDirectAgent(roomId);
  const title =
    room.data?.name || room.data?.direct_peer?.display_name || t(m.room);
  return (
    <ChatRoom
      key={roomId}
      roomId={roomId}
      header={
        agent ? (
          <AgentStage
            roomId={roomId}
            agent={agent}
            idleLine={room.data?.description || undefined}
          />
        ) : (
          <GroupStage roomId={roomId} title={title} />
        )
      }
      runsInHeader={!!agent}
      placeholder={t(m.messagePlaceholder, { name: title })}
      emptyTitle={t(m.noMessages)}
    />
  );
}
