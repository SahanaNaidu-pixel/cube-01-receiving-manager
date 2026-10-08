"""Unified error envelope: {"detail": str, "error": {code, message, request_id, details}}."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.app.core.context import current_correlation_id, current_request_id

log = logging.getLogger(__name__)

STATUS_CODES = {
    400: "VALIDATION_ERROR",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    422: "VALIDATION_ERROR",
    503: "SERVICE_UNAVAILABLE",
    500: "INTERNAL_ERROR",
}


class AppError(HTTPException):
    """HTTPException with an explicit error code and structured details."""

    def __init__(self, status_code: int, message: str, code: str | None = None, details: dict | None = None):
        super().__init__(status_code=status_code, detail=message)
        self.code = code or STATUS_CODES.get(status_code, "ERROR")
        self.details = details or {}


def _ids(request: Request | None) -> tuple[str | None, str | None]:
    state = getattr(request, "state", None) if request is not None else None
    request_id = current_request_id() or getattr(state, "request_id", None)
    correlation_id = current_correlation_id() or getattr(state, "correlation_id", None) or request_id
    return request_id, correlation_id


def error_body(status_code: int, message: str, code: str | None = None, details: dict | None = None,
               request_id: str | None = None) -> dict:
    return {
        "detail": message,
        "error": {
            "code": code or STATUS_CODES.get(status_code, "ERROR"),
            "message": message,
            "request_id": request_id or current_request_id(),
            "details": details or {},
        },
    }


def error_response(request: Request | None, status_code: int, message: str, code: str | None = None,
                   details: dict | None = None, headers: dict | None = None) -> JSONResponse:
    request_id, correlation_id = _ids(request)
    out_headers = dict(headers or {})
    if request_id:
        out_headers.setdefault("X-Request-ID", request_id)
    if correlation_id:
        out_headers.setdefault("X-Correlation-ID", correlation_id)
    return JSONResponse(error_body(status_code, message, code, details, request_id), status_code=status_code,
                        headers=out_headers)


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    detail = exc.detail
    code = getattr(exc, "code", None)
    details = dict(getattr(exc, "details", None) or {})
    if isinstance(detail, dict):
        message = str(detail.get("message") or detail.get("detail") or "Request failed.")
        code = code or detail.get("code")
        details.update(detail.get("details") or {})
    elif isinstance(detail, list):
        message = "Request failed."
        details["errors"] = detail
    else:
        message = str(detail) if detail is not None else "Request failed."
    return error_response(request, exc.status_code, message, code, details, getattr(exc, "headers", None))


def _jsonable_error(err: dict) -> dict:
    out: dict[str, Any] = {"loc": [str(p) for p in err.get("loc", ())], "msg": str(err.get("msg", "")),
                           "type": str(err.get("type", ""))}
    if "input" in err:
        value = err["input"]
        if isinstance(value, (str, int, float, bool)) or value is None:
            out["input"] = value if not isinstance(value, str) else value[:200]
    return out


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [_jsonable_error(e) for e in exc.errors()]
    if errors:
        first = errors[0]
        loc = ".".join(p for p in first["loc"] if p not in ("body",)) or "request"
        message = f"{loc}: {first['msg']}"
    else:
        message = "Request validation failed."
    return error_response(request, 422, message, "VALIDATION_ERROR", {"errors": errors})


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    log.error("Unhandled error on %s %s: %s", request.method, request.url.path, type(exc).__name__, exc_info=exc)
    return error_response(request, 500, "Internal server error.", "INTERNAL_ERROR")
