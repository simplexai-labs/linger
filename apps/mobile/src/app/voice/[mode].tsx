// Full-screen voice: Live with Another Me, or a meeting recording.

import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";

import { isVoiceMode, takeLiveArm } from "../../voice";
import { LiveScreen } from "../../voice/live-screen";
import { RecordScreen } from "../../voice/record-screen";

export default function VoiceScreen() {
  const params = useLocalSearchParams<{ mode: string; roomId?: string }>();
  const [armed] = useState(takeLiveArm);
  const known = isVoiceMode(params.mode);
  useEffect(() => {
    if (!known) router.back();
  }, [known]);
  if (!known) return null;
  if (params.mode === "record") return <RecordScreen />;
  return <LiveScreen roomId={params.roomId || undefined} autoStart={armed} />;
}
