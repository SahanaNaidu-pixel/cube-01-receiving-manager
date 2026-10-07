from __future__ import annotations

import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.app.core.config import get_settings
from backend.app.database.repository import InspectionRepository
from backend.app.models.evidence import Evidence
from backend.app.models.inspection import Inspection, InspectionCheck, ReceivingImage, VisualObservation
from backend.app.models.po import PurchaseOrder
from backend.app.services.storage import LocalStorage
from backend.app.services.evidence_record import build_override_record, build_record, verify_seal
from backend.app.services.vision import VisionService

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/inspections", tags=["inspections"])
repository = InspectionRepository()
storage = LocalStorage(root_dir=get_settings().upload_root_dir)


class InspectionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    po: PurchaseOrder
    images: list[ReceivingImage] = Field(default_factory=list)


class InspectionOverrideRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: str = Field(..., min_length=1)
    reason: str = Field(..., min_length=1, max_length=2000)


def require_principal(x_api_key: str | None = Header(default=None)) -> dict:
    """API key -> {organization_id, operator_id, role}. Fails closed when no keys are configured."""
    raw = get_settings().receiving_api_keys
    if not raw:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Authentication is not configured (RECEIVING_API_KEYS).")
    if not x_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing X-API-Key header.")
    for key, principal in json.loads(raw).items():
        if hmac.compare_digest(key.encode(), x_api_key.encode()):
            return {"organization_id": principal["organization_id"], "operator_id": principal["operator_id"],
                    "role": principal.get("role", "operator")}
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key.")


def _load(principal: dict, inspection_id: str) -> Inspection:
    inspection = repository.get(principal["organization_id"], inspection_id)
    if inspection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection not found")
    return inspection


def _build_agent_summary(inspection: Inspection) -> str:
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


def _detect_image_mime(content: bytes) -> str:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is not a valid supported image.")


def _validate_image_upload(file: UploadFile, inspection_id: str):
    settings = get_settings()
    allowed_types = {item.strip().lower() for item in settings.allowed_image_types.split(",") if item.strip()}
    allowed_exts = {item.strip().lower() for item in settings.allowed_extensions.split(",") if item.strip()}

    original_name = (file.filename or "upload").strip()
    if not original_name or original_name in {".", ".."}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file name is invalid.")

    suffix = Path(original_name).suffix.lower()
    if suffix not in allowed_exts:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported file extension: {suffix}.")

    max_bytes = settings.max_image_size_mb * 1024 * 1024
    content = file.file.read(max_bytes + 1)
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Image file is empty: {original_name}")

    if len(content) > max_bytes:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Image exceeds the configured size limit.")

    detected_type = _detect_image_mime(content)
    if detected_type not in allowed_types:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported image MIME type.")

    expected_by_suffix = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }
    if expected_by_suffix.get(suffix) != detected_type:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file content does not match the provided file extension.")

    if file.content_type and file.content_type.lower() not in allowed_types:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported file type: {file.content_type}")

    safe_stored_name = f"{uuid4().hex}_{inspection_id}{suffix}"
    return {
        "original_name": original_name,
        "stored_name": safe_stored_name,
        "mime_type": detected_type,
        "content": content,
    }




def _view(inspection: Inspection) -> dict:
    return inspection.model_dump(mode="json", exclude={"images": {"__all__": {"image_path"}}})


@router.get("")
def list_inspections(principal: dict = Depends(require_principal)):
    items = repository.list(principal["organization_id"])
    return {"items": [_view(inspection) for inspection in items], "count": len(items)}


@router.post("")
def create_inspection(payload: InspectionCreateRequest, principal: dict = Depends(require_principal)):
    if payload.images:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Images must be uploaded through /images.")
    inspection = Inspection(
        inspection_id=repository.generate_id(),
        organization_id=principal["organization_id"],
        po=payload.po,
        status="draft",
        final_decision="UNCERTAIN",
        agent_summary="The receiving agent is waiting for intake and evidence capture.",
    )
    repository.create(inspection)
    return _view(inspection)


@router.get("/{inspection_id}")
def get_inspection(inspection_id: str, principal: dict = Depends(require_principal)):
    return _view(_load(principal, inspection_id))


@router.post("/{inspection_id}/images")
def upload_images(
    inspection_id: str,
    files: list[UploadFile] = File(...),
    image_type: str = Form("receiving_photo"),
    principal: dict = Depends(require_principal),
):
    inspection = _load(principal, inspection_id)
    if not files:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No image files were provided")

    settings = get_settings()
    if len(inspection.images) + len(files) > settings.upload_max_images:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Maximum image count exceeded for this inspection ({settings.upload_max_images}).")

    view = (image_type or "receiving_photo").strip().lower().replace(" ", "_")[:40] or "receiving_photo"
    saved_images: list[ReceivingImage] = []
    for file in files:
        validated = _validate_image_upload(file, inspection_id)
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
            )
        )

    inspection.images.extend(saved_images)
    inspection.updated_at = datetime.now(timezone.utc)
    repository.update(inspection)
    return {
        "inspection_id": inspection_id,
        "images": [image.model_dump(mode="json", exclude={"image_path"}) for image in saved_images],
    }


