from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from backend.app.api.deps import Pagination, eq_ci, require_principal, text_match
from backend.app.core.errors import AppError
from backend.app.models.intake import Shipment
from backend.app.services import catalogue as catalogue_service
from backend.app.services import inspection_service as svc

router = APIRouter(prefix="/api", tags=["catalogue"])
Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
Required = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
MAX_IMPORT_BYTES = 5 * 1024 * 1024


class ProductIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sku: Required
    asin: Text | None = None
    product_name: Required
    variant: Text | None = None
    colour: Text | None = None
    units_per_carton: int | None = Field(default=None, ge=1, le=1_000_000)
    expected_components: list[Text] = Field(default_factory=list, max_length=50)
    supplier: Text | None = None


class ProductUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sku: Text | None = None
    asin: Text | None = None
    product_name: Required | None = None
    variant: Text | None = None
    colour: Text | None = None
    units_per_carton: int | None = Field(default=None, ge=1, le=1_000_000)
    expected_components: list[Text] | None = Field(default=None, max_length=50)
    supplier: Text | None = None


class POLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line: int | Text
    sku: Required
    product_name: Text | None = None
    variant: Text | None = None
    expected_quantity: int = Field(..., ge=0, le=1_000_000)
    units_per_carton: int | None = Field(default=None, ge=1, le=1_000_000)
    expected_cartons: int | None = Field(default=None, ge=0, le=1_000_000)


class PurchaseOrderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    po_number: Required
    supplier: Text | None = None
    expected_delivery_date: str | None = None
    warehouse: Text | None = None
    lines: list[POLine] = Field(default_factory=list, max_length=500)

    @field_validator("expected_delivery_date")
    @classmethod
    def _date(cls, value):
        return Shipment._date(value)


# --- products -----------------------------------------------------------------------------------


@router.get("/products")
def list_products(q: str | None = None, supplier: str | None = None, pagination: Pagination = Depends(),
                  principal: dict = Depends(require_principal)):
    items = [p for p in catalogue_service.list_products(principal["organization_id"])
             if text_match(q, p["sku"], p.get("asin"), p.get("product_name"), p.get("variant"), p.get("supplier"))
             and eq_ci(supplier, p.get("supplier"))]
    items.sort(key=lambda p: p["sku"].lower())
    return pagination.apply(items)


@router.post("/products", status_code=status.HTTP_201_CREATED)
def create_product(payload: ProductIn, principal: dict = Depends(require_principal)):
    return catalogue_service.create_product(principal, payload.model_dump())


@router.get("/products/{sku}")
def get_product(sku: str, principal: dict = Depends(require_principal)):
    org = principal["organization_id"]
    product = catalogue_service.get_product(org, sku)
    if product is None:
        raise AppError(404, "Product not found")
    ctx = svc.OrgContext(org)
    inspections = [svc.inspection_summary(i, ctx) for i in svc.repository.list(org) if eq_ci(sku, i.po.sku)]
    inspections.sort(key=lambda s: s["created_at"], reverse=True)
    return {**product, "inspections": inspections}


@router.put("/products/{sku}")
def update_product(sku: str, payload: ProductUpdate, principal: dict = Depends(require_principal)):
    changes = payload.model_dump(exclude_unset=True)
    if changes.get("sku") and changes["sku"].upper() != sku.strip().upper():
        raise AppError(422, "sku in the body must match the path (SKUs cannot be renamed).", "VALIDATION_ERROR")
    return catalogue_service.update_product(principal, sku, changes)


# --- purchase orders ----------------------------------------------------------------------------


@router.get("/purchase-orders")
def list_purchase_orders(q: str | None = None, status_: str | None = Query(None, alias="status"), supplier: str | None = None,
                         pagination: Pagination = Depends(), principal: dict = Depends(require_principal)):
    items = [po for po in catalogue_service.all_purchase_orders(principal["organization_id"])
             if text_match(q, po["po_number"], po.get("supplier"), *[line.get("sku") for line in po["lines"]])
             and eq_ci(status_, po["status"]) and eq_ci(supplier, po.get("supplier"))]
    items.sort(key=lambda po: po["po_number"])
    return pagination.apply(items)


