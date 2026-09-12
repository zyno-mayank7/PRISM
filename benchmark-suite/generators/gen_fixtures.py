#!/usr/bin/env python3
"""OBA benchmark fixture generator.

Reads ground-truth specs (ground-truth/*.json) and renders deterministic
synthetic 1280x800 screenshots that replicate each demo page's layout:
  fixtures/<page>/raw.bin        RGBA pixel buffer (the "screenshot")
  fixtures/<page>/preview.png    same image as PNG (before/after visuals)
  fixtures/<page>/elements.json  serialized-DOM-equivalent detector input
                                 (ground-truth flags stripped — the detector
                                 must discover sensitivity on its own)
  fixtures/<page>/gt.json        copy of the ground truth for scorers

Deterministic: no timing, no randomness — benchmark scores are reproducible.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
GT_DIR = ROOT / "ground-truth"
FIX_DIR = ROOT / "fixtures"
FACE = ROOT / "demo-pages" / "assets" / "kyc-face.png"

FONT_R = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

BG = (15, 23, 42)
HEADER = (17, 26, 46)
CARD = (30, 41, 59)
CARD_LINE = (51, 65, 85)
FIELD = (11, 18, 32)
FIELD_LINE = (51, 65, 85)
LABEL_C = (148, 163, 184)
VALUE_C = (226, 232, 240)
HINT_C = (100, 116, 139)
WHITE = (245, 245, 242)
BADGE_C = (245, 158, 11)


def f(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def render_page(gt: dict) -> Image.Image:
    W = gt["layout"]["width"]
    H = gt["layout"]["height"]
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # ---- top bar ----
    d.rectangle([0, 0, W, 64], fill=HEADER)
    d.text((28, 20), gt["title"], font=f(FONT_B, 17), fill=WHITE)
    badge = gt.get("badge", "")
    bw = d.textlength(badge, font=f(FONT_R, 12)) if badge else 0
    d.text((W - 28 - bw, 24), badge, font=f(FONT_R, 12), fill=BADGE_C)

    # ---- card ----
    visible = [e for e in gt["elements"] if e.get("visible", True)]
    ys = [e["rect"]["y"] + e["rect"]["height"] for e in visible] + [e["rect"]["y"] for e in visible]
    card = [330, 96, 950, max(ys) + 30]
    rrect(d, card, 12, fill=CARD, outline=CARD_LINE, width=1)

    # ---- elements ----
    for el in gt["elements"]:
        if not el.get("visible", True):
            continue
        r = el["rect"]
        box = [r["x"], r["y"], r["x"] + r["width"], r["y"] + r["height"]]
        tag, render = el["tag"], el.get("render")

        if render == "captcha":
            rrect(d, box, 5, fill=(248, 250, 252), outline=(203, 213, 225), width=2)
            txt = el.get("text", "A7X3")
            for i, ch in enumerate(txt):
                col = BADGE_C if i % 2 == 0 else (20, 184, 166)
                d.text((r["x"] + 18 + i * 26, r["y"] + 5), ch, font=f(FONT_B, 18), fill=col)
            continue

        if tag == "img":
            face = Image.open(FACE).convert("RGB").resize((r["width"], r["height"]))
            mask = Image.new("L", face.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, face.width, face.height], radius=10, fill=255)
            img.paste(face, (r["x"], r["y"]), mask)
            d.text((r["x"] + 30, r["y"] + r["height"] + 8), "Applicant photo",
                   font=f(FONT_R, 11), fill=HINT_C)
            continue

        if tag == "button":
            grad = Image.new("RGB", (r["width"], r["height"]))
            gd = ImageDraw.Draw(grad)
            for x in range(r["width"]):
                t = x / max(1, r["width"])
                gd.line([(x, 0), (x, r["height"])],
                        fill=(int(8 + (124 - 8) * t), int(145 + (58 - 145) * t), int(178 + (237 - 178) * t)))
            mask = Image.new("L", grad.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, r["width"], r["height"]], radius=8, fill=255)
            img.paste(grad, (r["x"], r["y"]), mask)
            txt = el.get("text", "")
            tf = f(FONT_B, 15)
            tw = d.textlength(txt, font=tf)
            d.text((r["x"] + (r["width"] - tw) / 2, r["y"] + 12), txt, font=tf, fill=WHITE)
            continue

        if tag == "input" and el.get("type") == "checkbox":
            d.text((r["x"], r["y"] - 22), el.get("label", ""), font=f(FONT_R, 12), fill=LABEL_C)
            rrect(d, box, 4, fill=FIELD, outline=(100, 116, 139), width=2)
            d.text((r["x"] + 30, r["y"] + 1), el.get("label", ""), font=f(FONT_R, 12), fill=VALUE_C)
            continue

        # generic field: label above, box, value inside
        d.text((r["x"], r["y"] - 22), el.get("label", ""), font=f(FONT_R, 12), fill=LABEL_C)
        rrect(d, box, 5, fill=FIELD, outline=FIELD_LINE, width=1)
        if el.get("placeholder") and not el.get("value"):
            d.text((r["x"] + 10, r["y"] + 7), el["placeholder"], font=f(FONT_R, 13), fill=HINT_C)
        elif el.get("value"):
            val = el["value"]
            if el.get("type") == "password":
                # realistic password masking — the raw string is in the GT for
                # the leak assertion; on screen it renders masked
                val = "•" * min(12, len(val))
            d.text((r["x"] + 10, r["y"] + 7), val, font=f(FONT_R, 13), fill=VALUE_C)
        if tag == "select":
            d.polygon([(r["x"] + r["width"] - 22, r["y"] + 12),
                       (r["x"] + r["width"] - 10, r["y"] + 12),
                       (r["x"] + r["width"] - 16, r["y"] + 22)], fill=LABEL_C)
        if el.get("hint"):
            d.text((r["x"], r["y"] + r["height"] + 5), el["hint"], font=f(FONT_R, 10), fill=HINT_C)

    return img


def build_elements_json(gt: dict) -> dict:
    """Detector input — what the content serializer would produce live.
    Ground-truth verdicts (sensitive/piiType/mode) are stripped."""
    STRIP = {"sensitive", "piiType", "mode", "tokenKind", "hint", "render", "note"}
    elements = []
    for el in gt["elements"]:
        if el["tag"] == "span":     # spans are not serialized by the content script
            continue
        rec = {k: v for k, v in el.items() if k not in STRIP}
        rec.setdefault("classes", rec.pop("classes", []) or [])
        elements.append(rec)
    return {
        "url": f"http://127.0.0.1:8080/demo-pages/{gt['page']}.html",
        "title": gt["title"],
        "viewport": {"width": gt["layout"]["width"], "height": gt["layout"]["height"], "dpr": 1},
        "elements": elements,
    }


def main() -> None:
    if FIX_DIR.exists():
        shutil.rmtree(FIX_DIR)
    FIX_DIR.mkdir(parents=True)
    for gt_file in sorted(GT_DIR.glob("*.json")):
        gt = json.loads(gt_file.read_text())
        page = gt["page"]
        out = FIX_DIR / page
        out.mkdir()
        img = render_page(gt)
        img.save(out / "preview.png")
        (out / "raw.bin").write_bytes(img.convert("RGBA").tobytes())
        (out / "elements.json").write_text(json.dumps(build_elements_json(gt), indent=1))
        (out / "gt.json").write_text(json.dumps(gt, indent=1))
        print(f"fixture: {page}  ({len(gt['elements'])} gt elements, "
              f"{len(build_elements_json(gt)['elements'])} serialized)")
    print("fixtures written to", FIX_DIR)


if __name__ == "__main__":
    main()
