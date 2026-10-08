from __future__ import annotations

from fastapi import APIRouter, Depends

from backend.app.api.deps import DateRange, Pagination, eq_ci, require_principal
from backend.app.services.audit import list_events

router = APIRouter(prefix="/api", tags=["audit"])


@router.get("/audit")
def audit(entity_type: str | None = None, entity_id: str | None = None, inspection_id: str | None = None,
          action: str | None = None, actor: str | None = None, dates: DateRange = Depends(),
          pagination: Pagination = Depends(), principal: dict = Depends(require_principal)):
    items = [e for e in list_events(principal["organization_id"])
             if eq_ci(entity_type, e["entity_type"]) and eq_ci(entity_id, e["entity_id"])
             and eq_ci(inspection_id, e["inspection_id"]) and eq_ci(action, e["action"]) and eq_ci(actor, e["actor"])
             and dates.contains(e["created_at"])]
    items.reverse()  # newest first
    return pagination.apply(items)
