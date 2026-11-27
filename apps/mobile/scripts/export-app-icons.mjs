#!/usr/bin/env node
// Derives the phone's launcher icons from the approved Linger tile
// (apps/assets/logo/source/linger.svg): the ivory L and amber dot on the dark
// ink tile. iOS takes a full-bleed square and masks it itself; Android takes
// the glyph alone inside its adaptive-icon safe zone over an ink background.
// Needs Google Chrome: `node apps/mobile/scripts/export-app-icons.mjs`.
import { chromium } from "@playwright/test";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INK = "#141414";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const assets = join(root, "apps/mobile/assets");
const mark = readFileSync(
  join(root, "apps/assets/logo/source/linger.svg"),
  "utf8",
);

/** The tile's own artwork without its ink background shapes. */
function glyph(svg, color) {
  return svg
    .replace(/<path[^>]*fill="#141414"[^>]*\/>/gi, "")
    .replace(
      /fill="#(?!141414)[0-9a-f]{6}"/gi,
      color ? `fill="${color}"` : "$&",
    );
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
  });
  const shoot = async (file, html, size, transparent) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;width:${size}px;height:${size}px;background:${transparent ? "transparent" : INK};display:flex;align-items:center;justify-content:center;overflow:hidden}svg{display:block;width:var(--s);height:var(--s)}</style>${html}`,
    );
    await page.screenshot({
      path: join(assets, file),
      omitBackground: transparent,
    });
  };
  const sized = (svg, px) =>
    `<div style="--s:${px}px;display:contents">${svg.replace(/<\?xml[^>]*>/, "")}</div>`;
  // iOS: the tile edge to edge; the system draws the rounded corners.
  await shoot("icon.png", sized(mark, 1024), 1024, false);
  // Android adaptive icon: the glyph within the central safe circle.
  await shoot(
    "android-icon-foreground.png",
    sized(glyph(mark), 420),
    512,
    true,
  );
  await shoot(
    "android-icon-monochrome.png",
    sized(glyph(mark, "#000000"), 420),
    512,
    true,
  );
  await shoot("android-icon-background.png", "", 512, false);
  // The splash shows the tile on a light screen with its corners clear. The
  // traced SVG leaves a hairline seam across the tile that only shows over
  // a transparent background, so the splash takes the approved raster.
  copyFileSync(
    join(root, "apps/assets/logo/source/linger.png"),
    join(assets, "splash-icon.png"),
  );
} finally {
  await browser.close();
}
process.stdout.write("app icons\n");
