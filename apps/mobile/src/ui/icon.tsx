// The web's <Icon>: a Hugeicon at one of the five sizes, stroke 2 up to 16px
// and 1.5 from 20px so the optical weight holds, tinted to the given color.
import { Image } from "react-native";

import { colors } from "../theme";
import { ICON_IMAGES } from "./icon-images.generated";

export type IconName = keyof typeof ICON_IMAGES;
export type IconSize = 12 | 14 | 16 | 20 | 24;

export function Icon(props: {
  readonly name: IconName;
  readonly size?: IconSize;
  readonly color?: string;
}) {
  const size = props.size ?? 20;
  const images = ICON_IMAGES[props.name];
  return (
    <Image
      source={size >= 20 ? images.regular : images.bold}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        tintColor: props.color ?? colors.ink,
      }}
    />
  );
}
