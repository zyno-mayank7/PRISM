#!/usr/bin/env python3
"""OBA benchmark evaluator — computes the five competition metrics.

Crucial design point: every client-side number comes from executing the
REAL extension modules (dom-detector, vision-detector, canvas-redactor,
vault) against deterministic synthetic fixtures via Node — not from a
re-implementation. Server latency is measured against the real FastAPI
app (in-process TestClient, mock provider).

Metrics (competition weights):
  1  Visual context accuracy          25%
  2  PII detection precision/recall   20%
  3  Precision of redaction           20%
  4  Client-side resource utilization 20%
  5  End-to-end latency               15%

Run:  python3 evaluator.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
SERVER_DIR = ROOT.parent / "server"
REPORTS = ROOT / "reports"
def load_font(path: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        font_name = Path(path).name
        try:
            return ImageFont.truetype(font_name, size)
        except OSError:
            try:
                fallback_name = "arialbd.ttf" if "Bold" in font_name else "arial.ttf"
                return ImageFont.truetype(fallback_name, size)
            except OSError:
                return ImageFont.load_default()

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

PAGES = ["login-form", "checkout-form", "kyc-portal"]
WEIGHTS = {"m1": 0.25, "m2": 0.20, "m3": 0.20, "m4": 0.20, "m5": 0.15}


# --------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------- #

def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def iou(a: dict, b: dict) -> float:
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]
    ix = max(0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0, min(ay2, by2) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def union_box(boxes: list[dict]) -> dict | None:
    if not boxes:
        return None
    x = min(b["x"] for b in boxes); y = min(b["y"] for b in boxes)
    x2 = max(b["x"] + b["width"] for b in boxes)
    y2 = max(b["y"] + b["height"] for b in boxes)
    return {"x": x, "y": y, "width": x2 - x, "height": y2 - y}


def overlap_area(a: dict, b: dict) -> float:
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]
    ix = max(0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0, min(ay2, by2) - max(a["y"], b["y"]))
    return ix * iy


def run_node_runner() -> None:
    for page in PAGES:
        subprocess.run(
            ["node", str(ROOT / "runner" / "run_detection.js"), str(ROOT / "fixtures" / page), "10"],
            check=True, cwd=ROOT)


def measure_server_latency() -> tuple[float, dict]:
    """In-process FastAPI measurement with the deterministic mock provider."""
    sys.path.insert(0, str(SERVER_DIR))
    from fastapi.testclient import TestClient
    import main as main_mod
    from agent.planner import MockPlanner

    main_mod._PLANNER = MockPlanner()
    with TestClient(main_mod.app) as client:
        lat = []
        for i, page in enumerate(PAGES):
            els = json.loads((ROOT / "fixtures" / page / "sanitized_elements.json").read_text(encoding="utf-8"))
            payload = {
                "task": f"Benchmark task for {page}",
                "screenshot_base64": "",
                "dom_elements": els,
                "viewport": {"width": 1280, "height": 800},
                "url": f"http://127.0.0.1:8080/demo-pages/{page}.html",
                "step_index": i,
                "session_id": f"bench-{page}",
            }
            for _ in range(20):
                t0 = time.perf_counter()
                r = client.post("/api/agent/step", json=payload)
                dt = (time.perf_counter() - t0) * 1000
                assert r.status_code == 200, r.text
                lat.append(dt)
    main_mod._PLANNER = None
    sys.path.pop(0)
    for mod in [m for m in list(sys.modules) if m.startswith(("main", "agent", "models"))]:
        del sys.modules[mod]
    avg = sum(lat) / len(lat)
    return avg, {"calls": len(lat), "p95": sorted(lat)[int(len(lat) * 0.95) - 1]}


# --------------------------------------------------------------------- #
# metric computation
# --------------------------------------------------------------------- #

def metric1_context(gts: dict, results: dict) -> dict:
    """F1 over interactive element perception (selector match)."""
    tp = fp = fn = 0
    per_page = {}
    for page in PAGES:
        gt = gts[page]
        expected = {
            e["selector"] for e in gt["elements"]
            if e.get("visible", True) and e["tag"] not in ("img", "span")
        }
        reported = {c["selector"] for c in results[page]["domContext"]}
        tp_p = len(expected & reported)
        fp_p = len(reported - expected)
        fn_p = len(expected - reported)
        p = tp_p / max(1, tp_p + fp_p)
        r = tp_p / max(1, tp_p + fn_p)
        f1 = 2 * p * r / max(1e-9, p + r)
        per_page[page] = {"precision": p, "recall": r, "f1": f1,
                          "tp": tp_p, "fp": fp_p, "fn": fn_p}
        tp += tp_p; fp += fp_p; fn += fn_p
    p = tp / max(1, tp + fp); r = tp / max(1, tp + fn)
    f1 = 2 * p * r / max(1e-9, p + r)
    return {"score": 100 * f1, "f1": f1,
            "precision": p, "recall": r, "per_page": per_page,
            "tp": tp, "fp": fp, "fn": fn}


def metric2_pii(gts: dict, results: dict) -> dict:
    """Precision/recall over sensitive elements + faces."""
    tp = fp = fn = 0
    details = []
    for page in PAGES:
        gt = gts[page]
        gt_sensitive = {
            e["selector"] for e in gt["elements"] if e.get("sensitive") and e.get("visible", True)
        }
        faces = gt.get("faces", [])
        matched_gt = set()
        page_tp = page_fp = page_fn = 0
        for d in results[page]["detections"]:
            hit = None
            if d["selector"] and d["selector"] in gt_sensitive:
                hit = d["selector"]
                matched_gt.add(hit)
            elif faces:
                best = max((iou(d["box"], f["box"]), i) for i, f in enumerate(faces))
                if best[0] >= 0.3:
                    hit = f"face[{best[1]}]"
                    matched_gt.add(hit)
            if hit:
                page_tp += 1
            else:
                page_fp += 1
                details.append(f"{page}: FP {d['selector'] or 'vision-box'} as {d['piiType']}")
        page_fn += len((gt_sensitive | {f"face[{i}]" for i in range(len(faces))}) - matched_gt)
        tp += page_tp; fp += page_fp; fn += page_fn
        details.append(f"{page}: TP={page_tp} FP={page_fp} FN={page_fn}")
    p = tp / max(1, tp + fp)
    r = tp / max(1, tp + fn)
    f1 = 2 * p * r / max(1e-9, p + r)
    return {"score": 100 * f1, "precision": p, "recall": r, "f1": f1,
            "tp": tp, "fp": fp, "fn": fn, "details": details}


def metric3_redaction(gts: dict, results: dict, raws: dict) -> dict:
    """IoU + coverage + over-redaction, gated by verification & pixel change."""
    ious, coverages = [], []
    overmask_num = overmask_den = 0.0
    gates_ok = True
    per_page = {}
    for page in PAGES:
        gt = gts[page]
        res = results[page]
        if not res["verification"]["ok"]:
            gates_ok = False
        if not res["leak"]["vaultValuesOk"] or not res["leak"]["gtRawValuesBlocked"]:
            gates_ok = False

        gt_boxes = [e["rect"] for e in gt["elements"]
                    if e.get("sensitive") and e.get("visible", True) and e["tag"] != "img"]
        img_faces = [e["rect"] for e in gt["elements"]
                     if e.get("sensitive") and e.get("visible", True) and e["tag"] == "img"]
        gt_regions = gt_boxes + img_faces          # face GT is inside the photo region
        applied = [a["box"] for a in res["appliedBoxes"]]

        page_ious = []
        for gtb in gt_regions:
            best = max((iou(gtb, ab) for ab in applied), default=0.0)
            page_ious.append(best)
            cov = sum(overlap_area(gtb, ab) for ab in applied) / max(1e-9, gtb["width"] * gtb["height"])
            coverages.append(min(1.0, cov))

        ap_union = union_box(applied) if applied else None
        gt_union = union_box(gt_regions) if gt_regions else None
        if ap_union and gt_union:
            inter = overlap_area(ap_union, gt_union)
            ap_area = ap_union["width"] * ap_union["height"]
            gt_area = gt_union["width"] * gt_union["height"]
            # rough decomposition: applied area outside the GT union
            outside = max(0.0, ap_area - inter)
            overmask_num += outside
            overmask_den += ap_area

        # pixel-mutation gate: sensitive regions must visibly change
        raw_img = raws[page][0]
        red_img = raws[page][1]
        for gtb in gt_regions:
            box = (gtb["x"], gtb["y"], gtb["x"] + gtb["width"], gtb["y"] + gtb["height"])
            r1 = raw_img.crop(box).resize((16, 16))
            r2 = red_img.crop(box).resize((16, 16))
            p1 = list(r1.get_flattened_data()) if hasattr(r1, 'get_flattened_data') else list(r1.getdata())
            p2 = list(r2.get_flattened_data()) if hasattr(r2, 'get_flattened_data') else list(r2.getdata())
            diff = sum(abs(a[i] - b[i]) for a, b in zip(p1, p2) for i in range(3)) / max(1, len(p1))
            if diff < 20:
                gates_ok = False

        ious.extend(page_ious)
        per_page[page] = {
            "meanIoU": round(sum(page_ious) / max(1, len(page_ious)), 3),
            "applied": len(applied), "gtRegions": len(gt_regions),
            "verification": res["verification"]["ok"],
        }

    mean_iou = sum(ious) / max(1, len(ious))
    mean_cov = sum(coverages) / max(1, len(coverages))
    overmask = overmask_num / max(1e-9, overmask_den)
    penalty = clamp((overmask - 0.10) / 0.40, 0.0, 0.5)
    score = 100 * (0.45 * mean_iou + 0.55 * mean_cov) * (1 - penalty)
    if not gates_ok:
        score = 0.0
    return {"score": score, "meanIoU": mean_iou, "meanCoverage": mean_cov,
            "overmaskRatio": overmask, "penalty": penalty,
            "gatesOk": gates_ok, "per_page": per_page}


def metric4_resource(results: dict) -> dict:
    heap = sum(r["heap"]["heapUsedMB"] for r in results.values()) / len(results)
    infer = sum(r["timings"]["inferenceMs"] for r in results.values()) / len(results)
    mem_score = 1 - clamp((heap - 60) / (250 - 60), 0, 1)
    lat_score = 1 - clamp((infer - 150) / (700 - 150), 0, 1)
    return {"score": 100 * (0.5 * mem_score + 0.5 * lat_score),
            "heapMB": round(heap, 1), "inferenceMs": round(infer, 2),
            "memScore": round(mem_score, 3), "latencyScore": round(lat_score, 3)}


def metric5_latency(results: dict, server_ms: float) -> dict:
    infer = sum(r["timings"]["inferenceMs"] for r in results.values()) / len(results)
    redact = sum(r["timings"]["redactMs"] for r in results.values()) / len(results)
    cycle = infer + redact + server_ms
    score = 1 - clamp((cycle - 600) / (2500 - 600), 0, 1)
    return {"score": 100 * score, "cycleMs": round(cycle, 1),
            "perceptionMs": round(infer, 2), "redactionMs": round(redact, 2),
            "serverMs": round(server_ms, 2),
            "note": "captureVisibleTab + DOM serialize run in-browser; live "
                    "numbers appear in the sidepanel telemetry bar"}


# --------------------------------------------------------------------- #
# report rendering
# --------------------------------------------------------------------- #

def render_compare_images(gts: dict, results: dict, raws: dict) -> None:
    img_dir = REPORTS / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    for page in PAGES:
        raw, red = raws[page]
        W, H = raw.width, raw.height
        pad, cap = 12, 46
        canvas = Image.new("RGB", (W * 2 + pad * 3, H + cap + pad * 2), (12, 16, 22))
        canvas.paste(raw, (pad, cap + pad))
        canvas.paste(red, (W + pad * 2, cap + pad))
        d = ImageDraw.Draw(canvas)
        d.text((pad, 14), "RAW — stays on the device", font=load_font(FONT_B, 18), fill=(245, 158, 11))
        d.text((W + pad * 2, 14), "SANITIZED — transmitted to the server",
               font=load_font(FONT_B, 18), fill=(20, 184, 166))
        for a in results[page]["appliedBoxes"]:
            b = a["box"]
            col = (245, 158, 11) if a["mode"] == "blackout" else (20, 184, 166)
            d.rectangle([W + pad * 2 + b["x"], cap + pad + b["y"],
                         W + pad * 2 + b["x"] + b["width"], cap + pad + b["y"] + b["height"]],
                        outline=col, width=2)
        out = img_dir / f"{page}.png"
        canvas.save(out)


def fmt_row(cells: list, widths: list) -> str:
    return "  " + "  ".join(str(c).ljust(w) for c, w in zip(cells, widths)).rstrip()


def build_report(m: dict, composite: float) -> str:
    lines = []
    lines.append("# OBA Benchmark Report")
    lines.append("")
    lines.append("All client-side numbers are produced by executing the **real extension")
    lines.append("modules** (`dom-detector.js`, `vision-detector.js`, `canvas-redactor.js`,")
    lines.append("`vault.js`) over deterministic synthetic fixtures — the same code paths")
    lines.append("that run inside the browser.")
    lines.append("")
    rows = [
        ("1  Visual context accuracy", "25%", f"F1 = {m['m1']['f1']:.3f} (P={m['m1']['precision']:.3f}, R={m['m1']['recall']:.3f})", f"{m['m1']['score']:.1f}"),
        ("2  PII detection", "20%", f"F1 = {m['m2']['f1']:.3f} (P={m['m2']['precision']:.3f}, R={m['m2']['recall']:.3f})", f"{m['m2']['score']:.1f}"),
        ("3  Precision of redaction", "20%", f"IoU={m['m3']['meanIoU']:.3f}, coverage={m['m3']['meanCoverage']:.3f}, overmask={m['m3']['overmaskRatio']:.3f}", f"{m['m3']['score']:.1f}"),
        ("4  Client resources", "20%", f"heap={m['m4']['heapMB']} MB, inference={m['m4']['inferenceMs']} ms", f"{m['m4']['score']:.1f}"),
        ("5  End-to-end latency", "15%", f"cycle={m['m5']['cycleMs']} ms (perceive+redact+reason)", f"{m['m5']['score']:.1f}"),
    ]
    widths = [28, 6, 62, 8]
    lines.append(fmt_row(["Metric", "Wt", "Measurement", "Score"], widths))
    lines.append(fmt_row(["-" * 28, "-" * 6, "-" * 62, "-" * 8], widths))
    for r in rows:
        lines.append(fmt_row(r, widths))
    lines.append("")
    lines.append(f"**Weighted composite: {composite:.1f} / 100**")
    lines.append("")
    lines.append("## Scoring formulas (transparent by design)")
    lines.append("")
    lines.append("1. `score = 100 × F1` of reported interactive elements vs ground truth (selector match; hidden decoys must be excluded).")
    lines.append("2. `score = 100 × F1` over sensitive elements + face regions (vision boxes matched at IoU ≥ 0.3).")
    lines.append("3. `score = 100 × (0.45·meanIoU + 0.55·meanCoverage) × (1 − overmaskPenalty)` — hard-gated on per-block constancy verification, pixel-mutation, and the zero-leak assertion.")
    lines.append("4. `score = 100 × (0.5·memScore + 0.5·latScore)`, memScore linear 60→250 MB, latScore linear 150→700 ms.")
    lines.append("5. `score = 100 × (1 − (cycle−600)/(2500−600))`, cycle = perception + redaction + server round-trip (mock provider, in-process).")
    lines.append("")
    lines.append("## Per-page details")
    for page in PAGES:
        lines.append(f"\n### {page}")
        lines.append(f"- context: {json.dumps(m['m1']['per_page'][page])}")
        lines.append(f"- redaction: {json.dumps(m['m3']['per_page'][page])}")
    lines.append("")
    lines.append("## Privacy gates")
    for page in PAGES:
        res = m["_results"][page]
        lines.append(f"- {page}: block-constancy verification {'PASS' if res['verification']['ok'] else 'FAIL'}, "
                     f"leak assertion {'PASS' if res['leak']['vaultValuesOk'] else 'FAIL'}, "
                     f"GT raw values blocked from payload {'PASS' if res['leak']['gtRawValuesBlocked'] else 'FAIL'}, "
                     f"tokens emitted: {res['leak']['tokens']}")
    return "\n".join(lines)


def main() -> None:
    print("OBA benchmark evaluator")
    print("=" * 72)

    # 1) run the real client code over the fixtures
    run_node_runner()

    gts, results, raws = {}, {}, {}
    for page in PAGES:
        fdir = ROOT / "fixtures" / page
        gts[page] = json.loads((fdir / "gt.json").read_text(encoding="utf-8"))
        results[page] = json.loads((fdir / "results.json").read_text(encoding="utf-8"))
        W, H = gts[page]["layout"]["width"], gts[page]["layout"]["height"]
        raw_img = Image.frombytes("RGBA", (W, H), (fdir / "raw.bin").read_bytes()).convert("RGB")
        red_img = Image.frombytes("RGBA", (W, H), (fdir / "redacted.bin").read_bytes()).convert("RGB")
        raws[page] = (raw_img, red_img)

    # 2) server latency (real FastAPI app, deterministic provider)
    server_ms, server_stats = measure_server_latency()

    # 3) metrics
    m = {
        "m1": metric1_context(gts, results),
        "m2": metric2_pii(gts, results),
        "m3": metric3_redaction(gts, results, raws),
        "m4": metric4_resource(results),
        "m5": metric5_latency(results, server_ms),
    }
    composite = sum(WEIGHTS[k] * m[k]["score"] for k in WEIGHTS)

    # 4) outputs
    REPORTS.mkdir(exist_ok=True)
    render_compare_images(gts, results, raws)
    report_md = build_report({**{k: v for k, v in m.items()}, "_results": results}, composite)
    (REPORTS / "report.md").write_text(report_md + "\n", encoding="utf-8")
    (REPORTS / "report.json").write_text(json.dumps(
        {"composite": round(composite, 1), "weights": WEIGHTS,
         "metrics": {k: {kk: vv for kk, vv in v.items() if kk != "per_page"}
                     for k, v in m.items()},
         "per_page": {k: v["per_page"] for k, v in m.items() if "per_page" in v},
         "server": server_stats}, indent=1), encoding="utf-8")

    # 5) console summary
    print()
    print(fmt_row(["Metric", "Wt", "Measurement", "Score"], [36, 5, 55, 8]))
    print("-" * 108)
    print(fmt_row(["1 Visual context accuracy", "25%",
                   f"F1 {m['m1']['f1']:.3f}  P {m['m1']['precision']:.3f}  R {m['m1']['recall']:.3f}",
                   f"{m['m1']['score']:.1f}"], [36, 5, 55, 8]))
    print(fmt_row(["2 PII detection (P/R)", "20%",
                   f"F1 {m['m2']['f1']:.3f}  P {m['m2']['precision']:.3f}  R {m['m2']['recall']:.3f}",
                   f"{m['m2']['score']:.1f}"], [36, 5, 55, 8]))
    print(fmt_row(["3 Precision of redaction", "20%",
                   f"IoU {m['m3']['meanIoU']:.3f}  cov {m['m3']['meanCoverage']:.3f}  over {m['m3']['overmaskRatio']:.3f}",
                   f"{m['m3']['score']:.1f}"], [36, 5, 55, 8]))
    print(fmt_row(["4 Client resources", "20%",
                   f"heap {m['m4']['heapMB']} MB  inference {m['m4']['inferenceMs']} ms",
                   f"{m['m4']['score']:.1f}"], [36, 5, 55, 8]))
    print(fmt_row(["5 End-to-end latency", "15%",
                   f"cycle {m['m5']['cycleMs']} ms  (server {m['m5']['serverMs']} ms)",
                   f"{m['m5']['score']:.1f}"], [36, 5, 55, 8]))
    print("-" * 108)
    print(f"  WEIGHTED COMPOSITE: {composite:.1f} / 100")
    print()
    print(f"  report   : {REPORTS / 'report.md'}")
    print(f"  images   : {REPORTS / 'images'}/<page>.png (raw vs sanitized)")
    print(f"  gates    : redaction verification + zero-leak assertions "
          f"{'ALL PASS' if m['m3']['gatesOk'] else 'FAILED'}")


if __name__ == "__main__":
    main()
