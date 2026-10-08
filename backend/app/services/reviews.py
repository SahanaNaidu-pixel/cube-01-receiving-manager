"""Human review queue. At most one open task (open | evidence_requested) per inspection."""

from __future__ import annotations

from uuid import uuid4

from backend.app.core.errors import AppError
from backend.app.database.repository import review_tasks_table
from backend.app.services.audit import record_event
from backend.app.services.evidence_record import now_rfc3339
from backend.app.services.issues import new_note

ACTIVE = ("open", "evidence_requested")
HUMAN_FROM_CONTRACT = {"PASS": "PASS", "EXCEPTION": "FAIL", "UNCERTAIN": "UNCERTAIN", "PENDING_REVIEW": "UNCERTAIN"}


def _save(organization_id: str, task: dict) -> dict:
    return review_tasks_table.upsert(organization_id, task["task_id"], task, created_at=task["created_at"],
                                     updated_at=task["updated_at"], inspection_id=task["inspection_id"],
                                     status=task["status"], kind=task["trigger"])


def list_for_org(organization_id: str) -> list[dict]:
    return review_tasks_table.find(organization_id)


def list_for_inspection(organization_id: str, inspection_id: str) -> list[dict]:
    return review_tasks_table.find(organization_id, inspection_id=inspection_id)


def active_task(organization_id: str, inspection_id: str) -> dict | None:
    active = [t for t in list_for_inspection(organization_id, inspection_id) if t["status"] in ACTIVE]
    return active[-1] if active else None


def get(organization_id: str, task_id: str) -> dict:
    task = review_tasks_table.get(organization_id, task_id)
    if task is None:
        raise AppError(404, "Review task not found")
    return task


def summary(task: dict | None) -> dict | None:
    if task is None:
        return None
    keys = ("task_id", "status", "trigger", "reason", "machine_verdict", "human_decision", "assigned_to",
            "decided_by", "decided_at", "created_at", "updated_at")
    return {k: task.get(k) for k in keys}


def _new_task(principal: dict, inspection, *, reason: str, trigger: str, machine_verdict: str | None,
              machine_record_id: str | None, assigned_to: str | None = None) -> dict:
    now = now_rfc3339()
    return {
        "task_id": f"REV-{uuid4().hex[:10].upper()}",
        "inspection_id": inspection.inspection_id,
        "status": "open",
        "reason": reason[:2000],
        "trigger": trigger,
        "machine_verdict": machine_verdict,
        "machine_record_id": machine_record_id,
        "human_decision": None,
        "decided_by": None,
        "decided_at": None,
        "resolution": None,
        "assigned_to": assigned_to,
        "notes": [],
        "created_by": principal["operator_id"],
        "created_at": now,
        "updated_at": now,
        "po_id": inspection.po.po_id,
        "sku": inspection.po.sku,
        "supplier": inspection.shipment.supplier if inspection.shipment else None,
    }


def sync_after_run(principal: dict, inspection, record: dict, verdict: str, failure_reason: str | None,
                   pending: bool) -> dict | None:
    """Open (or refresh) a task when a run ends UNCERTAIN / PENDING_REVIEW."""
    org = principal["organization_id"]
    task = active_task(org, inspection.inspection_id)
    if verdict in ("UNCERTAIN", "PENDING_REVIEW"):
        trigger = "perception_unavailable" if pending else "uncertain"
        uncertain = [f"{c['check_key']} ({c.get('reason_code')})" for c in record["checks"] if c["verdict"] in ("UNCERTAIN", "FAIL")]
        reason = failure_reason if pending and failure_reason else "Uncertain checks: " + (", ".join(uncertain) or "none")
        if task:
            previous = task["status"]
            task.update(machine_verdict=verdict, machine_record_id=record["record_id"], status="open",
                        updated_at=now_rfc3339())
            if task["trigger"] != "manual":
                task.update(reason=reason[:2000], trigger=trigger)
            _save(org, task)
            record_event(principal, "review.updated", "review_task", task["task_id"], inspection_id=inspection.inspection_id,
                         summary=f"Review {task['task_id']} refreshed by a new run ({previous} -> open)",
                         details={"machine_verdict": verdict, "record_id": record["record_id"]})
            return task
        task = _new_task(principal, inspection, reason=reason, trigger=trigger, machine_verdict=verdict,
                         machine_record_id=record["record_id"])
        _save(org, task)
        record_event(principal, "review.created", "review_task", task["task_id"], inspection_id=inspection.inspection_id,
                     summary=f"Review opened: {trigger}", details={"machine_verdict": verdict, "trigger": trigger})
        return task
    if task:
        # A decisive machine result replaces an automatic task; a manual request stays open for its human.
        task.update(machine_verdict=verdict, machine_record_id=record["record_id"], updated_at=now_rfc3339())
        if task["trigger"] != "manual":
            task.update(status="cancelled", resolution="superseded_by_run")
            record_event(principal, "review.cancelled", "review_task", task["task_id"], inspection_id=inspection.inspection_id,
                         summary=f"Review {task['task_id']} cancelled: new run verdict {verdict}",
                         details={"machine_verdict": verdict})
        _save(org, task)
    return task