@router.post("/purchase-orders", status_code=status.HTTP_201_CREATED)
def create_purchase_order(payload: PurchaseOrderIn, principal: dict = Depends(require_principal)):
    lines = [str(line.line) for line in payload.lines]
    if len(lines) != len(set(lines)):
        raise AppError(422, "lines: line numbers must be unique", "VALIDATION_ERROR")
    catalogue_service.create_purchase_order(principal, payload.model_dump())
    return catalogue_service.get_purchase_order(principal["organization_id"], payload.po_number)


@router.get("/purchase-orders/{po_number}")
def get_purchase_order(po_number: str, principal: dict = Depends(require_principal)):
    return catalogue_service.get_purchase_order(principal["organization_id"], po_number)


# --- import -------------------------------------------------------------------------------------


@router.post("/catalogue/import")
async def import_catalogue(request: Request, principal: dict = Depends(require_principal)):
    content_type = (request.headers.get("content-type") or "").lower()
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise AppError(400, "Multipart field 'file' (CSV) is required.")
        raw = await upload.read(MAX_IMPORT_BYTES + 1)
        if len(raw) > MAX_IMPORT_BYTES:
            raise AppError(413, "CSV exceeds 5 MB.")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise AppError(400, "CSV must be UTF-8.") from None
        from starlette.concurrency import run_in_threadpool

        return await run_in_threadpool(catalogue_service.import_csv, principal, text, "upload")
    raw = await request.body()
    try:
        body = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        raise AppError(400, "Body must be multipart (file) or JSON {\"source\": \"sample\"}.") from None
    if not isinstance(body, dict) or body.get("source") != "sample":
        raise AppError(422, "source: must be 'sample' (or upload a CSV as multipart field 'file').", "VALIDATION_ERROR")
    from starlette.concurrency import run_in_threadpool

    return await run_in_threadpool(catalogue_service.import_sample, principal)


# --- shipments & cartons --------------------------------------------------------------------------


def _shipment_out(group: dict, with_inspections: bool = False, principal: dict | None = None) -> dict:
    out = {k: v for k, v in group.items() if k != "_inspections"}
    if with_inspections:
        ctx = svc.OrgContext(principal["organization_id"])
        out["inspections"] = [svc.inspection_summary(i, ctx) for i in group["_inspections"]]
    return out


@router.get("/shipments")
def list_shipments(q: str | None = None, supplier: str | None = None, pagination: Pagination = Depends(),
                   principal: dict = Depends(require_principal)):
    items = [_shipment_out(g) for g in catalogue_service.shipments(principal["organization_id"])
             if text_match(q, g["shipment_id"], g.get("supplier"), g.get("asn"), g.get("warehouse"))
             and eq_ci(supplier, g.get("supplier"))]
    return pagination.apply(items)


@router.get("/shipments/{shipment_id}")
def get_shipment(shipment_id: str, principal: dict = Depends(require_principal)):
    for group in catalogue_service.shipments(principal["organization_id"]):
        if group["shipment_id"] == shipment_id:
            return _shipment_out(group, True, principal)
    raise AppError(404, "Shipment not found")


@router.get("/cartons")
def list_cartons(inspection_id: str | None = None, shipment_id: str | None = None, po: str | None = None,
                 sku: str | None = None, condition: str | None = None, pagination: Pagination = Depends(),
                 principal: dict = Depends(require_principal)):
    items = [c for c in catalogue_service.cartons(principal["organization_id"])
             if eq_ci(inspection_id, c["inspection_id"]) and eq_ci(shipment_id, c["shipment_id"])
             and eq_ci(po, c["po_id"]) and eq_ci(sku, c["sku"])
             and (not condition or condition.lower() in (c["seal_condition"], c["visible_condition"]))]
    items.sort(key=lambda c: c["created_at"], reverse=True)
    return pagination.apply(items)


@router.get("/cartons/{inspection_id}/{carton_id}")
def get_carton(inspection_id: str, carton_id: str, principal: dict = Depends(require_principal)):
    for carton in catalogue_service.cartons(principal["organization_id"]):
        if carton["inspection_id"] == inspection_id and carton["carton_id"] == carton_id:
            return carton
    raise AppError(404, "Carton not found")

