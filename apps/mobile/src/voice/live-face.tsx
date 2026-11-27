// Live's stage: Another Me's face, rising in as the call opens, with a ring
// that swells with the voice it hears and turns the Linger amber while it
// answers.
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { colors, night } from "../theme";
import { AgentAvatar } from "../ui/avatar";
import { useReducedMotion } from "../ui/motion";

const FACE = 128;
/** The avatar's own corner (20% of its size), so the ring follows it. */
const AVATAR_RADIUS = Math.round(FACE * 0.2);

export function LiveFace(props: {
  readonly agentId: string | undefined;
  /** 0 to 1: the louder of the Human and the reply. */
  readonly level: number;
  readonly replying: boolean;
  readonly dimmed: boolean;
}) {
  const enter = useRef(new Animated.Value(0)).current;
  const swell = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      enter.setValue(1);
      return;
    }
    Animated.spring(enter, {
      toValue: 1,
      speed: 10,
      bounciness: 8,
      useNativeDriver: true,
    }).start();
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2_200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [enter, pulse, reduced]);

  useEffect(() => {
    Animated.spring(swell, {
      toValue: reduced ? 0 : Math.min(1, props.level * 5),
      speed: 28,
      bounciness: 3,
      useNativeDriver: true,
    }).start();
  }, [props.level, reduced, swell]);

  const ringColor = props.replying ? colors.brand : night.ink;
  return (
    <View
      style={styles.frame}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          styles.ring,
          {
            borderColor: ringColor,
            opacity: pulse.interpolate({
              inputRange: [0, 1],
              outputRange: [props.dimmed ? 0.1 : 0.35, 0],
            }),
            transform: [
              {
                scale: pulse.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 1.7],
                }),
              },
            ],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.glow,
          {
            backgroundColor: ringColor,
            opacity: swell.interpolate({
              inputRange: [0, 1],
              outputRange: [0.06, props.dimmed ? 0.06 : 0.22],
            }),
            transform: [
              {
                scale: swell.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1.05, 1.45],
                }),
              },
            ],
          },
        ]}
      />
      <Animated.View
        style={{
          opacity: enter,
          transform: [
            {
              scale: enter.interpolate({
                inputRange: [0, 1],
                outputRange: [0.6, 1],
              }),
            },
          ],
        }}
      >
        {props.agentId ? (
          <AgentAvatar actorId={props.agentId} size={FACE} />
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: FACE * 2,
    height: FACE * 2,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: FACE,
    height: FACE,
    borderRadius: AVATAR_RADIUS,
    borderWidth: 2,
  },
  glow: {
    position: "absolute",
    width: FACE,
    height: FACE,
    borderRadius: AVATAR_RADIUS,
  },
});
