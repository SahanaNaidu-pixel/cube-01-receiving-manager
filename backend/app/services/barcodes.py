"""Deterministic barcode / QR decoding (zxing-cpp). Missing library -> available() is False and nothing is decoded."""

from __future__ import annotations

import logging

from backend.app.services import image_quality

try:
    import zxingcpp
except ImportError:  # pragma: no cover - zxing-cpp is in requirements.txt
    zxingcpp = None

MAX_EDGE = 4096  # bigger phone photos are scaled down before decoding
log = logging.getLogger(__name__)


def available() -> bool:
    return zxingcpp is not None and image_quality.available()


def _read(img) -> list[dict]:
    found = []
    for result in zxingcpp.read_barcodes(img):
        text = (result.text or "").strip()
        if result.valid and text:
            found.append({"format": result.format.name.upper(), "text": text})
    return found


def decode(content: bytes) -> list[dict]:
    """[{format, text}] for every barcode in the EXIF-upright image; retries on a 2x grayscale upscale if none found."""
    if not available():
        return []
    try:
        img = image_quality.open_upright(content)
        img.thumbnail((MAX_EDGE, MAX_EDGE))
        gray = img.convert("L")
        found = _read(gray)
        if not found and max(gray.size) <= MAX_EDGE // 2:  # small or distant codes
            found = _read(gray.resize((gray.width * 2, gray.height * 2)))
    except Exception:  # unreadable image or decoder error: report nothing rather than fail the analysis
        log.warning("Barcode decoding failed", exc_info=True)
        return []
    unique = []
    for item in found:
        if item not in unique:
            unique.append(item)
    return unique


def decode_path(path: str) -> list[dict]:
    try:
        with open(path, "rb") as handle:
            return decode(handle.read())
    except OSError:
        return []
