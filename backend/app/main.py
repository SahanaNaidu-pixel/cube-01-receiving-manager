from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.app.core.config import get_settings
from backend.app.core.errors import (
    error_response,
    http_exception_handler,
    unhandled_exception_handler,
    validation_exception_handler,
)
from backend.app.core.observability import RequestContextMiddleware, configure_logging

from .api.agent import router as agent_router
from .api.audit import router as audit_router
from .api.catalogue import router as catalogue_router
from .api.dashboard import router as dashboard_router
from .api.evidence import router as evidence_router
from .api.inspections import router as inspections_router, upload_body_limit
from .api.issues import router as issues_router
from .api.reviews import router as reviews_router
from .api.system import router as system_router

configure_logging()
settings = get_settings()
app = FastAPI(title="Receiving Manager", version=settings.app_version)

app.add_exception_handler(StarletteHTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
# Logged and answered as 500 INTERNAL_ERROR without a stack trace (Starlette still re-raises for the server log).
app.add_exception_handler(Exception, unhandled_exception_handler)


# Registered before CORS so CORS stays outside it and the 413 still carries CORS headers.
@app.middleware("http")
async def reject_oversized_uploads(request: Request, call_next):
    """Refuse image uploads whose declared size could never pass validation, before the body is parsed."""
    if request.method == "POST" and request.url.path.startswith("/api/inspections/") and request.url.path.endswith("/images"):
        try:
            declared = int(request.headers.get("content-length") or 0)
        except ValueError:
            declared = 0
        if declared > upload_body_limit(get_settings()):
            return error_response(request, 413, "Upload request is too large.", "PAYLOAD_TOO_LARGE")
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_allowed_origins.split(",") if origin.strip()],
    allow_credentials=False,  # auth is the X-API-Key header, not cookies
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["X-API-Key", "Content-Type", "X-Request-ID", "X-Correlation-ID"],
    expose_headers=["X-Request-ID", "X-Correlation-ID", "Content-Disposition", "X-Idempotent-Replay"],
)
# Outermost: every response (including CORS preflights and 413s) carries X-Request-ID / X-Correlation-ID.
app.add_middleware(RequestContextMiddleware)

app.include_router(system_router)
app.include_router(agent_router)
app.include_router(inspections_router)
app.include_router(issues_router)
app.include_router(reviews_router)
app.include_router(evidence_router)
app.include_router(catalogue_router)
app.include_router(dashboard_router)
app.include_router(audit_router)


if __name__ == "__main__":
    import uvicorn

    # Local run: `python -m backend.app.main`. Host/port come from FASTAPI_HOST / FASTAPI_PORT.
    uvicorn.run("backend.app.main:app", host=settings.fastapi_host, port=settings.fastapi_port)
