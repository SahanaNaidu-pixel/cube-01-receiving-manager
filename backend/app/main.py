from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.app.core.config import get_settings
from .api.inspections import router as inspections_router, upload_body_limit

app = FastAPI(title="Receiving Manager", version="0.1.0")
settings = get_settings()


# Registered before CORS so CORS stays outermost and the 413 still carries CORS headers.
@app.middleware("http")
async def reject_oversized_uploads(request: Request, call_next):
    """Refuse image uploads whose declared size could never pass validation, before the body is parsed."""
    if request.method == "POST" and request.url.path.startswith("/api/inspections/") and request.url.path.endswith("/images"):
        try:
            declared = int(request.headers.get("content-length") or 0)
        except ValueError:
            declared = 0
        if declared > upload_body_limit(get_settings()):
            return JSONResponse({"detail": "Upload request is too large."}, status_code=413)
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_allowed_origins.split(",") if origin.strip()],
    allow_credentials=False,  # auth is the X-API-Key header, not cookies
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["X-API-Key", "Content-Type"],
)


@app.get("/api/health")
def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "service": "receiving-manager", "demo_mode": get_settings().demo_mode})


app.include_router(inspections_router)


if __name__ == "__main__":
    import uvicorn

    # Local run: `python -m backend.app.main`. Host/port come from FASTAPI_HOST / FASTAPI_PORT.
    uvicorn.run("backend.app.main:app", host=settings.fastapi_host, port=settings.fastapi_port)
