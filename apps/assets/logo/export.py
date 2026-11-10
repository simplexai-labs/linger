"""Export platform assets from the approved Sunburst master (Pillow required)."""

from pathlib import Path
import json
import subprocess
from PIL import Image, ImageOps, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
PAPER = '#faf7ef'
RESAMPLE = Image.Resampling.LANCZOS


def save(image, name):
    path = ROOT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def fit(image, size, fraction=0.84, background=(0, 0, 0, 0)):
    canvas = Image.new('RGBA', (size, size), background)
    thumb = ImageOps.contain(image, (round(size*fraction), round(size*fraction)), RESAMPLE)
    canvas.alpha_composite(thumb, ((size-thumb.width)//2, (size-thumb.height)//2))
    return canvas


def trim(image):
    # Ignore nearly invisible alpha noise when finding the artwork bounds.
    bounds = image.getchannel('A').point(lambda value: 255 if value > 32 else 0).getbbox()
    return image.crop(bounds)


master = Image.open(ROOT / 'source/linger-window-sunburst.png').convert('RGBA')
assert master.size == (2048, 2048)
# The generated master has a verified empty band between emblem and lettering.
mark = trim(master.crop((0, 0, 2048, 1165)))
wordmark = trim(master.crop((0, 1165, 2048, 2048)))
logo = trim(master)
save(mark, 'logo-mark.png')
save(wordmark, 'logo-wordmark.png')
save(logo, 'logo-stacked.png')
height = 320
left = ImageOps.contain(mark, (440, height), RESAMPLE)
right = ImageOps.contain(wordmark, (780, 210), RESAMPLE)
horizontal = Image.new('RGBA', (left.width+64+right.width, height))
horizontal.alpha_composite(left, (0, (height-left.height)//2))
horizontal.alpha_composite(right, (left.width+64, (height-right.height)//2))
save(horizontal, 'logo-horizontal.png')

app = fit(mark, 1024, 0.82, PAPER)
save(app, 'app-icon.png')
for size in [16, 24, 32, 48, 64, 128, 256, 512, 1024]:
    save(fit(mark, size, 0.90), f'linux/{size}x{size}/linger.png')
for size in [16, 32, 48, 64]:
    save(fit(mark, size, 0.92, PAPER), f'web/favicon-{size}.png')
save(fit(mark, 512, 0.92, PAPER), 'web/favicon.png')
save(fit(mark, 180, 0.80, PAPER), 'web/apple-touch-icon.png')
for size in [192, 512]:
    save(fit(mark, size, 0.82, PAPER), f'web/icon-{size}.png')
    save(fit(mark, size, 0.68, PAPER), f'web/icon-maskable-{size}.png')
(ROOT / 'windows').mkdir(exist_ok=True)
fit(mark, 256, 0.90).save(ROOT / 'windows/linger.ico', sizes=[(x,x) for x in [16,24,32,48,64,128,256]])
fit(mark, 64, 0.92, PAPER).save(ROOT / 'web/favicon.ico', sizes=[(x,x) for x in [16,32,48,64]])
iconset = ROOT / 'macos/linger.iconset'
iconset.mkdir(parents=True, exist_ok=True)
# A rounded tile supplies a consistent macOS dock silhouette.
tile = Image.new('RGBA', (1024,1024))
ImageDraw.Draw(tile).rounded_rectangle((64,64,960,960), radius=196, fill=PAPER)
thumb = ImageOps.contain(mark,(740,740),RESAMPLE)
tile.alpha_composite(thumb,((1024-thumb.width)//2,(1024-thumb.height)//2))
for base in [16,32,128,256,512]:
    for scale in [1,2]:
        suffix = '@2x' if scale == 2 else ''
        tile.resize((base*scale,base*scale),RESAMPLE).save(iconset/f'icon_{base}x{base}{suffix}.png')
subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(ROOT/'macos/linger.icns')],check=True)
manifest = {'name':'Linger','short_name':'Linger','icons':[
    {'src':f'icon-{size}.png','sizes':f'{size}x{size}','type':'image/png','purpose':'any'} for size in [192,512]
] + [
    {'src':f'icon-maskable-{size}.png','sizes':f'{size}x{size}','type':'image/png','purpose':'maskable'} for size in [192,512]
]}
(ROOT/'web/site.webmanifest').write_text(json.dumps(manifest,indent=2)+'\n')
preview = Image.new('RGBA',(1600,1100),PAPER)
big = ImageOps.contain(logo,(750,960),RESAMPLE)
preview.alpha_composite(big,(50,(1100-big.height)//2))
preview.alpha_composite(tile.resize((400,400),RESAMPLE),(980,80))
font=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',24)
draw=ImageDraw.Draw(preview)
draw.text((1000,500),'App icon',font=font,fill='#302b25')
for x,size in [(900,16),(1000,32),(1130,48),(1300,64)]:
    preview.alpha_composite(fit(mark,size,0.92,PAPER),(x,650))
    draw.text((x,740),f'{size}px',font=font,fill='#302b25')
preview.convert('RGB').save(ROOT/'preview.jpg',quality=95)
print('Exported raster assets, ICO, ICNS and preview.')
