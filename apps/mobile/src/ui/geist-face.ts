// The Geist face for a style weight, kept apart from the font files so it
// runs in Node tests.
export type GeistFace =
  | "Geist-Regular"
  | "Geist-Medium"
  | "Geist-SemiBold"
  | "Geist-Bold";

/** The face for a style's weight: 400, 470 (500), 580 (600), 640 (700+). */
export function geistFace(weight: string | number | undefined): GeistFace {
  const value =
    weight === "bold"
      ? 700
      : weight === undefined || weight === "normal"
        ? 400
        : Number(weight);
  if (!Number.isFinite(value) || value < 450) return "Geist-Regular";
  if (value < 550) return "Geist-Medium";
  if (value < 650) return "Geist-SemiBold";
  return "Geist-Bold";
}
