"""Photo quality report computed at upload time. Reports only; an upload is never rejected for quality.

Metrics run on a grayscale copy downscaled to METRIC_EDGE px on the long edge, so they do not depend on camera resolution.
Thresholds (tuned so an ordinary in-focus phone photo under warehouse light passes):
- too_small:   long edge < 640 px (labels become unreadable for OCR and barcodes)
- too_dark:    mean luminance < 50 / 255
- overexposed: mean luminance > 235 / 255 (the whole frame is washed out)
- glare:       > 12% of pixels clipped at >= 253 (specular hot spots; matte white paper sits around 200-235)
- blurry:      variance of the Laplacian < 100 (sharp text and edges score in the hundreds to thousands; a defocused
               frame scores in the tens. A flat, featureless surface also scores low; the report says so, nothing more)
"""

from __future__ import annotations

import io

try:
    from PIL import Image, ImageFilter, ImageOps, ImageStat
except ImportError:  # pragma: no cover - Pillow is in requirements.txt
    Image = None

MIN_LONG_EDGE = 640
MIN_BRIGHTNESS = 50.0
MAX_BRIGHTNESS = 235.0
GLARE_LEVEL = 253
MAX_GLARE_RATIO = 0.12
MIN_BLUR_SCORE = 100.0
METRIC_EDGE = 512
ISSUE_TEXT = {"too_small": "too small", "too_dark": "too dark", "overexposed": "overexposed", "glare": "glare",
              "blurry": "blurry", "unreadable": "could not be decoded"}
_LAPLACIAN = (0, 1, 0, 1, -4, 1, 0, 1, 0)


def available() -> bool:
    return Image is not None


def open_upright(content: bytes):
    """Decoded image with EXIF orientation applied."""
    return ImageOps.exif_transpose(Image.open(io.BytesIO(content)))


def assess(content: bytes) -> dict:
    if Image is None:
        return {"ok": True, "issues": [], "available": False}
    try:
        img = Image.open(io.BytesIO(content))
        width, height = img.size
        if img.getexif().get(0x0112) in (5, 6, 7, 8):  # rotated 90/270 degrees
            width, height = height, width
        img.draft("L", (METRIC_EDGE * 2, METRIC_EDGE * 2))  # fast JPEG decode at reduced size
        gray = img.convert("L")
        gray.thumbnail((METRIC_EDGE, METRIC_EDGE))
    except Exception:  # truncated, corrupt or decompression bomb
        return {"ok": False, "issues": ["unreadable"], "width": None, "height": None,
                "brightness": None, "blur_score": None, "glare_ratio": None}
    brightness = ImageStat.Stat(gray).mean[0]
    histogram = gray.histogram()
    glare = sum(histogram[GLARE_LEVEL:]) / max(1, gray.width * gray.height)
    edges = gray.filter(ImageFilter.Kernel((3, 3), _LAPLACIAN, scale=1, offset=128))
    blur = ImageStat.Stat(edges).var[0]
    issues = []
    if max(width, height) < MIN_LONG_EDGE:
        issues.append("too_small")
    if brightness < MIN_BRIGHTNESS:
        issues.append("too_dark")
    elif brightness > MAX_BRIGHTNESS:
        issues.append("overexposed")
    if glare > MAX_GLARE_RATIO and "overexposed" not in issues:
        issues.append("glare")
    if blur < MIN_BLUR_SCORE and "too_dark" not in issues:  # a dark frame has no edges to measure
        issues.append("blurry")
    return {"ok": not issues, "issues": issues, "width": width, "height": height, "brightness": round(brightness, 1),
            "blur_score": round(blur, 1), "glare_ratio": round(glare, 3)}


def assess_path(path: str) -> dict:
    try:
        with open(path, "rb") as handle:
            return assess(handle.read())
    except OSError:
        return {"ok": False, "issues": ["unreadable"]}


def describe(issues: list[str]) -> str:
    return ", ".join(ISSUE_TEXT.get(i, i) for i in issues)


def summary(reports: list[dict]) -> str:
    """'3 photos ok, 1 blurry, 1 too dark'."""
    ok = sum(1 for r in reports if r.get("ok"))
    counts: dict[str, int] = {}
    for r in reports:
        for issue in r.get("issues") or []:
            counts[issue] = counts.get(issue, 0) + 1
    parts = [f"{ok} photo{'s' if ok != 1 else ''} ok"] + [f"{n} {ISSUE_TEXT.get(i, i)}" for i, n in counts.items()]
    return ", ".join(parts)
