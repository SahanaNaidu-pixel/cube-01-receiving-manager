"""Issues (exceptions): one per FAIL/UNCERTAIN check per run; superseded when a later run replaces them."""

from __future__ import annotations

from uuid import uuid4

from backend.app.core.errors import AppError
from backend.app.database.repository import issues_table
from backend.app.services.audit import record_event
from backend.app.services.evidence_record import now_rfc3339

OPEN_STATUSES = ("open", "in_review")
CHECK_TITLES = {
    "identity": "Product identity (SKU)",
    "carton_count": "Carton count",
    "units_per_carton": "Units per carton",
    "total_quantity": "Total quantity",
    "variant": "Variant",
    "carton_damage": "Carton damage",
    "unit_damage": "Unit damage",
    "components": "Components",
    "carton_condition": "Carton condition (intake)",
}
# action -> (allowed from statuses, resulting status or None to keep)
TRANSITIONS = {
    "start_review": (("open",), "in_review"),
    "resolve": (("open", "in_review"), "resolved"),
    "reopen": (("resolved",), "open"),
    "assign": (("open", "in_review", "resolved"), None),
}


def new_note(principal: dict, text: str) -> dict:
    return {"note_id": f"NOTE-{uuid4().hex[:10].upper()}", "author": principal["operator_id"],
            "role": principal.get("role"), "text": text, "created_at": now_rfc3339()}


def _save(organization_id: str, issue: dict) -> dict:
    return issues_table.upsert(organization_id, issue["issue_id"], issue, created_at=issue["created_at"],
                               updated_at=issue["updated_at"], inspection_id=issue["inspection_id"],
                               status=issue["status"], kind=issue["issue_type"])


def list_for_org(organization_id: str) -> list[dict]:
    return issues_table.find(organization_id)


def list_for_inspection(organization_id: str, inspection_id: str) -> list[dict]:
    return issues_table.find(organization_id, inspection_id=inspection_id)


def get(organization_id: str, issue_id: str) -> dict:
    issue = issues_table.get(organization_id, issue_id)
    if issue is None:
        raise AppError(404, "Issue not found")
    return issue


def sync_after_run(principal: dict, inspection, record: dict) -> list[dict]:
    """Supersede the previous run's open issues, then open one issue per FAIL/UNCERTAIN check of this run."""
    org = principal["organization_id"]
    now = now_rfc3339()
    superseded = []
    for issue in list_for_inspection(org, inspection.inspection_id):
        if issue["status"] in OPEN_STATUSES:
            issue.update(status="superseded", updated_at=now, superseded_by_record=record["record_id"])
            _save(org, issue)
            superseded.append(issue["issue_id"])
    if superseded:
        record_event(principal, "issue.superseded", "inspection", inspection.inspection_id,
                     inspection_id=inspection.inspection_id, summary=f"{len(superseded)} issue(s) superseded by a new run",
                     details={"issue_ids": superseded, "record_id": record["record_id"]})
    created = []
    supplier = inspection.shipment.supplier if inspection.shipment else None
    for check in record["checks"]:
        if check["verdict"] not in ("FAIL", "UNCERTAIN"):
            continue
        key = check["check_key"]
        issue = {
            "issue_id": f"ISS-{uuid4().hex[:10].upper()}",
            "inspection_id": inspection.inspection_id,
            "check_key": key,
            "check_name": check.get("check_name"),
            "issue_type": check.get("reason_code") or "UNSPECIFIED",
            "severity": "high" if check["verdict"] == "FAIL" else "medium",
            "status": "open",
            "title": f"{CHECK_TITLES.get(key, key)}: {check['verdict']}",
            "reason": check.get("reason"),
            "expected": check.get("expected_state"),
            "observed": check.get("observed_state"),
            "evidence_image_ids": list(check.get("image_ids") or []),
            "po_id": inspection.po.po_id,
            "sku": inspection.po.sku,
            "supplier": supplier,
            "assigned_to": None,
            "notes": [],
            "record_id": record["record_id"],
            "created_at": now,
            "updated_at": now,
            "resolved_at": None,
            "resolved_by": None,
        }
        _save(org, issue)
        created.append(issue)
    if created:
        record_event(principal, "issue.created", "inspection", inspection.inspection_id,
                     inspection_id=inspection.inspection_id, summary=f"{len(created)} issue(s) opened by run",
                     details={"issue_ids": [i["issue_id"] for i in created], "record_id": record["record_id"]})
    return created


def apply_action(principal: dict, issue_id: str, action: str, note: str | None, assigned_to: str | None) -> dict:
    org = principal["organization_id"]
    issue = get(org, issue_id)
    if action not in TRANSITIONS:
        raise AppError(422, f"Unknown action {action!r}.", "VALIDATION_ERROR")
    allowed, target = TRANSITIONS[action]
    if issue["status"] not in allowed:
        raise AppError(409, f"Cannot {action} an issue that is {issue['status']}.", "CONFLICT",
                       {"status": issue["status"], "action": action, "allowed_from": list(allowed)})
    if action == "assign" and not (assigned_to or "").strip():
        raise AppError(422, "assigned_to is required for assign.", "VALIDATION_ERROR")
    now = now_rfc3339()
    previous = issue["status"]
    if target:
        issue["status"] = target
    if action == "resolve":
        issue["resolved_at"], issue["resolved_by"] = now, principal["operator_id"]
    elif action == "reopen":
        issue["resolved_at"] = issue["resolved_by"] = None
    if assigned_to is not None and assigned_to.strip():
        issue["assigned_to"] = assigned_to.strip()
    if note:
        issue["notes"].append(new_note(principal, note))
    issue["updated_at"] = now
    _save(org, issue)
    action_name = {"start_review": "issue.review_started", "resolve": "issue.resolved", "reopen": "issue.reopened",
                   "assign": "issue.assigned"}[action]
    record_event(principal, action_name, "issue", issue_id, inspection_id=issue["inspection_id"],
                 summary=f"Issue {issue_id} {previous} -> {issue['status']}",
                 details={"from": previous, "to": issue["status"], "assigned_to": issue.get("assigned_to"),
                          "note": note})
    return issue


def add_note(principal: dict, issue_id: str, text: str) -> dict:
    org = principal["organization_id"]
    issue = get(org, issue_id)
    note = new_note(principal, text)
    issue["notes"].append(note)
    issue["updated_at"] = note["created_at"]
    _save(org, issue)
    record_event(principal, "note.added", "issue", issue_id, inspection_id=issue["inspection_id"],
                 summary=f"Note on issue {issue_id}", details={"note_id": note["note_id"]})
    return note


def link_evidence(principal: dict, issue_id: str, image_id: str, inspection) -> dict:
    org = principal["organization_id"]
    issue = get(org, issue_id)
    if inspection is None or not any(img.image_id == image_id for img in inspection.images):
        raise AppError(404, "Image not found on this issue's inspection")
    if image_id not in issue["evidence_image_ids"]:
        issue["evidence_image_ids"].append(image_id)
        issue["updated_at"] = now_rfc3339()
        _save(org, issue)
        record_event(principal, "issue.evidence_linked", "issue", issue_id, inspection_id=issue["inspection_id"],
                     summary=f"Image {image_id} linked to issue {issue_id}", details={"image_id": image_id})
    return issue
