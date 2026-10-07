from __future__ import annotations

import hashlib
import hmac
import json
import logging
import queue
import re
import threading
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.app.core.config import get_settings
from backend.app.database.repository import InspectionRepository
from backend.app.models.evidence import Evidence
from backend.app.models.inspection import Inspection, InspectionCheck, ReceivingImage, VisualObservation
from backend.app.models.po import PurchaseOrder
from backend.app.services import barcodes as barcode_reader, image_quality
from backend.app.services.storage import LocalStorage
from backend.app.services.evidence_record import EPHEMERAL_MESSAGE, build_override_record, build_record, compute_hash, verify_seal
from backend.app.services.recommendations import build_recommendations
from backend.app.services.vision import VisionService, demo_scenario_names, normalize_scenario, with_sku_match

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/inspections", tags=["inspections"])
repository = InspectionRepository()
storage = LocalStorage(root_dir=get_settings().upload_root_dir)
ROLES = {"operator", "approver"}
CONTRACT_VIEWS = {"pallet", "carton", "unit", "label", "other"}
LEGACY_VIEWS = {"carton_exterior": "carton", "shipping_label": "label", "opened_unit": "unit"}

# Per-inspection mutation lock: upload/analyze/override each run load -> mutate -> update -> append_record
# under it, so concurrent requests cannot drop images or mix one run's decision with another's checks.
# ponytail: single-process only. Several workers or hosts need a DB-level guard (row version compare-and-swap).
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _inspection_lock(organization_id: str, inspection_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(f"{organization_id}/{inspection_id}", threading.Lock())


class InspectionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    po: PurchaseOrder
    images: list[ReceivingImage] = Field(default_factory=list)


class InspectionOverrideRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)  # strip before min_length

    decision: str = Field(..., min_length=1)
    reason: str = Field(..., min_length=1, max_length=2000)


# The keys shipped in .env.example are public, so they only work for a local demo.
PLACEHOLDER_KEY_PREFIX = "change-me"


def _public_failure_reason(exc: Exception) -> str:
    """Failure text returned to clients and sealed in the record: no URLs (e.g. the AI endpoint), no keys, bounded length."""
    if getattr(exc, "public_reason", None):
        return exc.public_reason
    message = re.sub(r"https?://\S+", "<url>", str(exc))
    message = re.sub(r"\b(sk|key)-[A-Za-z0-9_*\-]{4,}", "<redacted>", message)[:300]
    return f"{type(exc).__name__}: {message}"


