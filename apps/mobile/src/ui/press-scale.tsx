// Press feedback for things that read as objects, buttons and cards: they
// sink to 97% the moment a finger lands and spring back on release, in 120 ms
// on the UI thread. List rows highlight instead, as in iOS. Reduce Motion
// keeps the press but drops the scale.
import { useState, type ReactNode } from "react";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { cubicBezier } from "react-native-reanimated";

import { useReducedMotion } from "./motion";

/** A strong ease-out: the change shows at once and settles softly. */
const EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);

export interface PressScaleProps extends Omit<
  PressableProps,
  "style" | "children"
> {
  /** Where the control sits in its parent: flex, margins, width. */
  readonly containerStyle?: StyleProp<ViewStyle>;
  /** How the control looks: fill, radius, padding. */
  readonly style?: StyleProp<ViewStyle>;
  /** How far it sinks while pressed. */
  readonly scale?: number;
  readonly children: ReactNode;
}

export function PressScale(props: PressScaleProps) {
  const {
    containerStyle,
    style,
    scale = 0.97,
    children,
    onPressIn,
    onPressOut,
    ...pressable
  } = props;
  const [pressed, setPressed] = useState(false);
  const reduced = useReducedMotion();
  return (
    <Pressable
      {...pressable}
      style={containerStyle}
      onPressIn={(event) => {
        setPressed(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        onPressOut?.(event);
      }}
    >
      <Animated.View
        style={[
          style,
          {
            transform: [{ scale: pressed && !reduced ? scale : 1 }],
            transitionProperty: "transform",
            transitionDuration: 120,
            transitionTimingFunction: EASE_OUT,
          },
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}