@router.get("/{inspection_id}/images/{image_id}")
def get_inspection_image(inspection_id: str, image_id: str, principal: dict = Depends(require_principal)):
    inspection = _load(principal, inspection_id)
    image_record = next((img for img in inspection.images if img.image_id == image_id), None)
    if image_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")

    try:
        file_path = storage.resolve(inspection_id, image_record.stored_filename)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid image path") from exc

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image file not found")

    return FileResponse(file_path, media_type=image_record.mime_type, filename=image_record.filename)


PERCEPTION_CHECKS = ("sku_check", "carton_check", "units_per_carton_check", "quantity_check",
                     "variant_check", "damage_check", "component_check")


@router.post("/{inspection_id}/analyze")
def analyze_inspection(inspection_id: str, scenario: str | None = None, principal: dict = Depends(require_principal)):
    inspection = _load(principal, inspection_id)
    settings = get_settings()
    if not inspection.images and not settings.demo_mode:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No images uploaded for analysis")

    service = VisionService(inspection)
    failure_reason = None
    try:
        result = service.analyze(scenario=scenario if settings.demo_mode else None)
    except Exception as exc:  # fail-open: any perception failure holds the shipment for a human
        log.exception("Perception failed for %s", inspection_id)
        failure_reason = f"{type(exc).__name__}: {str(exc)[:300]}"
        result = {
            "decision": "PENDING_REVIEW",
            "model_version": service.model_version,
            "checks": [
                InspectionCheck(
                    check_name=name, status="UNCERTAIN", expected_value=None, observed_value=None,
                    reason="Perception unavailable; not checked.", reason_code="PERCEPTION_UNAVAILABLE", confidence=0.0,
                ).model_dump(mode="json")
                for name in PERCEPTION_CHECKS
            ],
            "evidence": [],
            "observations": [],
        }

    inspection.checks = [InspectionCheck.model_validate(item) for item in result["checks"]]
    inspection.evidence = [Evidence.model_validate(item) for item in result["evidence"]]
    inspection.observations = [VisualObservation.model_validate(item) for item in result["observations"]]
    inspection.final_decision = result["decision"]
    inspection.override_decision = None
    inspection.override_reason = None
    inspection.agent_summary = _build_agent_summary(inspection)
    inspection.status = "completed" if failure_reason is None else "pending"
    inspection.updated_at = datetime.now(timezone.utc)
    repository.update(inspection)

    # A new record version; earlier versions and every override stay in the chain.
    record = repository.append_record(
        principal["organization_id"], inspection_id,
        lambda previous, version: build_record(
            inspection=inspection, verdict=result["decision"], checks=result["checks"],
            model_version=result["model_version"], operator=principal, version=version, previous=previous,
            status="analyzed" if failure_reason is None else "pending_review", failure_reason=failure_reason,
        ),
    )

    return {
        "inspection_id": inspection_id,
        "decision": result["decision"],
        "checks": result["checks"],
        "evidence": result["evidence"],
        "observations": result["observations"],
        "demo_mode": settings.demo_mode,
        "analysis_status": "pending_review" if failure_reason else ("demo" if settings.demo_mode else "complete"),
        "failure_reason": failure_reason,
        "agent_summary": inspection.agent_summary,
        "record": record,
    }


@router.post("/{inspection_id}/override")
def override_inspection(inspection_id: str, payload: InspectionOverrideRequest, principal: dict = Depends(require_principal)):
    inspection = _load(principal, inspection_id)
    decision = payload.decision.strip().upper()
    if decision not in {"PASS", "EXCEPTION", "UNCERTAIN"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Override decision must be PASS, EXCEPTION, or UNCERTAIN.")
    if decision == "PASS" and principal["role"] != "approver":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only an approver may override to PASS.")

    result = repository.append_override(
        principal["organization_id"], inspection_id,
        lambda previous: build_override_record(previous, verdict=decision, reason=payload.reason.strip(), operator=principal),
    )
    if result is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Analyze the inspection before overriding it.")
    record, override = result

    inspection.override_decision = decision
    inspection.override_reason = override["reason"]
    inspection.final_decision = decision
    inspection.status = "completed"
    inspection.updated_at = datetime.now(timezone.utc)
    inspection.agent_summary = f"Operator override by {override['operator_id']}: {decision}. Reason: {override['reason']}"
    repository.update(inspection)

    return {
        "inspection_id": inspection_id,
        "override_decision": decision,
        "override_reason": override["reason"],
        "override": override,
        "final_decision": decision,
        "status": inspection.status,
        "agent_summary": inspection.agent_summary,
        "record": record,
    }


@router.get("/{inspection_id}/verify")
def verify_inspection(inspection_id: str, principal: dict = Depends(require_principal)):
    """Re-check every record version: hash, keyed seal, version chain, and override before/after hashes."""
    _load(principal, inspection_id)
    rows = repository.records(principal["organization_id"], inspection_id)
    problems: list[str] = []
    previous = None
    for expected_version, row in enumerate(rows, start=1):
        record = row["record"]
        tag = f"v{row['version']}"
        problems += [f"{tag}: {p}" for p in verify_seal(record)]
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
        "latest_content_hash": hashes[-1] if hashes else None,
        "integrity_verified": bool(rows) and not problems,
        "problems": problems,
    }
