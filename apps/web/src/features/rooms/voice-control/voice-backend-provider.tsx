import {
  lazy,
  Suspense,
  useMemo,
  useState,
  type ContextType,
  type ReactNode,
} from "react";
import type { TeamHubVoiceMediaPolicy } from "@/features/teamhub/teamhub-types";
import {
  VoiceCapabilitiesContext,
  VoiceConnectionRetryContext,
  VoiceControlContext,
} from "./voice-control-context";

export interface VoiceContexts {
  livekit: ContextType<typeof VoiceControlContext>;
  policy?: TeamHubVoiceMediaPolicy;
  retryConnection?: () => void;
}

const VoiceBackendController = lazy(async () => ({
  default: (await import("./voice-backend-controller")).VoiceBackendController,
}));

export function VoiceControlProvider(props: {
  children: ReactNode;
  tenantId: string;
}) {
  return <TenantVoiceControlProvider key={props.tenantId} {...props} />;
}

function TenantVoiceControlProvider({
  children,
  tenantId,
}: {
  children: ReactNode;
  tenantId: string;
}) {
  const [contexts, setContexts] = useState<VoiceContexts>({
    livekit: null,
  });
  // Publishing a context must not rerender its source engine in a feedback loop.
  const controller = useMemo(
    () => <VoiceBackendController tenantId={tenantId} onChange={setContexts} />,
    [tenantId],
  );
  const { livekit, policy, retryConnection } = contexts;
  const ready = Boolean(policy && (!policy.voice_media_supported || livekit));
  const capabilities = useMemo(
    () =>
      ready && policy
        ? { voiceMedia: policy.voice_media_supported }
        : undefined,
    [policy, ready],
  );
  return (
    <>
      <Suspense fallback={null}>{controller}</Suspense>
      <VoiceControlContext value={livekit}>
        <VoiceCapabilitiesContext value={capabilities}>
          <VoiceConnectionRetryContext value={retryConnection}>
            {children}
          </VoiceConnectionRetryContext>
        </VoiceCapabilitiesContext>
      </VoiceControlContext>
    </>
  );
}
