import { lazy, Suspense, type ComponentProps } from "react";

const VoiceKeyDialog = lazy(async () => ({
  default: (await import("./voice-key-dialog")).VoiceKeyDialog,
}));

/** The voice key dialog, loaded only when a voice entry opens it. */
export function LazyVoiceKeyDialog(
  props: ComponentProps<typeof VoiceKeyDialog>,
) {
  return (
    <Suspense fallback={null}>
      <VoiceKeyDialog {...props} />
    </Suspense>
  );
}
