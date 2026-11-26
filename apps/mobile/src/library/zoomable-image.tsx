// An image on its own screen: fitted and centered, pinch to zoom around the
// fingers, drag while zoomed, and double-tap to switch between the fit and
// 2.5x around the tapped point. Gestures and the transform run on the UI
// thread, so zooming stays smooth while JavaScript is busy.
import { useState } from "react";
import { StyleSheet, View, type LayoutRectangle } from "react-native";
import {
  GestureDetector,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from "react-native-reanimated";

import { useTranslation } from "../i18n/use-translation";
import { libraryReadableMessages as m } from "./readable.messages";

const MAX_SCALE = 5;
const TAP_SCALE = 2.5;
const SETTLE = { duration: 220 };

export function ZoomableImage(props: {
  readonly uri: string;
  readonly accessibilityLabel?: string;
}) {
  const { t } = useTranslation();
  const [frame, setFrame] = useState<LayoutRectangle>();
  const [natural, setNatural] = useState<{ width: number; height: number }>();

  // The fitted size: the whole image visible and centered, a small image
  // no larger than its own pixels in points.
  const fit =
    frame && natural
      ? Math.min(1, frame.width / natural.width, frame.height / natural.height)
      : 0;
  const fitWidth = natural ? natural.width * fit : 0;
  const fitHeight = natural ? natural.height * fit : 0;
  const frameWidth = frame?.width ?? 0;
  const frameHeight = frame?.height ?? 0;

  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const zoomed = useSharedValue(false);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);

  // How far the zoomed image may move before its edge leaves its side.
  const boundX = (s: number) => {
    "worklet";
    return Math.max(0, (fitWidth * s - frameWidth) / 2);
  };
  const boundY = (s: number) => {
    "worklet";
    return Math.max(0, (fitHeight * s - frameHeight) / 2);
  };
  const clamp = (value: number, bound: number) => {
    "worklet";
    return Math.min(bound, Math.max(-bound, value));
  };
  const settle = (s: number, toX: number, toY: number) => {
    "worklet";
    scale.value = withTiming(s, SETTLE);
    x.value = withTiming(clamp(toX, boundX(s)), SETTLE);
    y.value = withTiming(clamp(toY, boundY(s)), SETTLE);
    zoomed.value = s > 1.01;
  };

  const pinch = usePinchGesture({
    onActivate: (event) => {
      "worklet";
      focalX.value = event.focalX - frameWidth / 2;
      focalY.value = event.focalY - frameHeight / 2;
    },
    onUpdate: (event) => {
      "worklet";
      const fx = event.focalX - frameWidth / 2;
      const fy = event.focalY - frameHeight / 2;
      const next = Math.min(
        MAX_SCALE,
        Math.max(0.6, scale.value * event.scaleChange),
      );
      const change = next / scale.value;
      // Keep the point under the fingers under them, and follow them as they move.
      x.value = fx - change * (focalX.value - x.value);
      y.value = fy - change * (focalY.value - y.value);
      focalX.value = fx;
      focalY.value = fy;
      scale.value = next;
    },
    onDeactivate: () => {
      "worklet";
      if (scale.value < 1) settle(1, 0, 0);
      else settle(scale.value, x.value, y.value);
    },
  });

  const pan = usePanGesture({
    enabled: zoomed,
    maxPointers: 1,
    onUpdate: (event) => {
      "worklet";
      x.value = clamp(x.value + event.changeX, boundX(scale.value));
      y.value = clamp(y.value + event.changeY, boundY(scale.value));
    },
    onDeactivate: (event) => {
      "worklet";
      const bx = boundX(scale.value);
      const by = boundY(scale.value);
      x.value = withDecay({ velocity: event.velocityX, clamp: [-bx, bx] });
      y.value = withDecay({ velocity: event.velocityY, clamp: [-by, by] });
    },
  });

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (event) => {
      "worklet";
      if (scale.value > 1.01) {
        settle(1, 0, 0);
        return;
      }
      // The tapped point stays put while the image grows around it.
      const fx = event.x - frameWidth / 2;
      const fy = event.y - frameHeight / 2;
      settle(
        TAP_SCALE,
        fx - TAP_SCALE * (fx - x.value),
        fy - TAP_SCALE * (fy - y.value),
      );
    },
  });

  const gesture = useSimultaneousGestures(pinch, pan, doubleTap);

  const transform = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={styles.frame}
        onLayout={(event) => setFrame(event.nativeEvent.layout)}
        accessible
        accessibilityRole="image"
        accessibilityLabel={props.accessibilityLabel ?? t(m.image)}
        accessibilityHint={t(m.zoomHint)}
      >
        <Animated.Image
          source={{ uri: props.uri }}
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          onLoad={(event) => {
            const { width, height } = event.nativeEvent.source;
            if (width > 0 && height > 0) setNatural({ width, height });
          }}
          style={[
            natural ? { width: fitWidth, height: fitHeight } : styles.loading,
            transform,
          ]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  frame: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  // Until the image reports its size it fills the frame, invisible to layout.
  loading: { width: "100%", height: "100%", opacity: 0 },
});
