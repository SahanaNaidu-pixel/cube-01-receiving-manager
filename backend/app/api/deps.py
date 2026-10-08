"""Shared API dependencies: API-key auth with org scoping, pagination, date filters."""

from __future__ import annotations

import hmac
import json
import logging
import re
from datetime import date, datetime, timezone
from functools import lru_cache

from fastapi import Header, HTTPException, Query, Request, status

from backend.app.core.config import get_settings
from backend.app.core.context import operator_id_var
from backend.app.core.errors import AppError

log = logging.getLogger(__name__)
# agent = another CUBE agent calling over A2A; treated like an operator (cannot finalise PASS).
ROLES = {"operator", "approver", "agent"}
# The keys shipped in .env.example are public, so they only work for a local demo.
PLACEHOLDER_KEY_PREFIX = "change-me"
KEYS_MISCONFIGURED = "Server API keys are misconfigured."
MAX_PAGE_SIZE = 200


@lru_cache(maxsize=4)
def _parse_api_keys(raw: str) -> dict[str, dict]:
    """Validate RECEIVING_API_KEYS once per distinct value. Raises ValueError with a readable reason."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON ({exc.msg} at position {exc.pos})") from None
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object of api key -> principal")
    keys = {}
    for index, (key, principal) in enumerate(data.items(), start=1):
        if not isinstance(principal, dict):
            raise ValueError(f"entry {index} is not an object")
        missing = [f for f in ("organization_id", "operator_id") if not str(principal.get(f) or "").strip()]
        if not key or missing:
            raise ValueError(f"entry {index} is missing {', '.join(missing) or 'its key'}")
        role = principal.get("role")
        keys[key] = {"organization_id": str(principal["organization_id"]), "operator_id": str(principal["operator_id"]),
                     "role": role if role in ROLES else "operator"}
    return keys


def auth_status() -> tuple[str, str]:
    """Readiness view of the key configuration (never reveals keys or parse positions)."""
    settings = get_settings()
    raw = settings.receiving_api_keys
    if not raw:
        return "UNAVAILABLE", "RECEIVING_API_KEYS is not configured; every API call is refused."
    try:
        keys = _parse_api_keys(raw)
    except ValueError:
        return "UNAVAILABLE", KEYS_MISCONFIGURED
    if not settings.demo_mode and any(k.startswith(PLACEHOLDER_KEY_PREFIX) for k in keys):
        return "UNAVAILABLE", "Public example keys are configured outside DEMO_MODE."
    roles = sorted({p["role"] for p in keys.values()})
    return "HEALTHY", f"{len(keys)} key(s) configured; roles: {', '.join(roles)}."


def require_principal(x_api_key: str | None = Header(default=None), request: Request = None) -> dict:
    """API key -> {organization_id, operator_id, role}. Fails closed when no keys are configured."""
    raw = get_settings().receiving_api_keys
    if not raw:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Authentication is not configured (RECEIVING_API_KEYS).")
    # The reason goes to the server log only; unauthenticated callers just learn the keys are misconfigured.
    try:
        keys = _parse_api_keys(raw)
    except ValueError as exc:
        log.error("RECEIVING_API_KEYS is malformed: %s", exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=KEYS_MISCONFIGURED) from None
    if not get_settings().demo_mode and any(key.startswith(PLACEHOLDER_KEY_PREFIX) for key in keys):
        log.error("RECEIVING_API_KEYS still contains the public 'change-me' example keys; "
                  "they are only accepted with DEMO_MODE=true. Generate real keys.")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=KEYS_MISCONFIGURED)
    if not x_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing X-API-Key header.")
    for key, principal in keys.items():
        if hmac.compare_digest(key.encode(), x_api_key.encode()):
            if request is not None:
                request.state.operator_id = principal["operator_id"]
            operator_id_var.set(principal["operator_id"])
            return dict(principal)
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key.")


class Pagination:
    def __init__(self, page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=MAX_PAGE_SIZE)):
        self.page = page
        self.page_size = page_size

    def apply(self, items: list) -> dict:
        start = (self.page - 1) * self.page_size
        chunk = items[start:start + self.page_size]
        return {"items": chunk, "count": len(chunk), "total": len(items), "page": self.page, "page_size": self.page_size}


_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_day(value: str | None, field: str) -> str | None:
    if value in (None, ""):
        return None
    if not _DATE.match(value):
        raise AppError(422, f"{field}: must be YYYY-MM-DD", "VALIDATION_ERROR", {"field": field})
    try:
        date.fromisoformat(value)
    except ValueError:
        raise AppError(422, f"{field}: not a valid date", "VALIDATION_ERROR", {"field": field}) from None
    return value


class DateRange:
    def __init__(self, date_from: str | None = Query(None), date_to: str | None = Query(None)):
        self.date_from = parse_day(date_from, "date_from")
        self.date_to = parse_day(date_to, "date_to")
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise AppError(422, "date_from must be on or before date_to", "VALIDATION_ERROR")

    def contains(self, timestamp) -> bool:
        day = day_of(timestamp)
        if day is None:
            return not (self.date_from or self.date_to)
        if self.date_from and day < self.date_from:
            return False
        if self.date_to and day > self.date_to:
            return False
        return True


def day_of(timestamp) -> str | None:
    """UTC calendar day (YYYY-MM-DD) of a datetime or RFC 3339 string."""
    if timestamp is None:
        return None
    if isinstance(timestamp, datetime):
        ts = timestamp if timestamp.tzinfo else timestamp.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc).date().isoformat()
    text = str(timestamp)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return day_of(parsed)
    except ValueError:
        return text[:10] or None


def text_match(q: str | None, *values) -> bool:
    if not q:
        return True
    needle = q.strip().lower()
    return any(needle in str(v).lower() for v in values if v is not None)


def eq_ci(filter_value: str | None, value) -> bool:
    if not filter_value:
        return True
    return value is not None and str(value).strip().lower() == filter_value.strip().lower()
