from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.app.core.config import get_settings
from backend.app.services.vision import perception_probe, perception_status
from .api.inspections import router as inspections_router

app = FastAPI(title="Receiving Manager", version="0.1.0")
settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_allowed_origins.split(",") if origin.strip()],
    allow_credentials=False,  # auth is the X-API-Key header, not cookies
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["X-API-Key", "Content-Type"],
)


@app.get("/api/health")
def health(probe: bool = False, force: bool = False) -> JSONResponse:
    # perception tells the UI up front whether real photos will be read (live) or held for review (not_configured).
    # probe=true also asks the provider whether the key can use the model (cached; force=true re-checks now).
    perception = perception_probe(force=force) if probe else perception_status()
    # Upload limits let the UI validate files with the same rules the server enforces (non-secret config).
    current = get_settings()
    limits = {
        "max_image_size_mb": current.max_image_size_mb,
        "upload_max_images": current.upload_max_images,
        "allowed_extensions": [ext.strip() for ext in current.allowed_extensions.split(",") if ext.strip()],
    }
    return JSONResponse({"status": "ok", "service": "receiving-manager", "perception": perception, "limits": limits},
                        headers={"Cache-Control": "no-store"})


app.include_router(inspections_router)


if __name__ == "__main__":
    import uvicorn

    # Local run: `python -m backend.app.main`. Host/port come from FASTAPI_HOST / FASTAPI_PORT.
    uvicorn.run("backend.app.main:app", host=settings.fastapi_host, port=settings.fastapi_port)
