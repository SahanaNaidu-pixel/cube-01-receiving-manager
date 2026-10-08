"""Per-request correlation context (request id, correlation id, authenticated operator)."""

from __future__ import annotations

import contextvars
import re
from uuid import uuid4

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
correlation_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("correlation_id", default=None)
operator_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("operator_id", default=None)
channel_var: contextvars.ContextVar[str] = contextvars.ContextVar("channel", default="api")

_SAFE_ID = re.compile(r"^[A-Za-z0-9._:\-]{1,128}$")


def new_request_id() -> str:
    return f"req-{uuid4().hex[:12]}"


def clean_id(value: str | None) -> str | None:
    """Client-supplied ids are echoed in headers and logs: accept only a short safe charset."""
    value = (value or "").strip()
    return value if _SAFE_ID.match(value) else None


def current_request_id() -> str | None:
    return request_id_var.get()


def current_correlation_id() -> str | None:
    return correlation_id_var.get()
