import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type Rgb = readonly [number, number, number];

interface Rgba {
  alpha: number;
  rgb: Rgb;
}

const visualThemeSource = readFileSync(
  resolve(import.meta.dirname, "visual-theme.css"),
  "utf8",
);

function parseCustomProperties(css: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const tokens = new Map<string, string>();
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/giu;
  for (const match of withoutComments.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name && value) tokens.set(name, value.trim().replace(/\s+/gu, " "));
  }
  return tokens;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - chroma / 2;
  const [r, g, b] =
    h < 60
      ? [chroma, x, 0]
      : h < 120
        ? [x, chroma, 0]
        : h < 180
          ? [0, chroma, x]
          : h < 240
            ? [0, x, chroma]
            : h < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function hexToRgb(hex: string): Rgb {
  const raw = hex.replace("#", "");
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

function resolveColor(tokens: ReadonlyMap<string, string>, name: string): Rgba {
  const raw = tokens.get(name);
  if (!raw) throw new Error(`Missing CSS token ${name}`);

  if (/^#[0-9a-f]{6}$/iu.test(raw)) {
    return { alpha: 1, rgb: hexToRgb(raw) };
  }

  const triplet = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/u.exec(raw);
  if (triplet) {
    return {
      alpha: 1,
      rgb: hslToRgb(Number(triplet[1]), Number(triplet[2]), Number(triplet[3])),
    };
  }

  const hslVar = /^hsl\(var\((--[a-z0-9-]+)\)(?:\s*\/\s*([\d.]+))?\)$/iu.exec(
    raw,
  );
  if (hslVar) {
    const base = resolveColor(tokens, hslVar[1]!);
    const alpha = hslVar[2] ? Number(hslVar[2]) : 1;
    return { alpha: base.alpha * alpha, rgb: base.rgb };
  }

  const colorMix =
    /^color-mix\(\s*in srgb,\s*(#[0-9a-f]{6})\s+([\d.]+)%,\s*transparent\s*\)$/iu.exec(
      raw,
    );
  if (colorMix) {
    return { alpha: Number(colorMix[2]) / 100, rgb: hexToRgb(colorMix[1]!) };
  }

  throw new Error(`Unsupported token format for ${name}: ${raw}`);
}

function compositeOver(fg: Rgba, bg: Rgb): Rgb {
  return [
    fg.rgb[0] * fg.alpha + bg[0] * (1 - fg.alpha),
    fg.rgb[1] * fg.alpha + bg[1] * (1 - fg.alpha),
    fg.rgb[2] * fg.alpha + bg[2] * (1 - fg.alpha),
  ];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const linear = [r, g, b].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const lumA = relativeLuminance(first);
  const lumB = relativeLuminance(second);
  return (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05);
}

describe("visual-theme.css WCAG 2.1 AA contrast", () => {
  const tokens = parseCustomProperties(visualThemeSource);
  const card = resolveColor(tokens, "--app-surface").rgb;
  const canvas = resolveColor(tokens, "--app-canvas").rgb;
  const muted = resolveColor(tokens, "--app-surface-soft").rgb;
  const sidebar = resolveColor(tokens, "--app-sidebar").rgb;
  const sidebarMuted = resolveColor(tokens, "--town-sidebar-muted").rgb;

  function ratioOf(
    fgToken: string,
    bgToken: string,
    backdrop: Rgb = card,
  ): number {
    const surface = compositeOver(resolveColor(tokens, bgToken), backdrop);
    const ink = compositeOver(resolveColor(tokens, fgToken), surface);
    return contrastRatio(ink, surface);
  }

  it.each([
    ["--app-ink", "--app-surface", card],
    ["--app-ink", "--app-canvas", card],
    ["--app-ink", "--app-surface-soft", card],
    ["--app-muted", "--app-surface", card],
    ["--app-muted", "--app-canvas", card],
    ["--app-muted", "--app-surface-soft", card],
    ["--app-muted", "--app-sidebar", card],
    ["--app-muted", "--town-sidebar-muted", card],
    ["--app-placeholder", "--app-surface", card],
    ["--app-placeholder", "--app-canvas", card],
    ["--app-placeholder", "--app-surface-soft", card],
    ["--app-status-neutral-text", "--app-status-neutral-surface", card],
    ["--app-status-warning-text", "--app-surface", card],
    ["--app-status-warning-text", "--app-status-warning-surface", card],
    ["--app-status-warning-text", "--app-status-warning-surface", canvas],
    ["--app-status-success-text", "--app-surface", card],
    ["--app-status-success-text", "--app-status-success-surface", card],
    ["--app-status-success-text", "--app-status-success-surface", canvas],
    ["--app-status-danger-text", "--app-surface", card],
    ["--app-status-danger-text", "--app-status-danger-surface", card],
    ["--app-status-danger-text", "--app-status-danger-surface", canvas],
    ["--app-info", "--app-surface", card],
    ["--app-card-info-text", "--app-card-info-surface", card],
    ["--app-card-info-text", "--app-card-info-surface", canvas],
    ["--app-mention-text", "--app-mention-surface", card],
    ["--app-mention-text", "--app-mention-surface", canvas],
    ["--app-mention-text", "--app-mention-hover", canvas],
    ["--town-primary-foreground", "--town-primary", card],
    ["--town-destructive-foreground", "--town-destructive", card],
    ["--town-primary-foreground", "--town-info", card],
  ] as const)(
    "meets WCAG AA (>= 4.5:1) for %s on %s",
    (fgToken, bgToken, backdrop) => {
      expect(ratioOf(fgToken, bgToken, backdrop)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([
    "pdf",
    "code",
    "presentation",
    "document",
    "sheet",
    "compressed",
    "universal",
  ] as const)(
    "meets WCAG AA (>= 4.5:1) for %s attachment text on white and tinted surface",
    (kind) => {
      const textToken = `--composer-attachment-${kind}-text`;
      const surfaceToken = `--composer-attachment-${kind}-surface`;
      expect(ratioOf(textToken, "--app-surface", card)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(ratioOf(textToken, surfaceToken, card)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(ratioOf(textToken, surfaceToken, canvas)).toBeGreaterThanOrEqual(
        4.5,
      );
    },
  );

  it.each([
    ["--app-field-border", "--app-surface"],
    ["--app-field-border", "--app-canvas"],
    ["--app-field-border-hover", "--app-surface"],
    ["--app-border-interactive", "--app-surface"],
    ["--app-border-interactive", "--app-canvas"],
  ] as const)(
    "meets WCAG 1.4.11 non-text UI contrast (>= 3.0:1) for %s on %s",
    (borderToken, surfaceToken) => {
      expect(ratioOf(borderToken, surfaceToken, card)).toBeGreaterThanOrEqual(
        3.0,
      );
    },
  );

  it("keeps the Another Me active card legible even at the darkest possible brand tint", () => {
    const worstCaseBrandSurface = compositeOver(
      { alpha: 0.1, rgb: [0, 0, 0] },
      card,
    );
    const ink = resolveColor(tokens, "--app-ink").rgb;
    const mutedInk = resolveColor(tokens, "--app-muted").rgb;
    expect(contrastRatio(ink, worstCaseBrandSurface)).toBeGreaterThanOrEqual(7);
    expect(
      contrastRatio(mutedInk, worstCaseBrandSurface),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(mutedInk, muted)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(mutedInk, sidebar)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(mutedInk, sidebarMuted)).toBeGreaterThanOrEqual(4.5);
  });
});
