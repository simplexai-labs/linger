import { useCallback, useEffect, useRef, useState } from "react";

import { useOptionalVoiceModeSession } from "@/features/rooms/chat/voice-mode/voice-mode-session";
import { observeAudioLevel } from "@/features/rooms/chat/voice-mode/voice-media-room";
import {
  describeVoiceMediaError,
  openBoundMicrophone,
  retryOnVoiceMediaAbort,
  voiceMicrophoneConstraints,
} from "@/features/rooms/voice-control/microphone-devices";
import { useOptionalVoiceControl } from "@/features/rooms/voice-control/voice-control-context";
import { translate } from "@/i18n/language";
import { recordingMessages } from "@/features/rooms/voice-control/recording.messages";

export const MICROPHONE_TEST_MAX_DURATION_MS = 60_000;

interface ActiveTestHandle {
  deviceId: string | undefined;
  disposeMeter: () => void;
  stream: MediaStream;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs a scoped, clash-free local microphone level test using Web Audio
 * (`observeAudioLevel`). Refuses to open a second stream while Meeting
 * Recording or Voice Mode is active, cleans up on unmount, pagehide,
 * visibilitychange, device change, and a 60-second safety cap.
 */
export function useMicrophoneTest(selectedDeviceId: string | undefined) {
  const voiceControl = useOptionalVoiceControl();
  const voiceMode = useOptionalVoiceModeSession();

  const captureStatus = voiceControl?.captureState.status;
  const listenerStatus = voiceControl?.listenerStatus;
  const blockedByActiveSession = Boolean(
    voiceMode?.session ||
    voiceControl?.composerMicrophoneActive ||
    captureStatus === "starting" ||
    captureStatus === "recording" ||
    captureStatus === "finalizing" ||
    listenerStatus === "listening" ||
    listenerStatus === "transcribing" ||
    listenerStatus === "composer_recording",
  );

  const [testing, setTesting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const activeRef = useRef<ActiveTestHandle | null>(null);
  const requestIdRef = useRef(0);

  const releaseActive = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    activeRef.current = null;
    clearTimeout(current.timer);
    try {
      current.disposeMeter();
    } finally {
      for (const track of current.stream.getTracks()) {
        track.stop();
      }
    }
  }, []);

  const stopTest = useCallback(
    (options?: { timedOut?: boolean }) => {
      requestIdRef.current += 1;
      releaseActive();
      setStarting(false);
      setTesting(false);
      setLevel(0);
      if (options?.timedOut) {
        setTimedOut(true);
      }
    },
    [releaseActive],
  );

  const startTest = useCallback(
    async (deviceIdOverride?: string) => {
      if (blockedByActiveSession) return;
      const targetDeviceId =
        deviceIdOverride !== undefined ? deviceIdOverride : selectedDeviceId;
      const normalizedDeviceId = targetDeviceId?.trim() || undefined;

      releaseActive();
      const requestId = (requestIdRef.current += 1);
      setError(null);
      setTimedOut(false);
      setStarting(true);
      setLevel(0);

      let stream: MediaStream | undefined;
      try {
        const mediaDevices = navigator.mediaDevices;
        if (!mediaDevices?.getUserMedia) {
          throw new Error(translate(recordingMessages.microphoneUnavailable));
        }
        stream = await retryOnVoiceMediaAbort(() =>
          openBoundMicrophone(normalizedDeviceId, (device) =>
            mediaDevices.getUserMedia({
              audio: {
                ...voiceMicrophoneConstraints,
                ...(device ? { deviceId: device } : {}),
              },
            }),
          ),
        );
        if (requestIdRef.current !== requestId) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const track = stream.getAudioTracks()[0];
        if (!track) {
          for (const item of stream.getTracks()) item.stop();
          throw new Error(translate(recordingMessages.noAudioInput));
        }
        const disposeMeter = observeAudioLevel(track, (nextLevel) => {
          if (requestIdRef.current === requestId) {
            setLevel(nextLevel);
          }
        });
        const timer = setTimeout(() => {
          if (requestIdRef.current === requestId) {
            stopTest({ timedOut: true });
          }
        }, MICROPHONE_TEST_MAX_DURATION_MS);

        activeRef.current = {
          deviceId: normalizedDeviceId,
          disposeMeter,
          stream,
          timer,
        };
        setStarting(false);
        setTesting(true);
      } catch (cause) {
        if (stream) {
          for (const track of stream.getTracks()) track.stop();
        }
        if (requestIdRef.current === requestId) {
          setStarting(false);
          setTesting(false);
          setLevel(0);
          setError(describeVoiceMediaError(cause));
        }
      }
    },
    [blockedByActiveSession, releaseActive, selectedDeviceId, stopTest],
  );

  // Stop immediately if a recording or Voice Mode session begins while testing.
  useEffect(() => {
    if (blockedByActiveSession && (activeRef.current || starting)) {
      stopTest();
    }
  }, [blockedByActiveSession, starting, stopTest]);

  // If the user switches microphone devices while testing, reopen on the new device.
  useEffect(() => {
    const normalized = selectedDeviceId?.trim() || undefined;
    if (
      testing &&
      activeRef.current &&
      activeRef.current.deviceId !== normalized
    ) {
      void startTest(normalized);
    }
  }, [selectedDeviceId, startTest, testing]);

  // Mandatory cleanup on pagehide, visibilitychange (hidden), and unmount.
  useEffect(() => {
    const handlePageHide = () => {
      if (activeRef.current) stopTest();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && activeRef.current) {
        stopTest();
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      requestIdRef.current += 1;
      releaseActive();
    };
  }, [releaseActive, stopTest]);

  return {
    blockedByActiveSession,
    error,
    level,
    startTest,
    starting,
    stopTest,
    testing,
    timedOut,
  };
}
