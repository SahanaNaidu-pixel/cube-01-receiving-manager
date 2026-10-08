from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, ConfigDict, StringConstraints

from backend.app.api.deps import DateRange, Pagination, require_principal, text_match
from backend.app.core.errors import AppError
from backend.app.services import inspection_service as svc
from backend.app.services import reviews as review_service
from backend.app.services.audit import record_event

router = APIRouter(prefix="/api/reviews", tags=["reviews"])
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class DecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["PASS", "FAIL", "UNCERTAIN"]
    note: Text


class NoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: Text | None = None
    text: Text | None = None

    def body(self) -> str:
        value = self.text or self.note
        if not value:
            raise AppError(422, "text: Field required", "VALIDATION_ERROR")
        return value


class AssignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assigned_to: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


@router.get("")
def list_reviews(
    status_: str | None = Query(None, alias="status"),
    q: str | None = None,
    dates: DateRange = Depends(),
    pagination: Pagination = Depends(),
    principal: dict = Depends(require_principal),
):
    statuses = {s.strip().lower() for s in status_.split(",") if s.strip()} if status_ else None
    items = [
        t for t in review_service.list_for_org(principal["organization_id"])
        if (statuses is None or t["status"] in statuses)
        and text_match(q, t["task_id"], t["inspection_id"], t["reason"], t.get("po_id"), t.get("sku"), t.get("supplier"),
                       t.get("assigned_to"))
        and dates.contains(t["created_at"])
    ]
    items.sort(key=lambda t: t["created_at"], reverse=True)
    return pagination.apply(items)


@router.get("/{task_id}")
def get_review(task_id: str, principal: dict = Depends(require_principal)):
    task = review_service.get(principal["organization_id"], task_id)
    inspection = svc.repository.get(principal["organization_id"], task["inspection_id"])
    return {**task, "inspection": svc.inspection_detail(principal, inspection) if inspection else None}


@router.post("/{task_id}/decision")
def decide(task_id: str, payload: DecisionRequest, principal: dict = Depends(require_principal)):
    task = review_service.get(principal["organization_id"], task_id)
    review_service.require_active(task)
    if payload.decision == "PASS" and principal["role"] != "approver":
        raise AppError(403, "Only an approver may finalise PASS.")
    contract = {"PASS": "PASS", "FAIL": "EXCEPTION", "UNCERTAIN": "UNCERTAIN"}[payload.decision]
    result = svc.override(principal, task["inspection_id"], contract, f"Review {task_id}: {payload.note}",
                          resolve_review=False)
    task = review_service.get(principal["organization_id"], task_id)
    task = review_service.complete(principal, task, human_decision=payload.decision, resolution="decided",
                                   override_id=result["override"]["override_id"], note=payload.note)
    record_event(principal, "review.decided", "review_task", task_id, inspection_id=task["inspection_id"],
                 summary=f"Review {task_id} decided {payload.decision} (machine: {task.get('machine_verdict')})",
                 details={"decision": payload.decision, "machine_verdict": task.get("machine_verdict"),
                          "override_id": result["override"]["override_id"], "record_id": result["record"]["record_id"]})
    return {**task, "override": result["override"], "record": result["record"], "verdict": result["verdict"]}


@router.post("/{task_id}/request-evidence")
def request_evidence(task_id: str, payload: NoteRequest, principal: dict = Depends(require_principal)):
    return review_service.request_evidence(principal, task_id, payload.body())


@router.post("/{task_id}/notes", status_code=status.HTTP_201_CREATED)
def review_note(task_id: str, payload: NoteRequest, principal: dict = Depends(require_principal)):
    return review_service.add_note(principal, task_id, payload.body())


@router.post("/{task_id}/assign")
def assign(task_id: str, payload: AssignRequest, principal: dict = Depends(require_principal)):
    return review_service.assign(principal, task_id, payload.assigned_to)
