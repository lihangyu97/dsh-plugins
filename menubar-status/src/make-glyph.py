"""Derive the menu bar glyph from the app icon.

The shipped icon is a navy whale on a light rounded square, so the menu bar
needs a template image: alpha only, no colour. Keeping the belly patch and the
eye as holes is what makes the silhouette read as a whale at 17pt — filling
them turns it into a blob.

Usage: python3 make-glyph.py  (writes ../assets/menubar.png + @2x)
"""
from pathlib import Path

import numpy as np
from PIL import Image

SOURCE = "/Applications/DeepSeek Harness.app/Contents/Resources/icon.png"
OUT = Path(__file__).resolve().parent.parent / "assets"
GLYPH_PT = 17

img = Image.open(SOURCE).convert("RGBA")
data = np.asarray(img).astype(np.int16)
rgb, alpha = data[..., :3], data[..., 3]
luminance = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
body = (luminance < 110) & (alpha > 128)

rows, cols = np.nonzero(body)
top, bottom = rows.min(), rows.max()
left, right = cols.min(), cols.max()
crop = Image.fromarray((body[top:bottom + 1, left:right + 1] * 255).astype(np.uint8), "L")

side = max(crop.size)
square = Image.new("L", (side, side), 0)
square.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))

OUT.mkdir(parents=True, exist_ok=True)
for scale, name in ((1, "menubar.png"), (2, "menubar@2x.png")):
    glyph = square.resize((GLYPH_PT * scale, GLYPH_PT * scale), Image.LANCZOS)
    image = Image.new("RGBA", glyph.size, (0, 0, 0, 0))
    image.putalpha(glyph)
    image.save(OUT / name)
    print("wrote", OUT / name, image.size)
