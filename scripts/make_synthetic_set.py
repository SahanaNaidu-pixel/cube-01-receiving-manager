"""Generate a small SYNTHETIC smoke-test set for scripts/evaluate.py.

These images are drawn with Pillow. They exercise the pipeline (upload, analyze, report) end to end and
give a vision model something plausible to read, but results on them are NOT accuracy evidence for
real receiving photos. See eval/README.md.

Usage (from the repo root):
    ../.venv/Scripts/python.exe scripts/make_synthetic_set.py [--out eval/synthetic] [--seed 7]

Writes <out>/images/<case_id>/<view>.jpg and <out>/manifest.csv.
The barcode on each label is CODE128 of the SKU printed on it: zxing-cpp's writer is used when
`import zxingcpp` works, otherwise a pure-Python CODE128-B encoder below.
"""
from __future__ import annotations

import argparse
import csv
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

W, H = 1280, 960
JPEG_QUALITY = 80

# The PO every synthetic case is checked against. It matches the backend's demo scenarios
# (BLUE-BOTTLE-001, Blue, 2 cartons x 12 = 24, components cap+label) so demo-mode runs line up.
PO = {
    "po_id": "PO-SYN-1001",
    "sku": "BLUE-BOTTLE-001",
    "product_name": "Insulated Water Bottle 750ml",
    "variant": "Blue",
    "expected_quantity": 24,
    "expected_cartons": 2,
    "units_per_carton": 12,
    "expected_components": ["cap", "label"],
}
CHECKS = ["sku_check", "carton_check", "units_per_carton_check", "quantity_check",
          "variant_check", "damage_check", "component_check"]
COLOURS = {"Blue": (38, 92, 190), "Red": (196, 40, 40)}

# variant -> what the photos show, the per-check truth, and the closest backend demo scenario.
VARIANTS = {
    "clean": dict(sku=PO["sku"], colour="Blue", cartons=2, per_carton=12, damaged=False,
                  fails=[], scenario="correct_shipment"),
    "wrong_sku": dict(sku="BLUE-BOTTLE-007", colour="Blue", cartons=2, per_carton=12, damaged=False,
                      fails=["sku_check"], scenario="barcode_glare",
                      note="Demo mode has no wrong-SKU scenario; barcode_glare (SKU unreadable) is the closest."),
    "wrong_variant": dict(sku=PO["sku"], colour="Red", cartons=2, per_carton=12, damaged=False,
                          fails=["variant_check"], scenario="wrong_variant"),
    "short_cartons": dict(sku=PO["sku"], colour="Blue", cartons=1, per_carton=12, damaged=False,
                          fails=["carton_check", "quantity_check"], scenario="short_shipment",
                          note="Demo short_shipment shortens units/carton, not cartons; per-check truth reflects the photo."),
    "damaged": dict(sku=PO["sku"], colour="Blue", cartons=2, per_carton=12, damaged=True,
                    fails=["damage_check"], scenario="damaged_carton"),
    "blurred": dict(sku=PO["sku"], colour="Blue", cartons=2, per_carton=12, damaged=False,
                    fails=[], scenario="ambiguous", post="blur",
                    note="Shipment is correct; photos are heavily blurred. Abstaining (UNCERTAIN) is the desired output."),
    "dark": dict(sku=PO["sku"], colour="Blue", cartons=2, per_carton=12, damaged=False,
                 fails=[], scenario="ambiguous", post="dark",
                 note="Shipment is correct; photos are badly under-exposed. Abstaining (UNCERTAIN) is the desired output."),
}

# ---------------------------------------------------------------- CODE128-B (pure Python fallback)
_C128 = (
    "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 "
    "122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 "
    "322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 "
    "112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 "
    "331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 "
    "112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 "
    "124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 "
    "411311 113141 114131 311141 411131 211412 211214 211232"
).split()
_C128_STOP = "2331112"
assert len(_C128) == 106 and all(sum(map(int, p)) == 11 for p in _C128)


