from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

# Upper bounds keep a single PO from bloating the stored record and the vision prompt.
MAX_COUNT = 1_000_000
MAX_TEXT = 200
MAX_COMPONENTS = 50

Component = Annotated[str, StringConstraints(max_length=MAX_TEXT)]


class PurchaseOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    po_id: str = Field(..., min_length=1, max_length=MAX_TEXT)
    sku: str = Field(..., min_length=1, max_length=MAX_TEXT)
    product_name: str = Field(..., min_length=1, max_length=MAX_TEXT)
    expected_quantity: int = Field(..., ge=0, le=MAX_COUNT)
    variant: str = Field(..., min_length=1, max_length=MAX_TEXT)
    units_per_carton: int = Field(..., ge=1, le=MAX_COUNT)
    expected_cartons: int = Field(..., ge=0, le=MAX_COUNT)
    expected_components: list[Component] = Field(default_factory=list, max_length=MAX_COMPONENTS)
    unit_id: str | None = Field(default=None, max_length=MAX_TEXT)
    asin: str | None = Field(default=None, max_length=MAX_TEXT)
    po_line: str | None = Field(default=None, max_length=MAX_TEXT)

    @field_validator("po_id", "sku", "product_name", "variant")
    @classmethod
    def validate_required_fields(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Value cannot be empty")
        return value.strip()
