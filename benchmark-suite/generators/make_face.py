#!/usr/bin/env python3
"""Generate the synthetic KYC face asset (benchmark-suite/demo-pages/assets/kyc-face.png).

Deliberately synthetic: a stylized portrait whose skin-tone distribution
passes the YCbCr skin-chroma window, so the client's vision tier detects a
face region exactly like it would on a real photo — with zero privacy
concerns (no human likeness, reproducible from source).
"""
from PIL import Image, ImageDraw, ImageFilter
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "demo-pages" / "assets" / "kyc-face.png"
S = 300

SKIN = (232, 181, 140)
SKIN_SHADE = (208, 155, 116)
HAIR = (58, 44, 38)
BG = (36, 48, 66)
EYE = (30, 30, 34)
LIPS = (168, 92, 84)
WHITE = (245, 245, 242)

img = Image.new("RGB", (S, S), BG)
d = ImageDraw.Draw(img)

# shoulders
d.ellipse([S * 0.05, S * 0.72, S * 0.95, S * 1.5], fill=(70, 84, 105))
# neck
d.rectangle([S * 0.42, S * 0.52, S * 0.58, S * 0.78], fill=SKIN_SHADE)
# hair mass
d.ellipse([S * 0.18, S * 0.02, S * 0.82, S * 0.62], fill=HAIR)
# face oval
d.ellipse([S * 0.25, S * 0.13, S * 0.75, S * 0.66], fill=SKIN)
# forehead fringe
d.pieslice([S * 0.25, S * 0.06, S * 0.75, S * 0.52], 180, 360, fill=HAIR)
# eyes
for cx in (S * 0.375, S * 0.625):
    d.ellipse([cx - 17, S * 0.335 - 8, cx + 17, S * 0.335 + 8], fill=WHITE)
    d.ellipse([cx - 8, S * 0.335 - 6, cx + 8, S * 0.335 + 6], fill=EYE)
    d.ellipse([cx - 3, S * 0.335 - 3, cx + 3, S * 0.335 + 3], fill=(10, 10, 12))
    d.arc([cx - 20, S * 0.285, cx + 20, S * 0.33], 200, 340, fill=HAIR, width=4)
# nose
d.line([(S * 0.5, S * 0.40), (S * 0.5, S * 0.47)], fill=SKIN_SHADE, width=5)
d.arc([S * 0.44, S * 0.44, S * 0.56, S * 0.52], 20, 160, fill=SKIN_SHADE, width=5)
# lips
d.ellipse([S * 0.415, S * 0.525, S * 0.585, S * 0.575], fill=LIPS)
# ears
for cx in (S * 0.245, S * 0.755):
    d.ellipse([cx - 10, S * 0.37, cx + 10, S * 0.45], fill=SKIN_SHADE)
# shirt collar
d.polygon([(S * 0.36, S * 0.75), (S * 0.5, S * 0.88), (S * 0.64, S * 0.75)],
          fill=(226, 232, 238))

img = img.filter(ImageFilter.GaussianBlur(0.6))
img.save(OUT)
print("wrote", OUT)