def code128b_modules(text: str) -> list[bool]:
    """Module list (True = bar) for CODE128 code set B, with 10-module quiet zones."""
    codes = [104]  # START B
    for ch in text:
        value = ord(ch) - 32
        if not 0 <= value <= 94:
            raise ValueError(f"CODE128-B cannot encode {ch!r}")
        codes.append(value)
    checksum = (codes[0] + sum(i * c for i, c in enumerate(codes[1:], start=1))) % 103
    widths = "".join(_C128[c] for c in codes + [checksum]) + _C128_STOP
    modules = [False] * 10
    for i, w in enumerate(widths):
        modules += [i % 2 == 0] * int(w)
    return modules + [False] * 10


BARCODE_BACKEND = "pure-python CODE128-B"


def barcode_image(text: str, module_px: int = 3, height: int = 110) -> Image.Image:
    """CODE128 of `text`. zxing-cpp writer when importable, else the pure-Python encoder."""
    global BARCODE_BACKEND
    try:
        import zxingcpp  # optional; the backend may install it

        if hasattr(zxingcpp, "create_barcode"):  # zxing-cpp >= 2.3
            img = Image.fromarray(zxingcpp.create_barcode(text, zxingcpp.BarcodeFormat.Code128).to_image(scale=module_px))
        else:  # older write_barcode API
            img = Image.fromarray(zxingcpp.write_barcode(zxingcpp.BarcodeFormat.Code128, text, width=0, height=height,
                                                         quiet_zone=10))
        BARCODE_BACKEND = "zxing-cpp writer"
        return img.convert("L").resize((img.width, height), Image.NEAREST)
    except Exception:
        pass
    modules = code128b_modules(text)
    img = Image.new("L", (len(modules) * module_px, height), 255)
    d = ImageDraw.Draw(img)
    for i, bar in enumerate(modules):
        if bar:
            d.rectangle([i * module_px, 0, (i + 1) * module_px - 1, height - 1], fill=0)
    return img


# ---------------------------------------------------------------- drawing helpers
def font(size: int, bold: bool = False):
    names = (["arialbd.ttf", "DejaVuSans-Bold.ttf", "Arial Bold.ttf"] if bold
             else ["arial.ttf", "DejaVuSans.ttf", "Arial.ttf"])
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def background(rng: random.Random, top=(120, 116, 110), bottom=(78, 74, 70)) -> Image.Image:
    """Concrete-floor style vertical gradient with faint speckle."""
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    for _ in range(600):
        x, y = rng.randrange(W), rng.randrange(H)
        c = rng.randint(60, 140)
        d.point((x, y), fill=(c, c, c))
    return img


def cardboard(rng: random.Random, shade: int = 0) -> tuple[int, int, int]:
    base = (176 + shade, 132 + shade, 84 + shade)
    j = rng.randint(-8, 8)
    return tuple(max(0, min(255, v + j)) for v in base)


