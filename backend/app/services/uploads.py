"""Image upload validation shared by multipart uploads and A2A base64 images."""

from __future__ import annotations

import base64
import binascii
import re
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, status

from backend.app.core.config import get_settings

MAX_FILENAME_LENGTH = 100
EXPECTED_BY_SUFFIX = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def _detect_image_mime(content: bytes) -> str:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is not a valid supported image.")


def _safe_filename(raw: str | None, suffix: str = "") -> str:
    """Display-only basename: no path parts (/ or backslash), control chars or quotes, bounded length."""
    name = re.split(r"[\\/]", raw or "")[-1]
    name = re.sub(r"[\x00-\x1f\x7f\"';]", "", name).strip().strip(".")
    if len(name) > MAX_FILENAME_LENGTH:
        stem, ext = Path(name).stem, Path(name).suffix[:10]
        name = stem[: MAX_FILENAME_LENGTH - len(ext)] + ext
    return name or f"image{suffix}"


def allowed_sets(settings=None) -> tuple[set[str], set[str]]:
    settings = settings or get_settings()
    types = {item.strip().lower() for item in settings.allowed_image_types.split(",") if item.strip()}
    exts = {item.strip().lower() for item in settings.allowed_extensions.split(",") if item.strip()}
    return types, exts


def check_name(raw_name: str | None) -> tuple[str, str]:
    """Validate the client file name and extension. Returns (suffix, sanitised display name)."""
    _, allowed_exts = allowed_sets()
    raw_name = (raw_name or "upload").strip()
    if not raw_name or raw_name in {".", ".."}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file name is invalid.")
    suffix = Path(raw_name).suffix.lower()
    if not suffix:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"File has no extension; allowed: {', '.join(sorted(allowed_exts))}.")
    if suffix not in allowed_exts:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported file extension: {suffix}.")
    return suffix, _safe_filename(raw_name, suffix)


def validate_image_content(suffix: str, original_name: str, content: bytes, content_type: str | None,
                           inspection_id: str) -> dict:
    """Size, magic bytes, extension/content agreement, declared type. Returns the validated upload dict."""
    settings = get_settings()
    allowed_types, _ = allowed_sets(settings)
    max_bytes = settings.max_image_size_mb * 1024 * 1024
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Image file is empty: {original_name}")
    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail="Image exceeds the configured size limit.")
    detected_type = _detect_image_mime(content)
    if detected_type not in allowed_types:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported image MIME type.")
    if EXPECTED_BY_SUFFIX.get(suffix) != detected_type:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file content does not match the provided file extension.")
    # Magic bytes already validated; generic octet-stream (some mobile browsers) is accepted.
    if content_type and content_type.lower() not in allowed_types | {"application/octet-stream"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported file type: {content_type}")
    return {
        "original_name": original_name,
        "stored_name": f"{uuid4().hex}_{inspection_id}{suffix}",
        "mime_type": detected_type,
        "content": content,
    }


def validate_base64_image(filename: str | None, content_base64: str, inspection_id: str) -> dict:
    """A2A image: same checks as a multipart upload, after a strict, size-bounded base64 decode."""
    suffix, original_name = check_name(filename)
    data = (content_base64 or "").strip()
    if data.startswith("data:") and "," in data:
        data = data.split(",", 1)[1]
    data = re.sub(r"\s+", "", data)
    max_bytes = get_settings().max_image_size_mb * 1024 * 1024
    if len(data) * 3 // 4 > max_bytes + 3:  # refuse before decoding anything huge
        raise HTTPException(status_code=413, detail="Image exceeds the configured size limit.")
    try:
        content = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Image is not valid base64: {original_name}") from None
    return validate_image_content(suffix, original_name, content, None, inspection_id)
