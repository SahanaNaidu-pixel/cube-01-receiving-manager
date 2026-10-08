"""A2A endpoints: agent card, inbound receive, activity log."""

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from backend.app.api.deps import DateRange, Pagination, eq_ci, require_principal
from backend.app.core.context import correlation_id_var
from backend.app.core.errors import AppError
from backend.app.services import a2a as a2a_service

router = APIRouter(tags=["agent"])
MAX_ENVELOPE_BYTES = 64 * 1024 * 1024  # base64 images inflate ~4/3; per-image limits still apply


@router.get("/.well-known/agent.json", include_in_schema=False)
def well_known_agent_card():
    return a2a_service.agent_card()


@router.get("/api/agent/capabilities")
def capabilities(principal: dict = Depends(require_principal)):
    return a2a_service.agent_card()


@router.post("/api/agent/receive")
async def receive(request: Request, principal: dict = Depends(require_principal)):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_ENVELOPE_BYTES:
        raise AppError(413, "A2A envelope is too large.")
    raw = await request.body()
    if len(raw) > MAX_ENVELOPE_BYTES:
        raise AppError(413, "A2A envelope is too large.")
    envelope, error = a2a_service.parse_envelope(raw)
    corr = envelope.get("correlation_id") if isinstance(envelope, dict) and error is None else None
    header_corr = request.headers.get("x-correlation-id")
    correlation_id = corr or (correlation_id_var.get() if header_corr else None) or f"corr-{uuid4().hex[:12]}"
    # Set here, in the request's own context, so the response header and audit rows carry the flow id.
    correlation_id_var.set(correlation_id)
    request.state.correlation_id = correlation_id
    response, replayed = await run_in_threadpool(a2a_service.process, principal, envelope, error, correlation_id)
    headers = {"X-Idempotent-Replay": "true"} if replayed else {}
    if replayed and response.get("correlation_id"):
        correlation_id_var.set(response["correlation_id"])
    return JSONResponse(response, headers=headers)


@router.get("/api/agent/activity")
def activity(direction: str | None = None, operation: str | None = None, status: str | None = None,
             agent: str | None = None, correlation_id: str | None = None, dates: DateRange = Depends(),
             pagination: Pagination = Depends(), principal: dict = Depends(require_principal)):
    items = [a for a in a2a_service.list_activity(principal["organization_id"])
             if eq_ci(direction, a["direction"]) and eq_ci(operation, a["operation"]) and eq_ci(status, a["status"])
             and eq_ci(agent, a["agent"]) and eq_ci(correlation_id, a["correlation_id"]) and dates.contains(a["created_at"])]
    items.reverse()  # newest first
    return pagination.apply(items)


@router.get("/api/agent/activity/{request_id}")
def activity_detail(request_id: str, principal: dict = Depends(require_principal)):
    found = a2a_service.get_activity(principal["organization_id"], request_id)
    if found is None:
        raise AppError(404, "Activity not found")
    return found
