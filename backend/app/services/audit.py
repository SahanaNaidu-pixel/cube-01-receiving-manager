"""Append-only audit trail. Every mutation writes one event carrying the request and correlation ids."""

from __future__ import annotations

import logging
from uuid import uuid4

from backend.app.core.context import channel_var, current_correlation_id, current_request_id
from backend.app.database.repository import audit_table
from backend.app.services.evidence_record import now_rfc3339

log = logging.getLogger(__name__)


def record_event(principal: dict, action: str, entity_type: str, entity_id: str | None, *,
                 inspection_id: str | None = None, summary: str = "", details: dict | None = None) -> dict:
    event = {
        "event_id": f"AUD-{uuid4().hex[:12].upper()}",
        "organization_id": principal["organization_id"],
        "actor": principal.get("operator_id"),
        "role": principal.get("role"),
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "inspection_id": inspection_id,
        "summary": summary[:500],
        "details": details or {},
        "channel": channel_var.get(),
        "request_id": current_request_id(),
        "correlation_id": current_correlation_id(),
        "created_at": now_rfc3339(),
    }
    audit_table.insert(principal["organization_id"], event["event_id"], event, created_at=event["created_at"],
                       inspection_id=inspection_id, kind=action, ref=entity_id, status=entity_type)
    return event


def list_events(organization_id: str, *, inspection_id: str | None = None) -> list[dict]:
    return audit_table.find(organization_id, inspection_id=inspection_id)
