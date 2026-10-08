from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, File, Form, Query, UploadFile, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from backend.app.api.deps import (  # noqa: F401  (re-exported: tests and older imports use these names)
    KEYS_MISCONFIGURED,
    PLACEHOLDER_KEY_PREFIX,
    ROLES,
    DateRange,
    Pagination,
    _parse_api_keys,
    eq_ci,
    require_principal,
    text_match,
)
from backend.app.core.config import get_settings
from backend.app.core.errors import AppError
from backend.app.models.inspection import ReceivingImage
from backend.app.models.intake import MAX_CARTONS, Carton, ManualObservations, Shipment
from backend.app.models.po import PurchaseOrder
from backend.app.services import a2a as a2a_service
from backend.app.services import exports as export_service
from backend.app.services import inspection_service as svc
from backend.app.services import reviews as review_service
from backend.app.services.audit import list_events
from backend.app.services.inspection_service import (  # noqa: F401
    CONTRACT_VIEWS,
    LEGACY_VIEWS,
    log,
    repository,
    storage,
)
from backend.app.services.uploads import (  # noqa: F401
    MAX_FILENAME_LENGTH,
    _detect_image_mime,
    _safe_filename,
    check_name,
    validate_image_content,
)

router = APIRouter(prefix="/api/inspections", tags=["inspections"])
_public_failure_reason = svc.public_failure_reason
_contract_view = svc.contract_view

Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class InspectionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    po: PurchaseOrder
    images: list[ReceivingImage] = Field(default_factory=list)
    shipment: Shipment | None = None
    cartons: list[Carton] = Field(default_factory=list, max_length=MAX_CARTONS)


class InspectionOverrideRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)  # strip before min_length

    decision: str = Field(..., min_length=1)
    reason: str = Field(..., min_length=1, max_length=2000)


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    manual_observations: ManualObservations | None = None
    scenario: str | None = Field(default=None, max_length=100)


class ReviewCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Reason
    assigned_to: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] | None = None


class NoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Reason


class HandoffRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_agent: Literal["prep_manager", "recovery_manager", "returns_manager", "pack_manager"]


def _validate_image_upload(file: UploadFile, inspection_id: str):
    suffix, original_name = check_name(file.filename)  # the raw client name is never stored or echoed
    max_bytes = get_settings().max_image_size_mb * 1024 * 1024
    content = file.file.read(max_bytes + 1)
    return validate_image_content(suffix, original_name, content, file.content_type, inspection_id)


def upload_body_limit(settings) -> int:
    """Largest upload request that could succeed: every allowed image at full size plus multipart overhead."""
    return settings.upload_max_images * settings.max_image_size_mb * 1024 * 1024 + 1024 * 1024


SORT_KEYS = {"created_at", "updated_at", "po_id", "sku", "verdict"}


@router.get("")
def list_inspections(
    q: str | None = None,
    verdict: str | None = None,
    status_: str | None = Query(None, alias="status"),
    supplier: str | None = None,
    sku: str | None = None,
    po: str | None = None,
    shipment_id: str | None = None,
    has_open_issues: bool | None = None,
    sort: str = "created_at",
    order: Literal["asc", "desc"] = "desc",
    dates: DateRange = Depends(),
    pagination: Pagination = Depends(),
    principal: dict = Depends(require_principal),
):
    if sort not in SORT_KEYS:
        raise AppError(422, f"sort must be one of {', '.join(sorted(SORT_KEYS))}", "VALIDATION_ERROR")
    verdict_filter = verdict.strip().upper() if verdict else None
    if verdict_filter and verdict_filter not in {"PASS", "FAIL", "UNCERTAIN", "NOT_ANALYZED"}:
        raise AppError(422, "verdict must be PASS, FAIL, UNCERTAIN or NOT_ANALYZED", "VALIDATION_ERROR")
    org = principal["organization_id"]
    ctx = svc.OrgContext(org)
    views = []
    for inspection in repository.list(org):
        view = svc.inspection_view(inspection, ctx)
        ship = inspection.shipment
        if not text_match(q, inspection.inspection_id, inspection.po.po_id, inspection.po.sku, inspection.po.product_name,
                          ship.supplier if ship else None, ship.shipment_id if ship else None):
            continue
        if verdict_filter and (view["verdict"] or "NOT_ANALYZED") != verdict_filter:
            continue
        if not eq_ci(status_, inspection.status) or not eq_ci(sku, inspection.po.sku) or not eq_ci(po, inspection.po.po_id):
            continue
        if not eq_ci(supplier, ship.supplier if ship else None) or not eq_ci(shipment_id, ship.shipment_id if ship else None):
            continue
        if has_open_issues is not None and (view["open_issue_count"] > 0) != has_open_issues:
            continue
        if not dates.contains(inspection.created_at):
            continue
        views.append(view)

    def key(v):
        return str(v["po"][sort]).lower() if sort in ("po_id", "sku") else v.get(sort)

    present = [v for v in views if key(v) is not None]
    missing = [v for v in views if key(v) is None]  # e.g. not analysed when sorting by verdict: always last
    present.sort(key=lambda v: str(key(v)), reverse=(order == "desc"))
    return pagination.apply(present + missing)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_inspection(payload: InspectionCreateRequest, principal: dict = Depends(require_principal)):
    if payload.images:
        raise AppError(400, "Images must be uploaded through /images.")
    ids = [c.carton_id for c in payload.cartons]
    if len(ids) != len(set(ids)):
        raise AppError(422, "cartons: carton_id values must be unique", "VALIDATION_ERROR")
    inspection = svc.create_inspection(principal, payload.po, payload.shipment, payload.cartons)
    return svc.inspection_view(inspection, svc.OrgContext(principal["organization_id"]))


