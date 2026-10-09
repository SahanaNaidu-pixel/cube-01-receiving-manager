from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PurchaseOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    po_id: str = Field(..., min_length=1)
    sku: str = Field(..., min_length=1)
    product_name: str = Field(..., min_length=1)
    expected_quantity: int = Field(..., ge=0)
    variant: str = Field(..., min_length=1)
    units_per_carton: int = Field(..., ge=1)
    expected_cartons: int = Field(..., ge=0)
    expected_components: list[str] = Field(default_factory=list)
    unit_id: str | None = None
    asin: str | None = None
    po_line: str | None = None

    @field_validator("po_id", "sku", "product_name", "variant")
    @classmethod
    def validate_required_fields(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Value cannot be empty")
        return value.strip()
