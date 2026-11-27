"""Make the phone's Geist faces from the web's variable font.

The web loads Geist Variable from @fontsource-variable/geist, split into
unicode-range subsets, and uses the weights 400, 470, 580 and 640. React
Native needs one TTF per face, so this pins each weight, merges the subsets
back into one font, and writes assets/fonts/Geist-<Face>.ttf.

Needs fontTools and brotli (`pip install fonttools brotli`):
`python3 apps/mobile/scripts/export-fonts.py`.
"""

from io import BytesIO
from pathlib import Path

from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "node_modules/@fontsource-variable/geist/files"
if not SOURCE.exists():
    SOURCE = next((ROOT / "node_modules/.pnpm").glob(
        "@fontsource-variable+geist@*/node_modules/@fontsource-variable/geist/files"))
OUT = ROOT / "apps/mobile/assets/fonts"
SUBSETS = ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "vietnamese"]
FACES = {"Regular": 400, "Medium": 470, "SemiBold": 580, "Bold": 640}


def pinned(subset: str, weight: int) -> BytesIO:
    font = TTFont(SOURCE / f"geist-{subset}-wght-normal.woff2")
    static = instantiateVariableFont(font, {"wght": weight}, updateFontNames=False)
    static.flavor = None
    buffer = BytesIO()
    static.save(buffer)
    buffer.seek(0)
    return buffer


def rename(font: TTFont, face: str) -> None:
    family = f"Geist-{face}"
    names = font["name"]
    for record in list(names.names):
        if record.nameID in (1, 2, 4, 6, 16, 17):
            names.removeNames(nameID=record.nameID)
    names.setName(family, 1, 3, 1, 0x409)
    names.setName("Regular", 2, 3, 1, 0x409)
    names.setName(family, 4, 3, 1, 0x409)
    names.setName(family, 6, 3, 1, 0x409)


OUT.mkdir(parents=True, exist_ok=True)
for face, weight in FACES.items():
    merged = Merger().merge([pinned(subset, weight) for subset in SUBSETS])
    rename(merged, face)
    merged.save(OUT / f"Geist-{face}.ttf")
    print(f"Geist-{face}.ttf")
