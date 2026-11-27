// A recording, downloaded through the session into a cache file and played
// from there, so seeking needs no network. The file is deleted when the
// screen closes: the phone keeps no audio from the computer. The player is a
// card: a scrubber with both times, and back 15, play or pause, forward 15.
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import type { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";

import { documentVersionContentPath } from "../api/teamhub";
import { useTranslation } from "../i18n/use-translation";
import { useTeamHub } from "../state/queries";
import { colors, radius, space, touchTarget, type } from "../theme";
import { Icon, type IconName } from "../ui/icon";
import { Text } from "../ui/text";
import { downloadToFile, freshCacheFile } from "./cache-file";
import { fileSize } from "./file-kind";
import { libraryRecordingMessages as m } from "./recording.messages";

const SKIP_SECONDS = 15;

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

function IconButton(props: {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.skip,
        pressed && styles.pressed,
        props.disabled && styles.disabled,
      ]}
    >
      <Icon name={props.icon} size={24} color={colors.ink} />
    </Pressable>
  );
}

/** The track: tap or drag anywhere on it to move the playhead. */
function Scrubber(props: {
  readonly progress: number;
  readonly enabled: boolean;
  readonly onSeek: (fraction: number) => void;
  readonly onScrub: (fraction: number | undefined) => void;
}) {
  const [width, setWidth] = useState(1);
  const fraction = (event: GestureResponderEvent) =>
    Math.min(1, Math.max(0, event.nativeEvent.locationX / width));
  return (
    <View
      style={styles.track}
      onLayout={(event) =>
        setWidth(Math.max(1, event.nativeEvent.layout.width))
      }
      onStartShouldSetResponder={() => props.enabled}
      onMoveShouldSetResponder={() => props.enabled}
      onResponderGrant={(event) => props.onScrub(fraction(event))}
      onResponderMove={(event) => props.onScrub(fraction(event))}
      onResponderRelease={(event) => {
        props.onScrub(undefined);
        props.onSeek(fraction(event));
      }}
      onResponderTerminate={() => props.onScrub(undefined)}
    >
      <View style={styles.rail} pointerEvents="none">
        <View style={[styles.fill, { width: `${props.progress * 100}%` }]} />
      </View>
      {props.enabled ? (
        <View
          pointerEvents="none"
          style={[styles.thumb, { left: `${props.progress * 100}%` }]}
        />
      ) : null}
    </View>
  );
}

export function Recording(props: {
  readonly versionId: string;
  readonly filename: string;
}) {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [state, setState] = useState<
    "idle" | "downloading" | "ready" | "failed"
  >("idle");
  const [bytes, setBytes] = useState(0);
  const [scrub, setScrub] = useState<number>();
  const fileRef = useRef<File | undefined>(undefined);

  useEffect(
    () => () => {
      const file = fileRef.current;
      if (file?.exists) file.delete();
    },
    [],
  );

  const load = async () => {
    if (!teamHub.hostId) return;
    setState("downloading");
    setBytes(0);
    try {
      const file = freshCacheFile(
        teamHub.hostId,
        props.versionId,
        props.filename,
      );
      fileRef.current = file;
      await teamHub.run((session) =>
        downloadToFile(
          session,
          documentVersionContentPath(props.versionId),
          file,
          setBytes,
        ),
      );
      await setAudioModeAsync({ playsInSilentMode: true });
      player.replace({ uri: file.uri });
      setState("ready");
      player.play();
    } catch {
      setState("failed");
    }
  };

  const ready = state === "ready";
  const duration = ready ? status.duration || 0 : 0;
  const current = ready ? status.currentTime : 0;
  const shown = scrub !== undefined ? scrub * duration : current;
  const progress = duration > 0 ? Math.min(1, shown / duration) : 0;
  const seek = (seconds: number) =>
    void player.seekTo(Math.max(0, Math.min(duration, seconds)));
  const toggle = () => {
    if (!ready) {
      if (state !== "downloading") void load();
      return;
    }
    if (status.playing) player.pause();
    else {
      // A finished recording starts over.
      if (duration > 0 && status.currentTime >= duration - 0.5) seek(0);
      player.play();
    }
  };

  return (
    <View style={styles.card}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t(m.position)}
        accessibilityValue={{
          text: t(m.positionValue, {
            current: clock(shown),
            duration: clock(duration),
          }),
        }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) =>
          seek(
            current +
              (event.nativeEvent.actionName === "increment"
                ? SKIP_SECONDS
                : -SKIP_SECONDS),
          )
        }
      >
        <Scrubber
          progress={progress}
          enabled={ready && duration > 0}
          onScrub={setScrub}
          onSeek={(fraction) => seek(fraction * duration)}
        />
        <View style={styles.times}>
          <Text style={styles.time}>{clock(shown)}</Text>
          <Text style={styles.time}>
            {state === "downloading"
              ? bytes > 0
                ? t(m.gettingItSize, { size: fileSize(bytes) })
                : t(m.gettingIt)
              : state === "failed"
                ? t(m.didNotLoad)
                : ready
                  ? clock(duration)
                  : "--:--"}
          </Text>
        </View>
      </View>
      <View style={styles.controls}>
        <IconButton
          icon="back15"
          label={t(m.back, { seconds: SKIP_SECONDS })}
          disabled={!ready}
          onPress={() => seek(current - SKIP_SECONDS)}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            state === "failed"
              ? t(m.tryAgain)
              : ready && status.playing
                ? t(m.pause)
                : t(m.play)
          }
          accessibilityState={{
            disabled: !teamHub.connected,
            busy: state === "downloading",
          }}
          disabled={!teamHub.connected && !ready}
          onPress={toggle}
          style={({ pressed }) => [
            styles.play,
            pressed && styles.pressed,
            !teamHub.connected && !ready && styles.disabled,
          ]}
        >
          {state === "downloading" ? (
            <ActivityIndicator color={colors.onAction} />
          ) : (
            <Icon
              name={ready && status.playing ? "pause" : "play"}
              size={24}
              color={colors.onAction}
            />
          )}
        </Pressable>
        <IconButton
          icon="forward15"
          label={t(m.forward, { seconds: SKIP_SECONDS })}
          disabled={!ready}
          onPress={() => seek(current + SKIP_SECONDS)}
        />
      </View>
    </View>
  );
}

const THUMB = 12;

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.lg,
    gap: space.xs,
  },
  track: { height: touchTarget - 12, justifyContent: "center" },
  rail: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    overflow: "hidden",
  },
  fill: { height: 4, backgroundColor: colors.ink },
  thumb: {
    position: "absolute",
    width: THUMB,
    height: THUMB,
    marginLeft: -THUMB / 2,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
  },
  times: { flexDirection: "row", justifyContent: "space-between" },
  time: { ...StyleSheet.flatten(type.caption), fontVariant: ["tabular-nums"] },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xl,
    marginTop: space.sm,
  },
  skip: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  play: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.action,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { transform: [{ scale: 0.97 }] },
  disabled: { opacity: 0.5 },
});
