// How an Agent's avatar key renders, as the web reads it
// (apps/web/src/features/rooms/members/agent-avatar.ts): `figure:<name>:RRGGBB`
// is that character on that background, `image:RRGGBB` the uploaded image on
// it, and any other key a stable character derived from the key.
import { AGENT_FIGURES } from "./agent-figures.generated";

const backgrounds = new Map(AGENT_FIGURES);

export interface AvatarAppearance {
  readonly kind: "figure" | "image";
  readonly figure: string;
  /** `#RRGGBB`. */
  readonly color: string;
}

function seeded(seed: string): AvatarAppearance {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const [figure, color] = AGENT_FIGURES[hash % AGENT_FIGURES.length]!;
  return { kind: "figure", figure, color: `#${color}` };
}

export function avatarAppearance(
  key: string | undefined,
  seed: string,
): AvatarAppearance {
  if (!key) return seeded(seed);
  const [scheme, first = "", second = ""] = key.split(":");
  const hex = /^[0-9a-fA-F]{6}$/;
  if (scheme === "image" && hex.test(first))
    return {
      kind: "image",
      figure: AGENT_FIGURES[0]![0],
      color: `#${first.toUpperCase()}`,
    };
  if (scheme === "figure" && backgrounds.has(first) && hex.test(second))
    return { kind: "figure", figure: first, color: `#${second.toUpperCase()}` };
  // The web derives an unknown key's character from the key itself.
  return seeded(key);
}

/** A Human's initials: the first letters of the first two words. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}
