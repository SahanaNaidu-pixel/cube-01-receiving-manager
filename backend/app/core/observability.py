"""Request-ID / correlation middleware and structured JSON logging."""

from __future__ import annotations

import json
import logging
import sys
import time
from datetime import datetime, timezone

from backend.app.core.context import (
    channel_var,
    clean_id,
    correlation_id_var,
    new_request_id,
    operator_id_var,
    request_id_var,
)

access_log = logging.getLogger("receiving.request")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "level": record.levelname,
            "logger": record.name,
            "request_id": request_id_var.get(),
            "correlation_id": correlation_id_var.get(),
        }
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            payload.update(fields)
        else:
            payload["message"] = record.getMessage()
        if record.exc_info and record.levelno >= logging.ERROR:
            payload["exception"] = record.exc_info[0].__name__ if record.exc_info[0] else None
        return json.dumps(payload, default=str)


_configured = False


def configure_logging() -> None:
    global _configured
    if _configured:
        return
    _configured = True
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    access_log.addHandler(handler)
    access_log.setLevel(logging.INFO)
    access_log.propagate = False
    app_log = logging.getLogger("backend")
    if not app_log.handlers:
        app_handler = logging.StreamHandler(sys.stderr)
        app_handler.setFormatter(JsonFormatter())
        app_handler.setLevel(logging.WARNING)
        app_log.addHandler(app_handler)


class RequestContextMiddleware:
    """Pure ASGI middleware: assigns ids, echoes them as headers, logs one JSON line per request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        request_id = clean_id(headers.get("x-request-id")) or new_request_id()
        correlation_id = clean_id(headers.get("x-correlation-id")) or request_id
        request_id_var.set(request_id)
        correlation_id_var.set(correlation_id)
        operator_id_var.set(None)
        channel_var.set("api")
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        state["correlation_id"] = correlation_id
        started = time.perf_counter()
        status_holder = {"status": 500}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                raw = [(k, v) for k, v in message.get("headers", []) if k.lower() not in (b"x-request-id", b"x-correlation-id")]
                raw.append((b"x-request-id", request_id.encode("latin-1")))
                raw.append((b"x-correlation-id", (correlation_id_var.get() or correlation_id).encode("latin-1")))
                message = {**message, "headers": raw}
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            access_log.info("request", extra={"fields": {
                "method": scope.get("method"),
                "path": scope.get("path"),
                "status": status_holder["status"],
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "operator_id": state.get("operator_id") or operator_id_var.get(),
            }})
