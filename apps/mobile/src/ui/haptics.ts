// The few moments that get a haptic, each fired on the same frame as its
// visual and never as the only feedback: a choice ticking over, something
// the Human started or stopped, an action that finished. Haptics that are off
// or missing fail quietly.
import * as Haptics from "expo-haptics";

function quietly(run: () => Promise<void>): void {
  void run().catch(() => undefined);
}

/** A choice moved to another option, such as a picked Relay node. */
export function tick(): void {
  quietly(() => Haptics.selectionAsync());
}

/** The Human started or sent something: a message, a recording, Live. */
export function tap(): void {
  quietly(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** A heavier commit: stopping a recording or ending Live. */
export function thud(): void {
  quietly(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}