@router.get("/{inspection_id}")
def get_inspection(inspection_id: str, principal: dict = Depends(require_principal)):
    return svc.inspection_detail(principal, svc.load(principal, inspection_id))


@router.post("/{inspection_id}/images")
def upload_images(
    inspection_id: str,
    files: list[UploadFile] = File(...),
    image_type: str = Form("other"),
    principal: dict = Depends(require_principal),
):
    inspection = svc.load(principal, inspection_id)
    if not files:
        raise AppError(400, "No image files were provided")
    settings = get_settings()
    # Cheap pre-check before any file is read into memory; re-checked under the lock.
    svc.check_image_count(inspection, len(files), settings)
    validated_files = [_validate_image_upload(file, inspection_id) for file in files]  # all-or-nothing: validate first
    view = svc.contract_view(image_type)
    saved = svc.store_images(principal, inspection_id, validated_files, [view] * len(validated_files))
    return {
        "inspection_id": inspection_id,
        "images": [image.model_dump(mode="json", exclude={"image_path"}) for image in saved],
    }


@router.get("/{inspection_id}/images/{image_id}")
def get_inspection_image(inspection_id: str, image_id: str, principal: dict = Depends(require_principal)):
    inspection = svc.load(principal, inspection_id)
    image_record = next((img for img in inspection.images if img.image_id == image_id), None)
    if image_record is None:
        raise AppError(404, "Image not found")
    try:
        file_path = storage.resolve(inspection_id, image_record.stored_filename)
    except ValueError as exc:
        raise AppError(400, "Invalid image path") from exc
    if not file_path.exists() or not file_path.is_file():
        raise AppError(404, "Image file not found")
    # Re-sanitize: records stored before filenames were cleaned may still hold a raw client name.
    filename = _safe_filename(image_record.filename, file_path.suffix)
    return FileResponse(file_path, media_type=image_record.mime_type, filename=filename)


@router.post("/{inspection_id}/run")
@router.post("/{inspection_id}/analyze")
def run_inspection(
    inspection_id: str,
    scenario: str | None = None,
    payload: RunRequest | None = Body(default=None),
    principal: dict = Depends(require_principal),
):
    manual_provided = payload is not None and "manual_observations" in payload.model_fields_set
    chosen = (payload.scenario if payload and payload.scenario else None) or scenario
    return svc.run_inspection(principal, inspection_id, chosen, payload.manual_observations if payload else None,
                              manual_provided)


analyze_inspection = run_inspection


@router.post("/{inspection_id}/review", status_code=status.HTTP_201_CREATED)
def create_review(inspection_id: str, payload: ReviewCreateRequest, principal: dict = Depends(require_principal)):
    inspection = svc.load(principal, inspection_id)
    return review_service.create_manual(principal, inspection, payload.reason, payload.assigned_to or None)


@router.post("/{inspection_id}/override")
def override_inspection(inspection_id: str, payload: InspectionOverrideRequest, principal: dict = Depends(require_principal)):
    return svc.override(principal, inspection_id, payload.decision, payload.reason)


@router.post("/{inspection_id}/notes", status_code=status.HTTP_201_CREATED)
def add_note(inspection_id: str, payload: NoteRequest, principal: dict = Depends(require_principal)):
    return svc.add_note(principal, inspection_id, payload.text)


@router.post("/{inspection_id}/handoff")
def handoff(inspection_id: str, payload: HandoffRequest, principal: dict = Depends(require_principal)):
    return a2a_service.handoff(principal, inspection_id, payload.target_agent)


@router.get("/{inspection_id}/verify")
def verify_inspection(inspection_id: str, principal: dict = Depends(require_principal)):
    return svc.verify(principal, inspection_id)


@router.get("/{inspection_id}/export")
def export_inspection(inspection_id: str, format: Literal["json", "csv", "html"] = "json",
                      principal: dict = Depends(require_principal)) -> Response:
    return export_service.export(principal, inspection_id, format)


@router.get("/{inspection_id}/audit")
def inspection_audit(inspection_id: str, pagination: Pagination = Depends(), principal: dict = Depends(require_principal)):
    svc.load(principal, inspection_id)
    # Chronological: the trail reads top to bottom as it happened.
    return pagination.apply(list_events(principal["organization_id"], inspection_id=inspection_id))
