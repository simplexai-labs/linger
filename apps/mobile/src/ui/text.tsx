// Text and TextInput in Geist. React Native has no default font family, so
// every screen imports these instead of the react-native ones; the weight in
// the style picks the face, and the weight itself is cleared so no platform
// synthesizes a bolder one.
import {
  Text as NativeText,
  TextInput as NativeTextInput,
  StyleSheet,
  type TextProps,
} from "react-native";

import { geistFace } from "./geist-face";

function geist(style: TextProps["style"]) {
  const flat = StyleSheet.flatten(style);
  return [
    style,
    { fontFamily: geistFace(flat?.fontWeight), fontWeight: "normal" as const },
  ];
}

export function Text(props: TextProps) {
  return <NativeText {...props} style={geist(props.style)} />;
}

export function TextInput(props: React.ComponentProps<typeof NativeTextInput>) {
  return <NativeTextInput {...props} style={geist(props.style)} />;
}
