from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .evidence import Evidence
from .po import PurchaseOrder

InspectionStatus = Literal["draft", "pending", "completed"]
DecisionStatus = Literal["PASS", "FAIL", "UNCERTAIN", "NOT_REQUIRED"]
# PENDING_REVIEW = perception failed (fail-open); UNCERTAIN = evidence inconclusive.
FinalDecision = Literal["PASS", "EXCEPTION", "UNCERTAIN", "PENDING_REVIEW"]


class ReceivingImage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_id: str = Field(..., min_length=1)
    inspection_id: str = Field(..., min_length=1)
    filename: str = Field(..., min_length=1)
    stored_filename: str = Field(..., min_length=1)
    image_path: str = Field(..., min_length=1)
    image_type: str = Field(default="receiving_photo")
    mime_type: str = Field(default="image/jpeg")
    file_size: int = Field(default=0, ge=0)
    sha256_digest: str = ""
    processing_state: Literal["uploaded", "ready", "analyzing", "analyzed", "failed"] = "uploaded"
    uploaded_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    quality: dict[str, Any] | None = None  # image_quality.assess(), computed at upload
    barcodes: list[dict[str, Any]] | None = None  # None = not scanned yet; [] = scanned, nothing found

    @field_validator("image_id", "inspection_id", "filename", "stored_filename", "image_path")
    @classmethod
    def validate_required_fields(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Value cannot be empty")
        return value.strip()


class VisualObservation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detected_sku: str | None = None
    detected_product_name: str | None = None
    observed_quantity: int | None = Field(default=None, ge=0)
    observed_cartons: int | None = Field(default=None, ge=0)
    observed_units_per_carton: int | None = Field(default=None, ge=1)
    detected_variant: str | None = None
    damage_types: list[str] = Field(default_factory=list)
    missing_components: list[str] = Field(default_factory=list)
    visibility_quality: str | None = None
    confidence: float = Field(..., ge=0.0, le=1.0)

    @field_validator("detected_sku", "detected_product_name", "detected_variant", "visibility_quality")
    @classmethod
    def trim_optional_strings(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip()


class InspectionCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check_name: str = Field(..., min_length=1)
    status: DecisionStatus
    expected_value: str | int | list[str] | None = None
    observed_value: str | int | list[str] | None = None
    evidence_ids: list[str] = Field(default_factory=list)
    reason: str = Field(..., min_length=1)
    reason_code: str = ""
    measurements: dict[str, Any] = Field(default_factory=dict)
    confidence: float = Field(..., ge=0.0, le=1.0)

    @field_validator("check_name")
    @classmethod
    def validate_check_name(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("check_name cannot be empty")
        return value.strip()


class Inspection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inspection_id: str = Field(..., min_length=1)
    organization_id: str = ""
    po: PurchaseOrder
    images: list[ReceivingImage] = Field(default_factory=list)
    observations: list[VisualObservation] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    checks: list[InspectionCheck] = Field(default_factory=list)
    final_decision: FinalDecision = "UNCERTAIN"
    override_decision: FinalDecision | None = None
    override_reason: str | None = None
    agent_summary: str = ""
    recommendations: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    status: InspectionStatus = "draft"
    prep_hold: bool = True
    record: dict[str, Any] | None = None
    overrides: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("inspection_id")
    @classmethod
    def validate_inspection_id(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("inspection_id cannot be empty")
        return value.strip()


class InspectionResult(BaseModel):
    inspection_id: str = Field(..., min_length=1)
    po_id: str = Field(..., min_length=1)
    checks: list[InspectionCheck] = Field(default_factory=list)
    overall_decision: FinalDecision
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
