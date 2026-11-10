"""Produce real path-only SVG assets (Pillow and vtracer 0.6.12 required)."""

from pathlib import Path
from tempfile import TemporaryDirectory
import re
import vtracer
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent

with TemporaryDirectory() as temporary:
    for name in ['logo-mark', 'logo-wordmark', 'logo-stacked', 'logo-horizontal']:
        image = Image.open(ROOT / f'{name}.png').convert('RGBA')
        image = ImageOps.contain(image, (1200, 1200), Image.Resampling.LANCZOS)
        pixels = []
        # Three flat colors retain the contours without tracing every crayon grain.
        for r, g, b, alpha in image.getdata():
            if alpha < 128:
                pixels.append((0, 0, 0, 0))
            elif r > 150 and g > 90 and r - b > 65:
                pixels.append((240, 185, 77, 255))
            elif r > 160 and g > 150 and b > 130:
                pixels.append((250, 247, 239, 255))
            else:
                pixels.append((48, 43, 37, 255))
        image.putdata(pixels)
        path = Path(temporary) / f'{name}.png'
        image.save(path)
        target = ROOT / f'{name}.svg'
        vtracer.convert_image_to_svg_py(str(path), str(target), colormode='color',
            hierarchical='stacked', mode='spline', filter_speckle=12,
            color_precision=6, layer_difference=16, corner_threshold=60,
            length_threshold=4, max_iterations=10, splice_threshold=45,
            path_precision=2)
        svg = target.read_text()
        svg = svg.replace('<svg ', f'<svg viewBox="0 0 {image.width} {image.height}" ', 1)
        target.write_text(svg)
    source = (ROOT / 'logo-mark.svg').read_text()
    width, height = map(int, re.search(r'viewBox="0 0 (\d+) (\d+)"', source).groups())
    size = max(width, height)
    padding = round(size * 0.07)
    edge = size + padding * 2
    content = source[source.index('>')+1:] if source.startswith('<svg') else source[source.index('<svg'):]
    content = content[content.index('>')+1:content.rindex('</svg>')]
    favicon = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {edge} {edge}"><rect width="{edge}" height="{edge}" rx="{edge*0.15}" fill="#faf7ef"/><g transform="translate({(edge-width)/2} {(edge-height)/2})">{content}</g></svg>'
    (ROOT / 'web/favicon.svg').write_text(favicon)
print('Exported four path-only logos and favicon.svg.')
