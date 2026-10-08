"""Optional intake data: shipment header, carton list, operator manual observations."""

from __future__ import annotations

import re
from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

MAX_TEXT = 200
MAX_CARTONS = 200
Text = Annotated[str, StringConstraints(max_length=MAX_TEXT, strip_whitespace=True)]
SealCondition = Literal["intact", "broken", "resealed", "unknown"]
VisibleCondition = Literal["good", "crushed", "torn", "punctured", "wet", "open", "label_damaged", "unknown"]


class Shipment(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    shipment_id: Text | None = None
    supplier: Text | None = None
    expected_delivery_date: str | None = None
    warehouse: Text | None = None
    asn: Text | None = None

    @field_validator("expected_delivery_date")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        if value in (None, ""):
            return None
        value = value.strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("expected_delivery_date must be YYYY-MM-DD")
        date.fromisoformat(value)
        return value


class Carton(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    carton_id: Annotated[str, StringConstraints(min_length=1, max_length=MAX_TEXT, strip_whitespace=True)]
    expected_units: int | None = Field(default=None, ge=0, le=1_000_000)
    carton_type: Text | None = None
    weight_kg: float | None = Field(default=None, ge=0, le=100_000)
    dimensions_cm: Text | None = None
    seal_condition: SealCondition = "unknown"
    visible_condition: VisibleCondition = "unknown"
    notes: Annotated[str, StringConstraints(max_length=500)] | None = None


class ManualObservations(BaseModel):
    """Operator counts and readings: real evidence from a person, fused as reading source 'operator'."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    observed_sku: Text | None = None
    observed_quantity: int | None = Field(default=None, ge=0, le=1_000_000)
    observed_cartons: int | None = Field(default=None, ge=0, le=1_000_000)
    observed_units_per_carton: int | None = Field(default=None, ge=0, le=1_000_000)
    observed_variant: Text | None = None
    damage: list[Text] | Text | None = None
    components_present: list[Text] | None = Field(default=None, max_length=50)
    components_missing: list[Text] | None = Field(default=None, max_length=50)
    note: Annotated[str, StringConstraints(max_length=2000)] | None = None

    @field_validator("damage")
    @classmethod
    def _damage(cls, value):
        if isinstance(value, list) and len(value) > 50:
            raise ValueError("at most 50 damage entries")
        return value

    def has_readings(self) -> bool:
        return any(v not in (None, "", []) for k, v in self.model_dump().items() if k != "note")
