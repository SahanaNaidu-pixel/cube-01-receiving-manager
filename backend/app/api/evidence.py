from __future__ import annotations

from fastapi import APIRouter, Depends

from backend.app.api.deps import DateRange, Pagination, eq_ci, require_principal, text_match
from backend.app.core.errors import AppError
from backend.app.services import inspection_service as svc

router = APIRouter(prefix="/api/evidence", tags=["evidence"])


def _all_files(principal: dict) -> list[dict]:
    org = principal["organization_id"]
    ctx = svc.OrgContext(org)
    files = []
    for inspection in svc.repository.list(org):
        issues = ctx.issues.get(inspection.inspection_id, [])
        files += [svc.evidence_file(inspection, image, issues) for image in inspection.images]
    return files


@router.get("")
def list_evidence(
    inspection_id: str | None = None,
    view: str | None = None,
    analysis_status: str | None = None,
    q: str | None = None,
    dates: DateRange = Depends(),
    pagination: Pagination = Depends(),
    principal: dict = Depends(require_principal),
):
    items = [
        f for f in _all_files(principal)
        if eq_ci(inspection_id, f["inspection_id"]) and eq_ci(view, f["view"]) and eq_ci(analysis_status, f["analysis_status"])
        and text_match(q, f["evidence_id"], f["inspection_id"], f["filename"], f["po_id"], f["sku"], f["sha256_digest"])
        and dates.contains(f["uploaded_at"])
    ]
    items.sort(key=lambda f: f["uploaded_at"], reverse=True)
    return pagination.apply(items)


@router.get("/{image_id}")
def get_evidence(image_id: str, principal: dict = Depends(require_principal)):
    for item in _all_files(principal):
        if item["evidence_id"] == image_id:
            return item
    raise AppError(404, "Evidence not found")