def create_manual(principal: dict, inspection, reason: str, assigned_to: str | None) -> dict:
    org = principal["organization_id"]
    if active_task(org, inspection.inspection_id):
        raise AppError(409, "This inspection already has an open review task.", "CONFLICT")
    record = inspection.record
    task = _new_task(principal, inspection, reason=reason, trigger="manual",
                     machine_verdict=record["outcome"]["verdict"] if record else None,
                     machine_record_id=record["record_id"] if record else None, assigned_to=assigned_to)
    _save(org, task)
    record_event(principal, "review.created", "review_task", task["task_id"], inspection_id=inspection.inspection_id,
                 summary="Review requested manually", details={"reason": reason[:500], "assigned_to": assigned_to})
    return task


def complete(principal: dict, task: dict, *, human_decision: str, resolution: str, override_id: str | None,
             note: str | None = None) -> dict:
    now = now_rfc3339()
    task.update(status="completed", human_decision=human_decision, decided_by=principal["operator_id"], decided_at=now,
                resolution=resolution, override_id=override_id, updated_at=now)
    if note:
        task["notes"].append(new_note(principal, note))
    _save(principal["organization_id"], task)
    return task


def resolve_on_override(principal: dict, inspection_id: str, contract_verdict: str, override_id: str) -> dict | None:
    task = active_task(principal["organization_id"], inspection_id)
    if task is None:
        return None
    complete(principal, task, human_decision=HUMAN_FROM_CONTRACT[contract_verdict], resolution="overridden",
             override_id=override_id)
    record_event(principal, "review.decided", "review_task", task["task_id"], inspection_id=inspection_id,
                 summary=f"Review {task['task_id']} resolved by override ({contract_verdict})",
                 details={"resolution": "overridden", "override_id": override_id})
    return task


def require_active(task: dict) -> None:
    if task["status"] not in ACTIVE:
        raise AppError(409, f"Review task is {task['status']}.", "CONFLICT", {"status": task["status"]})


def request_evidence(principal: dict, task_id: str, note: str) -> dict:
    org = principal["organization_id"]
    task = get(org, task_id)
    require_active(task)
    task["status"] = "evidence_requested"
    task["notes"].append(new_note(principal, note))
    task["updated_at"] = now_rfc3339()
    _save(org, task)
    record_event(principal, "review.evidence_requested", "review_task", task_id, inspection_id=task["inspection_id"],
                 summary=f"More evidence requested on {task_id}", details={"note": note[:500]})
    return task


def add_note(principal: dict, task_id: str, text: str) -> dict:
    org = principal["organization_id"]
    task = get(org, task_id)
    note = new_note(principal, text)
    task["notes"].append(note)
    task["updated_at"] = note["created_at"]
    _save(org, task)
    record_event(principal, "note.added", "review_task", task_id, inspection_id=task["inspection_id"],
                 summary=f"Note on review {task_id}", details={"note_id": note["note_id"]})
    return note


def assign(principal: dict, task_id: str, assigned_to: str) -> dict:
    org = principal["organization_id"]
    task = get(org, task_id)
    if task["status"] in ("completed", "cancelled"):
        raise AppError(409, f"Review task is {task['status']}.", "CONFLICT", {"status": task["status"]})
    task["assigned_to"] = assigned_to
    task["updated_at"] = now_rfc3339()
    _save(org, task)
    record_event(principal, "review.assigned", "review_task", task_id, inspection_id=task["inspection_id"],
                 summary=f"Review {task_id} assigned to {assigned_to}", details={"assigned_to": assigned_to})
    return task