def draw_box(d: ImageDraw.ImageDraw, x, y, w, h, rng, depth=40, tape=True, label=True):
    """Simple 3/4-view carton: front face, top face, side face, tape strip and a small label."""
    front = cardboard(rng)
    top = tuple(min(255, v + 22) for v in front)
    side = tuple(max(0, v - 30) for v in front)
    d.polygon([(x, y), (x + w, y), (x + w + depth, y - depth), (x + depth, y - depth)], fill=top, outline=(90, 64, 40))
    d.polygon([(x + w, y), (x + w + depth, y - depth), (x + w + depth, y + h - depth), (x + w, y + h)],
              fill=side, outline=(90, 64, 40))
    d.rectangle([x, y, x + w, y + h], fill=front, outline=(90, 64, 40), width=2)
    if tape:
        cx = x + w // 2
        d.polygon([(cx - 14, y), (cx + 14, y), (cx + 14 + depth, y - depth), (cx - 14 + depth, y - depth)],
                  fill=(206, 176, 120))
        d.rectangle([cx - 14, y, cx + 14, y + h // 4], fill=(206, 176, 120))
    if label:
        lw, lh = w // 3, h // 4
        d.rectangle([x + 18, y + h - lh - 18, x + 18 + lw, y + h - 18], fill=(244, 244, 238), outline=(150, 150, 150))
        for i in range(3):
            d.line([(x + 26, y + h - lh - 6 + i * 14), (x + 10 + lw, y + h - lh - 6 + i * 14)], fill=(70, 70, 70), width=3)
    return front


def bottle(d: ImageDraw.ImageDraw, cx, base_y, height, colour, with_cap=True, with_label=True):
    bw = height // 3
    body_top = base_y - int(height * 0.78)
    d.rounded_rectangle([cx - bw // 2, body_top, cx + bw // 2, base_y], radius=bw // 4, fill=colour,
                        outline=tuple(max(0, v - 50) for v in colour), width=3)
    shoulder = body_top - height // 10
    d.polygon([(cx - bw // 2, body_top + 10), (cx - bw // 5, shoulder), (cx + bw // 5, shoulder),
               (cx + bw // 2, body_top + 10)], fill=colour)
    hi = tuple(min(255, v + 70) for v in colour)
    d.rounded_rectangle([cx - bw // 2 + 10, body_top + 20, cx - bw // 2 + 24, base_y - 20], radius=6, fill=hi)
    if with_cap:
        d.rounded_rectangle([cx - bw // 4, shoulder - height // 9, cx + bw // 4, shoulder + 4], radius=6,
                            fill=(35, 35, 38))
    if with_label:
        ly = body_top + int(height * 0.3)
        d.rectangle([cx - bw // 2 + 2, ly, cx + bw // 2 - 2, ly + height // 6], fill=(240, 240, 235))
        d.text((cx, ly + height // 12), "AQUA", fill=(40, 40, 40), font=font(max(14, height // 14), True), anchor="mm")


# ---------------------------------------------------------------- views
def view_label(spec, rng) -> Image.Image:
    img = Image.new("RGB", (W, H), cardboard(rng))
    d = ImageDraw.Draw(img)
    for _ in range(120):  # corrugation / fibre streaks
        y = rng.randrange(H)
        d.line([(0, y), (W, y + rng.randint(-4, 4))], fill=cardboard(rng, -12), width=1)
    d.rectangle([0, 380, W, 450], fill=(206, 176, 120))  # packing tape
    lx, ly, lw, lh = 190, 120, 900, 720
    d.rectangle([lx + 8, ly + 8, lx + lw + 8, ly + lh + 8], fill=(110, 82, 50))  # shadow
    d.rectangle([lx, ly, lx + lw, ly + lh], fill=(250, 250, 246), outline=(30, 30, 30), width=4)
    d.text((lx + 40, ly + 30), "SHIP TO: DC-04 RECEIVING", fill=(20, 20, 20), font=font(30, True))
    d.text((lx + 40, ly + 72), f"PO {PO['po_id']}", fill=(20, 20, 20), font=font(28))
    d.line([(lx, ly + 120), (lx + lw, ly + 120)], fill=(30, 30, 30), width=3)
    d.text((lx + 40, ly + 140), "SKU", fill=(60, 60, 60), font=font(26))
    d.text((lx + 40, ly + 172), spec["sku"], fill=(0, 0, 0), font=font(78, True))
    d.text((lx + 40, ly + 272), PO["product_name"], fill=(20, 20, 20), font=font(36))
    d.text((lx + 40, ly + 326), f"COLOUR: {spec['colour'].upper()}", fill=(20, 20, 20), font=font(40, True))
    d.text((lx + 500, ly + 326), f"QTY {spec['per_carton']} / CTN", fill=(20, 20, 20), font=font(40, True))
    bc = barcode_image(spec["sku"])
    scale = min((lw - 80) / bc.width, 1.0)
    bc = bc.resize((int(bc.width * scale), 170), Image.NEAREST)
    img.paste(bc.convert("RGB"), (lx + (lw - bc.width) // 2, ly + 420))
    d.text((lx + lw // 2, ly + 620), spec["sku"], fill=(0, 0, 0), font=font(30), anchor="mm")
    d.text((lx + lw - 40, ly + 680), "CTN 1 OF " + str(spec["cartons"]), fill=(20, 20, 20), font=font(26), anchor="rm")
    return img


def view_pallet(spec, rng) -> Image.Image:
    img = background(rng)
    d = ImageDraw.Draw(img)
    # wooden pallet
    px, py, pw = 240, 780, 800
    d.rectangle([px, py, px + pw, py + 26], fill=(150, 112, 70), outline=(90, 64, 40))
    for i in range(5):
        x = px + i * (pw - 60) // 4
        d.rectangle([x, py + 26, x + 60, py + 70], fill=(132, 98, 60), outline=(90, 64, 40))
    d.rectangle([px - 10, py + 70, px + pw + 10, py + 92], fill=(150, 112, 70), outline=(90, 64, 40))
    n = spec["cartons"]
    bw, bh = 300, 260
    gap = 40
    total = n * bw + (n - 1) * gap
    x0 = px + (pw - total) // 2
    for i in range(n):
        draw_box(d, x0 + i * (bw + gap), py - bh, bw, bh, rng)
    d.text((40, 40), f"{PO['po_id']}  dock 3", fill=(230, 230, 230), font=font(28))
    return img


def view_carton(spec, rng) -> Image.Image:
    img = background(rng)
    d = ImageDraw.Draw(img)
    x, y, w, h = 300, 300, 620, 520
    front = draw_box(d, x, y, w, h, rng, depth=90)
    d.text((x + w // 2, y + 120), "THIS SIDE UP", fill=(70, 50, 30), font=font(40, True), anchor="mm")
    d.text((x + w // 2, y + 180), f"{spec['per_carton']} x {PO['product_name']}", fill=(70, 50, 30),
           font=font(28), anchor="mm")
    if spec["damaged"]:
        # crushed corner, a tear and a dark water stain
        d.polygon([(x + w - 170, y), (x + w + 90, y - 90), (x + w + 90, y + 60), (x + w - 40, y + 150),
                   (x + w - 120, y + 60)], fill=tuple(max(0, v - 55) for v in front), outline=(60, 40, 25))
        for k in range(6):
            d.line([(x + w - 160 + k * 20, y + 10 + k * 12), (x + w - 60 + k * 8, y + 140 - k * 6)],
                   fill=(70, 48, 28), width=3)
        d.polygon([(x + 80, y + 300), (x + 150, y + 270), (x + 230, y + 330), (x + 190, y + 360),
                   (x + 120, y + 345)], fill=(232, 220, 196), outline=(60, 40, 25))
        stain = Image.new("L", (W, H), 0)
        sd = ImageDraw.Draw(stain)
        for _ in range(9):
            cx, cy, r = x + 380 + rng.randint(-60, 60), y + 360 + rng.randint(-50, 50), rng.randint(50, 110)
            sd.ellipse([cx - r, cy - r * 0.8, cx + r, cy + r * 0.8], fill=150)
        stain = stain.filter(ImageFilter.GaussianBlur(18))
        img.paste(Image.new("RGB", (W, H), (70, 48, 28)), (0, 0), stain)
    return img


def view_unit(spec, rng) -> Image.Image:
    img = background(rng, (200, 196, 188), (160, 156, 150))  # bench top
    d = ImageDraw.Draw(img)
    # opened carton flaps behind the unit
    d.polygon([(260, 700), (420, 380), (860, 380), (1020, 700)], fill=cardboard(rng), outline=(90, 64, 40))
    d.polygon([(260, 700), (1020, 700), (1000, 900), (280, 900)], fill=cardboard(rng, -18), outline=(90, 64, 40))
    bottle(d, 640, 860, 520, COLOURS[spec["colour"]])
    d.text((40, 40), "Opened unit", fill=(40, 40, 40), font=font(28))
    return img


def view_components(spec, rng) -> Image.Image:
    img = background(rng, (210, 208, 202), (175, 172, 166))
    d = ImageDraw.Draw(img)
    colour = COLOURS[spec["colour"]]
    bottle(d, 330, 820, 480, colour, with_cap=False, with_label=False)
    # cap
    d.rounded_rectangle([640, 520, 820, 640], radius=20, fill=(35, 35, 38))
    d.text((730, 680), "cap", fill=(20, 20, 20), font=font(36, True), anchor="mm")
    # sleeve label
    d.rectangle([900, 470, 1180, 620], fill=(240, 240, 235), outline=(120, 120, 120), width=2)
    d.text((1040, 545), "AQUA", fill=(40, 40, 40), font=font(46, True), anchor="mm")
    d.text((1040, 680), "label", fill=(20, 20, 20), font=font(36, True), anchor="mm")
    d.text((330, 880), "bottle", fill=(20, 20, 20), font=font(36, True), anchor="mm")
    return img


VIEWS = [("label", view_label), ("pallet", view_pallet), ("carton", view_carton),
         ("unit", view_unit), ("components", view_components)]
# Upload view for each drawn view (backend enum: pallet|carton|label|unit|other).
UPLOAD_VIEW = {"label": "label", "pallet": "pallet", "carton": "carton", "unit": "unit", "components": "other"}


def postprocess(img: Image.Image, kind: str | None, rng: random.Random) -> Image.Image:
    if kind == "blur":
        return img.filter(ImageFilter.GaussianBlur(9))
    if kind == "dark":
        img = ImageEnhance.Brightness(img).enhance(0.16)
        return ImageEnhance.Contrast(img).enhance(0.7)
    # mild camera look: slight rotation and softening
    return img.rotate(rng.uniform(-2.0, 2.0), resample=Image.BICUBIC, fillcolor=(60, 58, 55)).filter(
        ImageFilter.GaussianBlur(0.6))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="eval/synthetic")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    out = Path(args.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)

    rows = []
    for split in ("dev", "heldout"):
        for name, spec in VARIANTS.items():
            case_id = f"syn-{split}-{name}"
            case_dir = out / "images" / case_id
            case_dir.mkdir(parents=True, exist_ok=True)
            photos = []
            for view, draw in VIEWS:
                img = postprocess(draw(spec, rng), spec.get("post"), rng)
                rel = f"images/{case_id}/{view}.jpg"
                img.save(out / rel, "JPEG", quality=JPEG_QUALITY, optimize=True)
                photos.append(f"{UPLOAD_VIEW[view]}:{rel}")
            truth = {f"truth_{c}": ("FAIL" if c in spec["fails"] else "PASS") for c in CHECKS}
            rows.append({
                "case_id": case_id, "split": split, "po_id": PO["po_id"], "sku": PO["sku"],
                "product_name": PO["product_name"], "variant": PO["variant"],
                "expected_quantity": PO["expected_quantity"], "expected_cartons": PO["expected_cartons"],
                "units_per_carton": PO["units_per_carton"],
                "expected_components": ";".join(PO["expected_components"]),
                "photos": ";".join(photos),
                "expected_decision": "EXCEPTION" if spec["fails"] else "PASS",
                **truth,
                "scenario": spec["scenario"],
                "notes": "SYNTHETIC. " + spec.get("note", ""),
            })
    fields = list(rows[0].keys())
    with open(out / "manifest.csv", "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    size = sum(p.stat().st_size for p in (out / "images").rglob("*.jpg"))
    print(f"barcodes: {BARCODE_BACKEND}")
    print(f"wrote {len(rows)} cases, {len(rows) * len(VIEWS)} images, {size / 1e6:.2f} MB -> {out}")


if __name__ == "__main__":
    main()
