"""Health (public), readiness (public), system info (key)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from backend.app.api.deps import require_principal
from backend.app.core.config import get_settings
from backend.app.services.a2a import A2A_VERSION, RECORD_SCHEMA
from backend.app.services.health import liveness, parse_peers, readiness, storage_writable
from backend.app.services.vision_providers import select_provider

router = APIRouter(tags=["system"])


@router.get("/health")
@router.get("/api/health")
def health() -> JSONResponse:
    return JSONResponse(liveness())


@router.get("/ready")
@router.get("/api/ready")
def ready() -> JSONResponse:
    body = readiness()
    return JSONResponse(body, status_code=503 if body["status"] == "UNAVAILABLE" else 200)


@router.get("/api/system/info")
def system_info(principal: dict = Depends(require_principal)):
    settings = get_settings()
    provider = select_provider(settings)
    writable, _ = storage_writable()
    return {
        "agent": {"agent_id": settings.agent_id, "name": "CUBE Receiving Manager", "version": settings.app_version},
        "api_version": "1.0.0",
        "a2a_version": A2A_VERSION,
        "record_schema": RECORD_SCHEMA,
        "environment": {
            "demo_mode": settings.demo_mode,
            "vision_provider": provider.name,
            "vision_model": provider.model,
            "damage_policy": settings.damage_policy,
            "max_image_size_mb": settings.max_image_size_mb,
            "upload_max_images": settings.upload_max_images,
            "allowed_extensions": [e.strip() for e in settings.allowed_extensions.split(",") if e.strip()],
            "seal_key_configured": bool(settings.seal_key),
            "a2a_peers": sorted(parse_peers()),
        },
        "principal": {k: principal[k] for k in ("organization_id", "operator_id", "role")},
        "storage": {"root_configured": bool(settings.upload_root_dir), "writable": writable},
    }