@lru_cache(maxsize=4)
def _parse_api_keys(raw: str) -> dict[str, dict]:
    """Validate RECEIVING_API_KEYS once per distinct value. Raises ValueError with a readable reason."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON ({exc.msg} at position {exc.pos})") from None
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object of api key -> principal")
    keys = {}
    for index, (key, principal) in enumerate(data.items(), start=1):
        if not isinstance(principal, dict):
            raise ValueError(f"entry {index} is not an object")
        missing = [f for f in ("organization_id", "operator_id") if not str(principal.get(f) or "").strip()]
        if not key or missing:
            raise ValueError(f"entry {index} is missing {', '.join(missing) or 'its key'}")
        role = principal.get("role")
        keys[key] = {"organization_id": str(principal["organization_id"]), "operator_id": str(principal["operator_id"]),
                     "role": role if role in ROLES else "operator"}
    return keys


def require_principal(x_api_key: str | None = Header(default=None)) -> dict:
    """API key -> {organization_id, operator_id, role}. Fails closed when no keys are configured."""
    raw = get_settings().receiving_api_keys
    if not raw:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Authentication is not configured (RECEIVING_API_KEYS).")
    try:
        keys = _parse_api_keys(raw)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"RECEIVING_API_KEYS is malformed: {exc}") from None
    if not get_settings().demo_mode and any(key.startswith(PLACEHOLDER_KEY_PREFIX) for key in keys):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="RECEIVING_API_KEYS still contains the public 'change-me' example keys; "
                                   "they are only accepted with DEMO_MODE=true. Generate real keys.")
    if not x_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing X-API-Key header.")
    for key, principal in keys.items():
        if hmac.compare_digest(key.encode(), x_api_key.encode()):
            return dict(principal)
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
    if not suffix:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"File has no extension; allowed: {', '.join(sorted(allowed_exts))}.")
    if suffix not in allowed_exts:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported file extension: {suffix}.")

    max_bytes = settings.max_image_size_mb * 1024 * 1024
    content = file.file.read(max_bytes + 1)
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Image file is empty: {original_name}")

    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail="Image exceeds the configured size limit.")

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

    # Magic bytes already validated; generic octet-stream (some mobile browsers) is accepted.
    if file.content_type and file.content_type.lower() not in allowed_types | {"application/octet-stream"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported file type: {file.content_type}")

    safe_stored_name = f"{uuid4().hex}_{inspection_id}{suffix}"
    return {
        "original_name": original_name,
        "stored_name": safe_stored_name,
        "mime_type": detected_type,
        "content": content,
    }

def _contract_view(image_type: str | None) -> str:
    """Map capture views onto the contract enum pallet|carton|unit|label|other; legacy names are translated."""
    view = (image_type or "").strip().lower().replace(" ", "_").replace("-", "_")
    return view if view in CONTRACT_VIEWS else LEGACY_VIEWS.get(view, "other")


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
    image_type: str = Form("other"),
    principal: dict = Depends(require_principal),
):
    _load(principal, inspection_id)
    if not files:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No image files were provided")
    validated_files = [_validate_image_upload(file, inspection_id) for file in files]  # all-or-nothing: validate first
    for validated in validated_files:  # reported, never a reason to reject
        validated["quality"] = image_quality.assess(validated["content"])
    view = _contract_view(image_type)
    settings = get_settings()
    with _inspection_lock(principal["organization_id"], inspection_id):
        inspection = _load(principal, inspection_id)
        if len(inspection.images) + len(validated_files) > settings.upload_max_images:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Maximum image count exceeded for this inspection ({settings.upload_max_images}).")
        saved_images: list[ReceivingImage] = []
        try:
            for validated in validated_files:
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
                        quality=validated["quality"],
                    )
                )
            inspection.images.extend(saved_images)
            inspection.updated_at = datetime.now(timezone.utc)
            repository.update(inspection)
        except Exception:
            for image in saved_images:
                Path(image.image_path).unlink(missing_ok=True)
            raise
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


def _check_scenario(scenario: str | None, settings) -> None:
    if settings.demo_mode and scenario and normalize_scenario(scenario) not in demo_scenario_names():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Unknown demo scenario. Known: {', '.join(demo_scenario_names())}.")


@router.post("/{inspection_id}/analyze")
def analyze_inspection(inspection_id: str, scenario: str | None = None, principal: dict = Depends(require_principal)):
    settings = get_settings()
    _check_scenario(scenario, settings)
    with _inspection_lock(principal["organization_id"], inspection_id):
        steps = _analysis_steps(principal, inspection_id, scenario, settings)
        while True:
            try:
                next(steps)
            except StopIteration as done:
                return done.value


SSE_KEEPALIVE_S = 10.0


@router.post("/{inspection_id}/analyze/stream")
def analyze_inspection_stream(inspection_id: str, scenario: str | None = None, principal: dict = Depends(require_principal)):
    """Same run as /analyze, streamed as server-sent events: `step` events, then one `result` (the /analyze body).

    The run happens on a worker thread that holds the inspection lock until it finishes, so a client that disconnects
    mid-stream neither leaves the lock held nor half-writes the inspection.
    """
    settings = get_settings()
    _check_scenario(scenario, settings)
    if not _load(principal, inspection_id).images:  # plain HTTP errors before the stream starts
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No images uploaded for analysis")
    events: queue.Queue = queue.Queue()

    def work():
        try:
            with _inspection_lock(principal["organization_id"], inspection_id):
                steps = _analysis_steps(principal, inspection_id, scenario, settings)
                while True:
                    try:
                        events.put(("step", next(steps)))
                    except StopIteration as done:
                        events.put(("result", done.value))
                        break
        except HTTPException as exc:
            events.put(("error", {"status_code": exc.status_code, "detail": exc.detail}))
        except Exception:
            log.exception("Streamed analysis failed for %s", inspection_id)
            events.put(("error", {"status_code": 500, "detail": "Analysis failed unexpectedly."}))
        finally:
            events.put(None)

    threading.Thread(target=work, name=f"analyze-{inspection_id}", daemon=True).start()

    def stream():
        while True:
            try:
                item = events.get(timeout=SSE_KEEPALIVE_S)
            except queue.Empty:
                yield ": keepalive\n\n"  # keeps proxies from closing the connection during a slow model call
                continue
            if item is None:
                return
            yield f"event: {item[0]}\ndata: {json.dumps(item[1], default=str)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _step(step: str, state: str, message: str, **data) -> dict:
    return {"step": step, "status": state, "message": message, "data": data}


def _fail_open_result(model_version: str) -> dict:
    return {
        "decision": "PENDING_REVIEW",
        "model_version": model_version,
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


def _analysis_steps(principal: dict, inspection_id: str, scenario: str | None, settings):
    """The one analysis pipeline. Yields step events and returns the /analyze body. The caller holds the inspection lock."""
    yield _step("validate", "running", "Loading inspection and photos")
    inspection = _load(principal, inspection_id)
    if not inspection.images:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No images uploaded for analysis")
    images = inspection.images
    n = len(images)
    mode = "demo" if settings.demo_mode else "live"
    yield _step("validate", "done", f"{n} photo{'s' if n != 1 else ''} for PO {inspection.po.po_id} ({mode} mode)",
                images=n, mode=mode, scenario=normalize_scenario(scenario) if settings.demo_mode else None)

    yield _step("quality", "running", f"Checking sharpness, exposure and size of {n} photo{'s' if n != 1 else ''}")
    for image in images:
        if image.quality is None:  # uploaded before quality reports existed
            image.quality = image_quality.assess_path(image.image_path)
    quality = [{"image_id": i.image_id, "filename": i.filename, "view": i.image_type, **i.quality} for i in images]
    flagged = any(q["issues"] for q in quality)
    yield _step("quality", "warning" if flagged else "done", image_quality.summary(quality), images=quality)

    if barcode_reader.available():
        yield _step("barcode", "running", f"Scanning {n} photo{'s' if n != 1 else ''} for barcodes and QR codes")
        for image in images:
            if image.barcodes is None:
                image.barcodes = barcode_reader.decode_path(image.image_path)
    else:
        yield _step("barcode", "skipped", "Barcode reader not installed (pip install zxing-cpp)")
    codes = with_sku_match([{"image_id": i.image_id, **b} for i in images for b in i.barcodes or []], inspection.po.sku)
    if barcode_reader.available():
        if codes:
            first = next((c for c in codes if c["matches_po_sku"]), codes[0])
            message = f"Decoded {first['format']} '{first['text']}' in {first['image_id']}"
            message += " (matches PO SKU)" if first["matches_po_sku"] else " (not the PO SKU)"
            message += f" and {len(codes) - 1} more" if len(codes) > 1 else ""
        else:
            message = "No barcodes found"
        yield _step("barcode", "done", message, barcodes=codes)

    service = VisionService(inspection)
    if settings.demo_mode:
        yield _step("perception", "running", f"Demo scenario '{normalize_scenario(scenario)}': simulated readings, no model call")
    else:
        yield _step("perception", "running", f"Asking {settings.ai_model} to read {n} photo{'s' if n != 1 else ''}",
                    model=settings.ai_model)
    failure_reason = None
    try:
        payload = service.perceive(scenario=scenario if settings.demo_mode else None)
    except Exception as exc:  # fail-open: any perception failure holds the shipment for a human
        log.exception("Perception failed for %s", inspection_id)
        failure_reason = _public_failure_reason(exc)
        yield _step("perception", "error", f"Perception failed, holding for review: {failure_reason}", failure_reason=failure_reason)
    else:
        readings = sum(len(r.observations) for r in payload.images)
        yield _step("perception", "done", f"{service.model_version} returned {readings} readings for {len(payload.images)} of {n} photos",
                    model_version=service.model_version, readings=readings)

    yield _step("rules", "running", "Applying receiving rules to the readings")
    result = _fail_open_result(service.model_version) if failure_reason else service.build(payload, codes)
    counts = {s: sum(1 for c in result["checks"] if c["status"] == s) for s in ("PASS", "FAIL", "UNCERTAIN", "NOT_REQUIRED")}
    message = (f"{len(result['checks'])} checks: {counts['PASS']} passed, {counts['FAIL']} failed, {counts['UNCERTAIN']} uncertain"
               + (f", {counts['NOT_REQUIRED']} not required" if counts["NOT_REQUIRED"] else "") + f" -> {result['decision']}")
    yield _step("rules", "done", message, decision=result["decision"], counts=counts)

    recommendations = build_recommendations(decision=result["decision"], checks=result["checks"], images=images,
                                            failure_reason=failure_reason)
    inspection.checks = [InspectionCheck.model_validate(item) for item in result["checks"]]
    inspection.evidence = [Evidence.model_validate(item) for item in result["evidence"]]
    inspection.observations = [VisualObservation.model_validate(item) for item in result["observations"]]
    inspection.final_decision = result["decision"]
    inspection.override_decision = None
    inspection.override_reason = None
    inspection.agent_summary = _build_agent_summary(inspection)
    inspection.recommendations = recommendations
    inspection.status = "completed" if failure_reason is None else "pending"
    inspection.updated_at = datetime.now(timezone.utc)
    repository.update(inspection)

    yield _step("seal", "running", "Sealing the evidence record")
    # A new record version; earlier versions and every override stay in the chain.
    record = repository.append_record(
        principal["organization_id"], inspection_id,
        lambda previous, version: build_record(
            inspection=inspection, verdict=result["decision"], checks=result["checks"],
            model_version=result["model_version"], operator=principal, version=version, previous=previous,
            status="analyzed" if failure_reason is None else "pending_review", failure_reason=failure_reason,
            evidence=result["evidence"],
        ),
    )
    yield _step("seal", "done", f"Record v{record['version']} sealed {record['content_hash'][:6]}…",
                record_id=record["record_id"], version=record["version"], content_hash=record["content_hash"])

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
        "recommendations": recommendations,
        "image_quality": quality,
        "barcodes": codes,
    }


@router.post("/{inspection_id}/override")
def override_inspection(inspection_id: str, payload: InspectionOverrideRequest, principal: dict = Depends(require_principal)):
    _load(principal, inspection_id)
    decision = payload.decision.strip().upper()
    if decision not in {"PASS", "EXCEPTION", "UNCERTAIN"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Override decision must be PASS, EXCEPTION, or UNCERTAIN.")
    if decision == "PASS" and principal["role"] != "approver":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only an approver may override to PASS.")
    with _inspection_lock(principal["organization_id"], inspection_id):
        return _override_locked(principal, inspection_id, decision, payload.reason)


def _override_locked(principal: dict, inspection_id: str, decision: str, reason: str) -> dict:
    inspection = _load(principal, inspection_id)

    result = repository.append_override(
        principal["organization_id"], inspection_id,
        lambda previous: build_override_record(previous, verdict=decision, reason=reason, operator=principal),
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
