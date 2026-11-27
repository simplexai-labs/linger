// The little listener on the recording screen: a soft amber cloud in the
// colour of the Linger dot, with a face. It breathes while it waits, blinks
// now and then, swells and opens its mouth with the voice it hears, and
// closes its eyes while recording is paused. Motion is off when the system
// asks for reduced motion.
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { colors } from "../theme";
import { useReducedMotion } from "../ui/motion";

export function ListeningBuddy(props: {
  /** 0 to 1: how loud the room is now. */
  readonly level: number;
  /** Paused or not recording: eyes closed, no breath. */
  readonly sleeping?: boolean;
  readonly size?: number;
}) {
  const size = props.size ?? 160;
  const reduced = useReducedMotion();
  const breath = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const voice = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced || props.sleeping) {
      breath.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 1_400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 1_400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath, props.sleeping, reduced]);

  useEffect(() => {
    if (reduced || props.sleeping) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          Animated.sequence([
            Animated.timing(blink, {
              toValue: 0.1,
              duration: 70,
              useNativeDriver: true,
            }),
            Animated.timing(blink, {
              toValue: 1,
              duration: 110,
              useNativeDriver: true,
            }),
          ]).start(next);
        },
        2_600 + Math.random() * 2_400,
      );
    };
    next();
    return () => clearTimeout(timer);
  }, [blink, props.sleeping, reduced]);

  useEffect(() => {
    // A damped spring: the cloud bounces a little with each word.
    Animated.spring(voice, {
      toValue: props.sleeping ? 0 : Math.min(1, props.level * 6),
      speed: 22,
      bounciness: 9,
      useNativeDriver: true,
    }).start();
  }, [props.level, props.sleeping, voice]);

  const lift = Animated.add(
    breath.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.03] }),
    voice.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.05] }),
  );
  const stretchY = Animated.add(
    breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] }),
    voice.interpolate({ inputRange: [0, 1], outputRange: [0, 0.08] }),
  );
  const stretchX = Animated.add(
    breath.interpolate({ inputRange: [0, 1], outputRange: [1, 0.975] }),
    voice.interpolate({ inputRange: [0, 1], outputRange: [0, 0.04] }),
  );
  const shadowScale = Animated.subtract(
    1,
    voice.interpolate({ inputRange: [0, 1], outputRange: [0, 0.18] }),
  );
  const mouth = voice.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 1],
  });
  const open = voice.interpolate({
    inputRange: [0, 0.15, 1],
    outputRange: [0, 1, 1],
    extrapolate: "clamp",
  });
  const smile = Animated.subtract(1, open);

  const body = size;
  const eye = size * 0.075;
  return (
    <View
      style={[styles.frame, { width: size * 1.3, height: size * 1.25 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          styles.floor,
          {
            width: body * 0.62,
            height: body * 0.09,
            borderRadius: body,
            bottom: size * 0.04,
            transform: [{ scaleX: shadowScale }],
          },
        ]}
      />
      <Animated.View
        style={{
          width: body,
          height: body * 0.82,
          opacity: props.sleeping ? 0.85 : 1,
          transform: [
            { translateY: lift },
            { scaleX: stretchX },
            { scaleY: stretchY },
          ],
        }}
      >
        {/* Three puffs on top make it a cloud; the base is a soft squircle. */}
        <View
          style={[
            styles.puff,
            {
              width: body * 0.5,
              height: body * 0.5,
              left: body * 0.08,
              top: body * 0.1,
            },
          ]}
        />
        <View
          style={[
            styles.puff,
            {
              width: body * 0.6,
              height: body * 0.6,
              left: body * 0.2,
              top: 0,
            },
          ]}
        />
        <View
          style={[
            styles.puff,
            {
              width: body * 0.48,
              height: body * 0.48,
              right: body * 0.06,
              top: body * 0.12,
            },
          ]}
        />
        <View
          style={[
            styles.base,
            {
              height: body * 0.52,
              borderRadius: body * 0.26,
              top: body * 0.28,
            },
          ]}
        />
        <View
          style={[
            styles.glow,
            {
              width: body * 0.14,
              height: body * 0.08,
              left: body * 0.3,
              top: body * 0.1,
              borderRadius: body,
              transform: [{ rotate: "-20deg" }],
            },
          ]}
        />
        <View style={[styles.face, { top: body * 0.38 }]}>
          <View style={[styles.eyes, { gap: body * 0.17 }]}>
            {[0, 1].map((index) =>
              props.sleeping ? (
                <View
                  key={index}
                  style={[
                    styles.closedEye,
                    { width: eye * 1.4, height: Math.max(2, eye * 0.32) },
                  ]}
                />
              ) : (
                <Animated.View
                  key={index}
                  style={[
                    styles.eye,
                    {
                      width: eye,
                      height: eye * 1.3,
                      borderRadius: eye,
                      transform: [{ scaleY: blink }],
                    },
                  ]}
                />
              ),
            )}
          </View>
          <View style={[styles.cheeks, { gap: body * 0.36 }]}>
            {[0, 1].map((index) => (
              <View
                key={index}
                style={[
                  styles.cheek,
                  {
                    width: body * 0.1,
                    height: body * 0.05,
                    borderRadius: body,
                  },
                ]}
              />
            ))}
          </View>
          {/* A small smile at rest; an open mouth grows over it with the voice. */}
          <View
            style={[
              styles.mouthBox,
              { height: body * 0.09, marginTop: -body * 0.035 },
            ]}
          >
            <Animated.View
              style={[
                styles.smile,
                {
                  width: body * 0.11,
                  height: body * 0.055,
                  borderBottomLeftRadius: body * 0.06,
                  borderBottomRightRadius: body * 0.06,
                  borderWidth: Math.max(2, body * 0.016),
                  opacity: smile,
                },
              ]}
            />
            <Animated.View
              style={[
                styles.mouth,
                {
                  width: body * 0.1,
                  height: body * 0.09,
                  borderRadius: body,
                  opacity: open,
                  transform: [{ scaleY: mouth }],
                },
              ]}
            />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { alignItems: "center", justifyContent: "flex-end" },
  floor: { position: "absolute", backgroundColor: "rgba(26, 26, 22, 0.08)" },
  puff: {
    position: "absolute",
    borderRadius: 999,
    backgroundColor: colors.brand,
  },
  base: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: colors.brand,
  },
  glow: { position: "absolute", backgroundColor: colors.brandLight },
  face: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  eyes: { flexDirection: "row" },
  eye: { backgroundColor: colors.ink },
  closedEye: { borderRadius: 2, backgroundColor: colors.ink },
  cheeks: { flexDirection: "row", marginTop: 2 },
  cheek: { backgroundColor: "rgba(232, 104, 80, 0.35)" },
  mouthBox: { alignItems: "center", justifyContent: "flex-start" },
  smile: {
    position: "absolute",
    top: 0,
    borderColor: colors.ink,
    borderTopWidth: 0,
    borderTopColor: "transparent",
    backgroundColor: "transparent",
  },
  mouth: { position: "absolute", top: 0, backgroundColor: colors.ink },
});
