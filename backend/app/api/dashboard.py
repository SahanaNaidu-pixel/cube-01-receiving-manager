from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from backend.app.api.deps import require_principal
from backend.app.services import dashboard as dashboard_service

router = APIRouter(prefix="/api", tags=["dashboard"])


@router.get("/dashboard")
def dashboard(range_: str = Query("7d", alias="range"), date_from: str | None = None, date_to: str | None = None,
              principal: dict = Depends(require_principal)):
    return dashboard_service.build(principal, range_, date_from, date_to)
