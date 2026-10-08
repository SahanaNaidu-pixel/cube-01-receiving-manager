from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, ConfigDict, StringConstraints

from backend.app.api.deps import DateRange, Pagination, eq_ci, in_ci, require_principal, text_match
from backend.app.services import inspection_service as svc
from backend.app.services import issues as issue_service

router = APIRouter(prefix="/api/issues", tags=["issues"])
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
Short = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]


class IssueActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["start_review", "resolve", "reopen", "assign"]
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None = None
    assigned_to: Short | None = None


class NoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Text


class LinkEvidenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


@router.get("")
def list_issues(
    status_: str | None = Query(None, alias="status"),
    severity: str | None = None,
    issue_type: str | None = None,
    inspection_id: str | None = None,
    sku: str | None = None,
    po: str | None = None,
    q: str | None = None,
    dates: DateRange = Depends(),
    pagination: Pagination = Depends(),
    principal: dict = Depends(require_principal),
):
    items = [
        i for i in issue_service.list_for_org(principal["organization_id"])
        if in_ci(status_, i["status"]) and in_ci(severity, i["severity"]) and in_ci(issue_type, i["issue_type"])
        and eq_ci(inspection_id, i["inspection_id"]) and eq_ci(sku, i["sku"]) and eq_ci(po, i["po_id"])
        and text_match(q, i["issue_id"], i["inspection_id"], i["title"], i["reason"], i["sku"], i["po_id"],
                       i.get("supplier"), i["issue_type"])
        and dates.contains(i["created_at"])
    ]
    items.sort(key=lambda i: i["created_at"], reverse=True)
    return pagination.apply(items)


@router.get("/{issue_id}")
def get_issue(issue_id: str, principal: dict = Depends(require_principal)):
    issue = issue_service.get(principal["organization_id"], issue_id)
    inspection = svc.repository.get(principal["organization_id"], issue["inspection_id"])
    ctx = svc.OrgContext(principal["organization_id"])
    files = []
    if inspection:
        issues = ctx.issues.get(inspection.inspection_id, [])
        files = [svc.evidence_file(inspection, img, issues) for img in inspection.images
                 if img.image_id in issue.get("evidence_image_ids", [])]
    return {**issue, "inspection": svc.inspection_summary(inspection, ctx) if inspection else None, "evidence_files": files}


@router.post("/{issue_id}/actions")
def issue_action(issue_id: str, payload: IssueActionRequest, principal: dict = Depends(require_principal)):
    return issue_service.apply_action(principal, issue_id, payload.action, payload.note or None, payload.assigned_to)


@router.post("/{issue_id}/notes", status_code=status.HTTP_201_CREATED)
def issue_note(issue_id: str, payload: NoteRequest, principal: dict = Depends(require_principal)):
    return issue_service.add_note(principal, issue_id, payload.text)


@router.post("/{issue_id}/evidence")
def issue_evidence(issue_id: str, payload: LinkEvidenceRequest, principal: dict = Depends(require_principal)):
    issue = issue_service.get(principal["organization_id"], issue_id)
    inspection = svc.repository.get(principal["organization_id"], issue["inspection_id"])
    return issue_service.link_evidence(principal, issue_id, payload.image_id, inspection)
