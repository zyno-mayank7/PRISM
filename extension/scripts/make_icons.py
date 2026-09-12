#!/usr/bin/env python3
"""Generate extension icons (Pillow): the OBA wordmark motif —
'OB' with a solid redaction bar standing in for the third glyph,
on a graphite tile with an amber/teal seam."""
from PIL import Image, ImageDraw, ImageFont
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
ICONS = ROOT / "icons"
ICONS.mkdir(exist_ok=True)

def load_font(path: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        font_name = pathlib.Path(path).name
        try:
            return ImageFont.truetype(font_name, size)
        except OSError:
            try:
                fallback_name = "arialbd.ttf" if "Bold" in font_name else "arial.ttf"
                return ImageFont.truetype(fallback_name, size)
            except OSError:
                return ImageFont.load_default()

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def draw_master(size=512):
    S = size
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # tile
    r = S * 0.22
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(26, 30, 35, 255))

    # amber/teal seam across the bottom
    seam_h = S * 0.055
    d.rounded_rectangle([S * 0.18, S * 0.80, S * 0.42, S * 0.80 + seam_h],
                        radius=seam_h / 2, fill=(245, 158, 11, 255))
    d.rounded_rectangle([S * 0.52, S * 0.80, S * 0.82, S * 0.80 + seam_h],
                        radius=seam_h / 2, fill=(20, 184, 166, 255))

    # 'OB' text
    f = load_font(FONT, int(S * 0.34))
    bbox = d.textbbox((0, 0), "OB", font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (S - tw) / 2 - bbox[0] - S * 0.055
    ty = (S * 0.55 - th) / 2 - bbox[1]
    d.text((tx, ty), "OB", font=f, fill=(245, 243, 238, 255))

    # redaction bar standing in for the 'A'
    bar_w, bar_h = S * 0.20, S * 0.34
    d.rounded_rectangle([S - tx - tw - bar_w - S * 0.02, S * 0.55 / 2 - bar_h / 2 + S * 0.05,
                         S - tx - tw - S * 0.02 + bar_w, S * 0.55 / 2 + bar_h / 2 + S * 0.05],
                        radius=S * 0.02, fill=(20, 20, 23, 255))
    return img

master = draw_master(512)
for s in (16, 32, 48, 128):
    master.resize((s, s), Image.LANCZOS).save(ICONS / f"icon{s}.png")
    print("wrote", ICONS / f"icon{s}.png")
