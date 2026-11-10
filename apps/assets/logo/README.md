# Linger product logo

The approved identity is the hand-drawn **window companion**: a small friend
looking over a windowsill, with two golden attention strokes and a handwritten
lowercase wordmark. The master was refined with `openai/gpt-image-2.6-sunburst`.

Open `preview.jpg` for the logo, desktop icon and actual-size favicon samples.

## Assets

| Path | Use |
| --- | --- |
| `source/linger-window-sunburst.png` | Original 2048 × 2048 transparent generated master |
| `logo-stacked.png`, `logo-stacked.svg` | Emblem above handwritten wordmark |
| `logo-horizontal.png`, `logo-horizontal.svg` | Header lockup |
| `logo-mark.png`, `logo-mark.svg` | Standalone window companion |
| `logo-wordmark.png`, `logo-wordmark.svg` | Handwritten lettering only |
| `app-icon.png` | 1024 × 1024 square icon on warm ivory |
| `windows/linger.ico` | Multi-resolution Windows icon: 16, 24, 32, 48, 64, 128, 256 |
| `macos/linger.icns` | macOS icon with rounded ivory tile and transparent outer corners |
| `macos/linger.iconset/` | macOS 1x and 2x source images, up to 1024 |
| `linux/<size>x<size>/linger.png` | Transparent Linux icons, 16 through 1024 |
| `web/favicon.svg` | Path-only vector favicon on an ivory tile |
| `web/favicon.ico` | Multi-resolution browser fallback: 16, 32, 48, 64 |
| `web/favicon-<size>.png` | PNG favicon sizes: 16, 32, 48, 64 |
| `web/favicon.png` | 512 × 512 PNG fallback |
| `web/apple-touch-icon.png` | 180 × 180 touch icon |
| `web/icon-192.png`, `web/icon-512.png` | Web app icons |
| `web/icon-maskable-192.png`, `web/icon-maskable-512.png` | Maskable icons with extra safe-area padding |
| `web/site.webmanifest` | Icon manifest fragment, with relative image paths |

PNG assets preserve the master's crayon texture. SVG assets contain real paths,
not embedded bitmap images. Their three-color tracing deliberately simplifies
the grain while retaining the irregular hand-drawn contours. Use PNG for the
closest match to the approved artwork and SVG for scalable display.

Small icons omit the wordmark. At 16 pixels the window silhouette remains, but
the character's facial details naturally become less distinct. The warm ivory
favicon background keeps the charcoal outline visible in light and dark tabs.

These are canonical source assets. Existing Web references and desktop packaging
have not been rewired. Copy the required files at build time; do not import
application source across app boundaries. Merge the icon manifest fragment into
the application's manifest instead of treating it as an install-ready manifest.

## Regeneration

On macOS, run `python3 apps/assets/logo/export.py` with Pillow installed to export
PNG, ICO and ICNS files. It uses the system `iconutil` and Helvetica font for the
preview. Run `python3 apps/assets/logo/export-svg.py` with Pillow and
`vtracer==0.6.12` to regenerate SVG files. The master is the sole artwork input;
neither script calls a paid image service. Generation instructions are retained
in `source/prompt.txt`.
