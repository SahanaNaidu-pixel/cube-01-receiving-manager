"""Inspection workflow independent of transport, so REST and A2A share one path."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from backend.app.core.config import get_settings
from backend.app.core.context import current_request_id
from backend.app.core.errors import AppError
from backend.app.database.repository import InspectionRepository, notes_table
from backend.app.models.evidence import Evidence
from backend.app.models.inspection import Inspection, InspectionCheck, ReceivingImage, VisualObservation
from backend.app.services import issues as issue_service
from backend.app.services import reviews as review_service
from backend.app.services.audit import record_event
from backend.app.services.evidence_record import (
    EPHEMERAL_MESSAGE,
    build_override_record,
    build_record,
    compute_hash,
    now_rfc3339,
    verify_seal,
)
from backend.app.services.storage import LocalStorage
from backend.app.services.vision import VisionService, demo_scenario_names, normalize_scenario
from backend.app.services.vision_providers import UNAVAILABLE_MESSAGE, VisionUnavailable

log = logging.getLogger("backend.app.api.inspections")
repository = InspectionRepository()
storage = LocalStorage(root_dir=get_settings().upload_root_dir)
CONTRACT_VIEWS = {"pallet", "carton", "unit", "label", "other"}
LEGACY_VIEWS = {"carton_exterior": "carton", "shipping_label": "label", "opened_unit": "unit"}
VERDICT_OF = {"PASS": "PASS", "EXCEPTION": "FAIL", "UNCERTAIN": "UNCERTAIN", "PENDING_REVIEW": "UNCERTAIN"}

# Per-inspection mutation lock: upload/analyze/override each run load -> mutate -> update -> append_record
# under it, so concurrent requests cannot drop images or mix one run's decision with another's checks.
# ponytail: single-process only. Several workers or hosts need a DB-level guard (row version compare-and-swap).
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def inspection_lock(organization_id: str, inspection_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(f"{organization_id}/{inspection_id}", threading.Lock())


def public_failure_reason(exc: Exception) -> str:
    """Failure text returned to clients and sealed in the record: no URLs (e.g. the AI endpoint), bounded length."""
    message = re.sub(r"https?://\S+", "<url>", str(exc))[:300]
    return f"{type(exc).__name__}: {message}"


def contract_view(image_type: str | None) -> str:
    """Map capture views onto the contract enum pallet|carton|unit|label|other; legacy names are translated."""
    view = (image_type or "").strip().lower().replace(" ", "_").replace("-", "_")
    return view if view in CONTRACT_VIEWS else LEGACY_VIEWS.get(view, "other")


def verdict_of(inspection: Inspection) -> str | None:
    """UI/A2A verdict: PASS | FAIL | UNCERTAIN, or None when never analysed."""
    if inspection.record is None:
        return None
    return VERDICT_OF.get(inspection.record["outcome"]["verdict"], "UNCERTAIN")


def load(principal: dict, inspection_id: str) -> Inspection:
    inspection = repository.get(principal["organization_id"], inspection_id)
    if inspection is None:
        raise AppError(404, "Inspection not found")
    return inspection


def build_agent_summary(inspection: Inspection) -> str:
    if not inspection.checks:
        return "The receiving agent has not produced a final evidence-based verdict yet."

    failed_checks = [check for check in inspection.checks if check.status == "FAIL"]
    uncertain_checks = [check for check in inspection.checks if check.status == "UNCERTAIN"]

    if inspection.final_decision == "PASS":
        return "The receiving agent verified the shipment against the PO and found no material deviations."

    if inspection.final_decision == "PENDING_REVIEW":
        return "Perception was unavailable, so nothing was checked. The shipment is held for manual review."

    if inspection.final_decision == "EXCEPTION":
        if failed_checks:
            names = ", ".join(check.check_name.replace("_check", "").replace("_", " ") for check in failed_checks[:3])
            return f"The receiving agent flagged the shipment as EXCEPTION because the following checks failed: {names}."
        return "The receiving agent flagged the shipment as EXCEPTION due to clear material evidence against the PO."

    if uncertain_checks:
        names = ", ".join(check.check_name.replace("_check", "").replace("_", " ") for check in uncertain_checks[:3])
        return f"The receiving agent marked the shipment as UNCERTAIN because the evidence is inconclusive in: {names}."

    return "The receiving agent completed the inspection and recorded a conservative outcome based on the visible evidence."


# --- create / upload --------------------------------------------------------------------------


def create_inspection(principal: dict, po, shipment=None, cartons=None, *, channel: str = "api",
                      inspection_id: str | None = None) -> Inspection:
    inspection = Inspection(
        inspection_id=inspection_id or repository.generate_id(),
        organization_id=principal["organization_id"],
        po=po,
        shipment=shipment,
        cartons=list(cartons or []),
        status="draft",
        final_decision="UNCERTAIN",
        agent_summary="The receiving agent is waiting for intake and evidence capture.",
        created_by=principal["operator_id"],
        channel=channel,
    )
    repository.create(inspection)
    record_event(principal, "inspection.created", "inspection", inspection.inspection_id,
                 inspection_id=inspection.inspection_id,
                 summary=f"Inspection created for {po.po_id} / {po.sku}",
                 details={"po_id": po.po_id, "sku": po.sku, "channel": channel, "cartons": len(inspection.cartons),
                          "shipment_id": shipment.shipment_id if shipment else None})
    return inspection


def check_image_count(inspection: Inspection, incoming: int, settings) -> None:
    if len(inspection.images) + incoming > settings.upload_max_images:
        raise AppError(400, f"Maximum image count exceeded for this inspection ({settings.upload_max_images}).")


def store_images(principal: dict, inspection_id: str, validated_files: list[dict], views: list[str], *,
                 source: str = "upload") -> list[ReceivingImage]:
    """Save validated images all-or-nothing under the inspection lock."""
    settings = get_settings()
    with inspection_lock(principal["organization_id"], inspection_id):
        inspection = load(principal, inspection_id)
        check_image_count(inspection, len(validated_files), settings)
        saved_images: list[ReceivingImage] = []
        try:
            for validated, view in zip(validated_files, views):
                storage_path = storage.save(inspection_id, validated["stored_name"], validated["content"])
                saved_images.append(
                    ReceivingImage(
                        image_id=f"IMG-{uuid4().hex[:8].upper()}",
                        inspection_id=inspection_id,
                        filename=validated["original_name"],
                        stored_filename=validated["stored_name"],
                        image_path=storage_path,
                        image_type=view,
                        mime_type=validated["mime_type"],
                        file_size=len(validated["content"]),
                        sha256_digest=hashlib.sha256(validated["content"]).hexdigest(),
                        processing_state="uploaded",
                        uploaded_at=datetime.now(timezone.utc),
                        source=source,
                        uploaded_by=principal["operator_id"],
                        request_id=current_request_id(),
                    )
                )
            inspection.images.extend(saved_images)
            inspection.updated_at = datetime.now(timezone.utc)
            repository.update(inspection)
        except Exception:
            for image in saved_images:
                Path(image.image_path).unlink(missing_ok=True)
            raise
    record_event(principal, "evidence.uploaded", "inspection", inspection_id, inspection_id=inspection_id,
                 summary=f"{len(saved_images)} image(s) uploaded",
                 details={"images": [{"image_id": i.image_id, "view": i.image_type, "sha256_digest": i.sha256_digest,
                                      "file_size": i.file_size} for i in saved_images], "source": source})
    return saved_images


# --- run ----------------------------------------------------------------------------------------


def validate_scenario(scenario: str | None) -> None:
    settings = get_settings()
    if settings.demo_mode and scenario and normalize_scenario(scenario) not in demo_scenario_names():
        raise AppError(400, f"Unknown demo scenario. Known: {', '.join(demo_scenario_names())}.")


def run_inspection(principal: dict, inspection_id: str, scenario: str | None = None, manual=None,
                   manual_provided: bool = False) -> dict:
    validate_scenario(scenario)
    with inspection_lock(principal["organization_id"], inspection_id):
        return _run_locked(principal, inspection_id, scenario, manual, manual_provided)


def _run_locked(principal: dict, inspection_id: str, scenario, manual, manual_provided: bool) -> dict:
    settings = get_settings()
    inspection = load(principal, inspection_id)
    if manual_provided:  # an explicit (even empty) object replaces earlier readings; omitted keeps them
        inspection.manual_observations = manual if manual is not None and (manual.has_readings() or manual.note) else None
    manual = inspection.manual_observations
    has_manual = manual is not None and manual.has_readings()
    if not inspection.images and not has_manual:
        raise AppError(400, "No images uploaded for analysis")

    service = VisionService(inspection)
    failure_reason = None
    vision_status = "ok"
    result = None
    if inspection.images:
        try:
            result = service.analyze(scenario=scenario if settings.demo_mode else None, manual=manual if has_manual else None)
        except VisionUnavailable:
            failure_reason, vision_status = UNAVAILABLE_MESSAGE, "unavailable"
        except Exception as exc:  # fail-open: any perception failure holds the shipment for a human
            log.exception("Perception failed for %s", inspection_id)
            failure_reason, vision_status = public_failure_reason(exc), "failed"
    else:
        vision_status = "skipped"
        failure_reason = "No images uploaded; perception not run."

    pending = False
    if result is None:
        if has_manual:
            result = service.analyze_operator_only(manual)
        else:
            result = service.pending_result()
            pending = True
    vision_failure = failure_reason
    if not pending:
        failure_reason = None  # operator readings decided the run; the vision outcome is kept as metadata

    inspection.checks = [InspectionCheck.model_validate(item) for item in result["checks"]]
    inspection.evidence = [Evidence.model_validate(item) for item in result["evidence"]]
    inspection.observations = [VisualObservation.model_validate(item) for item in result["observations"]]
    inspection.final_decision = result["decision"]
    inspection.override_decision = None
    inspection.override_reason = None
    inspection.agent_summary = build_agent_summary(inspection)
    if vision_status != "ok" and not pending:
        inspection.agent_summary += " Perception was unavailable; checks without an operator reading stay UNCERTAIN."
    inspection.status = "pending" if pending else "completed"
    inspection.updated_at = datetime.now(timezone.utc)
    for image in inspection.images:
        image.processing_state = "failed" if vision_status in ("failed", "unavailable") else "analyzed"
    repository.update(inspection)

    perception = {
        "vision_provider": service.provider_name,
        "vision_status": vision_status,
        "vision_failure_reason": vision_failure if vision_status != "ok" else None,
        "operator_observations": has_manual,
        "damage_policy": service.damage_policy,
    }
    # A new record version; earlier versions and every override stay in the chain.
    record = repository.append_record(
        principal["organization_id"], inspection_id,
        lambda previous, version: build_record(
            inspection=inspection, verdict=result["decision"], checks=result["checks"],
            model_version=result["model_version"], operator=principal, version=version, previous=previous,
            status="pending_review" if pending else "analyzed", failure_reason=failure_reason,
            evidence=result["evidence"],
            extensions={"perception": perception,
                        "intake": {"shipment": inspection.shipment.model_dump() if inspection.shipment else None,
                                   "cartons": len(inspection.cartons)}},
        ),
    )
    inspection.record = record
    created_issues = issue_service.sync_after_run(principal, inspection, record)
    task = review_service.sync_after_run(principal, inspection, record, result["decision"], failure_reason or vision_failure, pending)
    verdict = VERDICT_OF[result["decision"]]
    record_event(principal, "inspection.run", "inspection", inspection_id, inspection_id=inspection_id,
                 summary=f"Run {record['version']}: {result['decision']}",
                 details={"record_id": record["record_id"], "content_hash": record["content_hash"],
                          "decision": result["decision"], "vision_status": vision_status,
                          "operator_observations": has_manual, "scenario": scenario if settings.demo_mode else None})

    if pending:
        analysis_status = "pending_review"
    elif vision_status != "ok":
        analysis_status = "operator_only"
    else:
        analysis_status = "demo" if settings.demo_mode and service.provider_name == "demo" else "complete"
    return {
        "inspection_id": inspection_id,
        "decision": result["decision"],
        "verdict": verdict,
        "status": inspection.status,
        "checks": result["checks"],
        "evidence": result["evidence"],
        "observations": result["observations"],
        "demo_mode": settings.demo_mode,
        "analysis_status": analysis_status,
        "failure_reason": failure_reason,
        "vision_status": vision_status,
        "vision_failure_reason": perception["vision_failure_reason"],
        "manual_observations": manual.model_dump() if manual else None,
        "agent_summary": inspection.agent_summary,
        "issues": [{"issue_id": i["issue_id"], "check_key": i["check_key"], "severity": i["severity"],
                    "reason_code": i["issue_type"]} for i in created_issues],
        "review_task": review_service.summary(task) if task and task["status"] in review_service.ACTIVE else None,
        "record": record,
    }


# --- override -----------------------------------------------------------------------------------


def override(principal: dict, inspection_id: str, decision: str, reason: str, *, resolve_review: bool = True) -> dict:
    load(principal, inspection_id)
    decision = decision.strip().upper()
    if decision not in {"PASS", "EXCEPTION", "UNCERTAIN"}:
        raise AppError(400, "Override decision must be PASS, EXCEPTION, or UNCERTAIN.")
    if decision == "PASS" and principal["role"] != "approver":
        raise AppError(403, "Only an approver may override to PASS.")
    with inspection_lock(principal["organization_id"], inspection_id):
        inspection = load(principal, inspection_id)
        result = repository.append_override(
            principal["organization_id"], inspection_id,
            lambda previous: build_override_record(previous, verdict=decision, reason=reason, operator=principal),
        )
        if result is None:
            raise AppError(409, "Analyze the inspection before overriding it.")
        record, override_entry = result
        inspection.override_decision = decision
        inspection.override_reason = override_entry["reason"]
        inspection.final_decision = decision
        inspection.status = "completed"
        inspection.updated_at = datetime.now(timezone.utc)
        inspection.agent_summary = f"Operator override by {override_entry['operator_id']}: {decision}. Reason: {override_entry['reason']}"
        repository.update(inspection)
    record_event(principal, "inspection.overridden", "inspection", inspection_id, inspection_id=inspection_id,
                 summary=f"Override to {decision}",
                 details={"override_id": override_entry["override_id"], "from_verdict": override_entry["from_verdict"],
                          "to_verdict": decision, "reason": reason[:500], "record_id": record["record_id"]})
    task = review_service.resolve_on_override(principal, inspection_id, decision, override_entry["override_id"]) if resolve_review else None
    return {
        "inspection_id": inspection_id,
        "override_decision": decision,
        "override_reason": override_entry["reason"],
        "override": override_entry,
        "final_decision": decision,
        "verdict": VERDICT_OF[decision],
        "status": inspection.status,
        "agent_summary": inspection.agent_summary,
        "review_task": review_service.summary(task),
        "record": record,
    }


# --- verify -------------------------------------------------------------------------------------


def verify(principal: dict, inspection_id: str) -> dict:
    """Re-check every record version: hash, keyed seal, version chain, and override before/after hashes."""
    load(principal, inspection_id)
    rows = repository.records(principal["organization_id"], inspection_id)
    problems: list[str] = []
    previous = None
    for expected_version, row in enumerate(rows, start=1):
        record = row["record"]
        tag = f"v{row['version']}"
        problems += [f"{tag}: {p}" for p in verify_seal(record)]
        overrides = record.get("overrides") or []
        if overrides and len(overrides) > len((previous or {}).get("overrides") or []):
            added = overrides[-1]
            if "prev_content_hash" in added and added["prev_content_hash"] != (previous or {}).get("content_hash"):
                problems.append(f"{tag}: override prev_content_hash does not match the previous record")
            if "new_content_hash" in added:
                body = json.loads(json.dumps(record))
                body["overrides"][-1].pop("new_content_hash")
                if compute_hash(body) != added["new_content_hash"]:
                    problems.append(f"{tag}: override new_content_hash does not match this record")
        if row["stored_hash"] != record.get("content_hash"):
            problems.append(f"{tag}: stored hash column differs from record")
        if row["version"] != expected_version or record.get("version") != row["version"]:
            problems.append(f"{tag}: version chain broken")
        link = record.get("supersedes")
        if previous is None and link is not None:
            problems.append(f"{tag}: first record claims a predecessor")
        if previous is not None and (link or {}).get("content_hash") != previous.get("content_hash"):
            problems.append(f"{tag}: does not chain to the previous record")
        previous = record
    hashes = [r["record"].get("content_hash") for r in rows]
    for row in repository.override_rows(principal["organization_id"], inspection_id):
        if row["before_hash"] not in hashes or row["after_hash"] not in hashes:
            problems.append(f"override {row['override_id']}: hashes not found in record chain")
        elif hashes.index(row["after_hash"]) != hashes.index(row["before_hash"]) + 1:
            problems.append(f"override {row['override_id']}: before/after are not consecutive")
    return {
        "inspection_id": inspection_id,
        "records": len(rows),
        "ephemeral_key_records": sum(1 for p in problems if EPHEMERAL_MESSAGE in p),
        "latest_content_hash": hashes[-1] if hashes else None,
        "integrity_verified": bool(rows) and not problems,
        "problems": problems,
    }


# --- notes --------------------------------------------------------------------------------------


def add_note(principal: dict, inspection_id: str, text: str) -> dict:
    load(principal, inspection_id)
    note = issue_service.new_note(principal, text)
    note["inspection_id"] = inspection_id
    notes_table.insert(principal["organization_id"], note["note_id"], note, created_at=note["created_at"],
                       inspection_id=inspection_id, kind="inspection")
    record_event(principal, "note.added", "inspection", inspection_id, inspection_id=inspection_id,
                 summary="Note added to inspection", details={"note_id": note["note_id"]})
    return note


# --- views --------------------------------------------------------------------------------------


class OrgContext:
    """Org-wide issues / reviews / notes loaded once, grouped by inspection (avoids N+1 queries in lists)."""

    def __init__(self, organization_id: str):
        self.issues: dict[str, list[dict]] = {}
        self.reviews: dict[str, list[dict]] = {}
        self.notes: dict[str, list[dict]] = {}
        for issue in issue_service.list_for_org(organization_id):
            self.issues.setdefault(issue["inspection_id"], []).append(issue)
        for task in review_service.list_for_org(organization_id):
            self.reviews.setdefault(task["inspection_id"], []).append(task)
        for note in notes_table.find(organization_id, kind="inspection"):
            self.notes.setdefault(note["inspection_id"], []).append(note)


def inspection_view(inspection: Inspection, ctx: OrgContext) -> dict:
    view = inspection.model_dump(mode="json", exclude={"images": {"__all__": {"image_path"}}})
    issues = ctx.issues.get(inspection.inspection_id, [])
    tasks = ctx.reviews.get(inspection.inspection_id, [])
    view["verdict"] = verdict_of(inspection)
    view["notes"] = ctx.notes.get(inspection.inspection_id, [])
    view["open_issue_count"] = sum(1 for i in issues if i["status"] in issue_service.OPEN_STATUSES)
    view["review_task"] = review_service.summary(tasks[-1]) if tasks else None
    return view


def inspection_detail(principal: dict, inspection: Inspection) -> dict:
    ctx = OrgContext(principal["organization_id"])
    view = inspection_view(inspection, ctx)
    issues = ctx.issues.get(inspection.inspection_id, [])
    view["issues"] = issues
    view["review_tasks"] = ctx.reviews.get(inspection.inspection_id, [])
    view["evidence_files"] = [evidence_file(inspection, image, issues) for image in inspection.images]
    return view


def inspection_summary(inspection: Inspection, ctx: OrgContext | None = None) -> dict:
    issues = ctx.issues.get(inspection.inspection_id, []) if ctx else []
    return {
        "inspection_id": inspection.inspection_id,
        "po_id": inspection.po.po_id,
        "sku": inspection.po.sku,
        "product_name": inspection.po.product_name,
        "supplier": inspection.shipment.supplier if inspection.shipment else None,
        "shipment_id": inspection.shipment.shipment_id if inspection.shipment else None,
        "verdict": verdict_of(inspection),
        "final_decision": inspection.final_decision if inspection.record else None,
        "status": inspection.status,
        "image_count": len(inspection.images),
        "open_issue_count": sum(1 for i in issues if i["status"] in issue_service.OPEN_STATUSES),
        "channel": inspection.channel,
        "created_at": inspection.created_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "updated_at": inspection.updated_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
    }


def evidence_file(inspection: Inspection, image: ReceivingImage, issues: list[dict]) -> dict:
    record = inspection.record
    record_image_ids = {i["image_id"] for i in (record or {}).get("images", [])}
    if record is None or image.image_id not in record_image_ids:
        analysis_status = "not_analyzed"
    elif record.get("perception", {}).get("vision_status") in ("unavailable", "failed") or record.get("stage") == "pending_review":
        analysis_status = "perception_unavailable"
    else:
        analysis_status = "analyzed"
    linked_checks = sorted({c["check_key"] for c in (record or {}).get("checks", []) if image.image_id in (c.get("image_ids") or [])})
    return {
        "evidence_id": image.image_id,
        "image_id": image.image_id,
        "inspection_id": inspection.inspection_id,
        "filename": image.filename,
        "file_type": image.mime_type,
        "file_size": image.file_size,
        "view": image.image_type,
        "source": image.source,
        "uploaded_at": image.uploaded_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "uploaded_by": image.uploaded_by,
        "sha256_digest": image.sha256_digest,
        "analysis_status": analysis_status,
        "readings": [e.model_dump(mode="json") for e in inspection.evidence if e.image_id == image.image_id],
        "linked_issue_ids": [i["issue_id"] for i in issues if image.image_id in (i.get("evidence_image_ids") or [])],
        "linked_checks": linked_checks,
        "po_id": inspection.po.po_id,
        "sku": inspection.po.sku,
        "provenance": {"request_id": image.request_id, "channel": "a2a" if image.source == "a2a" else "api"},
    }


def utc_iso(value) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def now() -> str:
    return now_rfc3339()
