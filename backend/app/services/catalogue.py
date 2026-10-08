"""Products, purchase orders (stored + derived from inspections), CSV import, shipments and cartons."""

from __future__ import annotations

import csv
import io
from pathlib import Path

from backend.app.core.config import REPO_ROOT
from backend.app.core.errors import AppError
from backend.app.database.repository import products_table, purchase_orders_table
from backend.app.services import inspection_service as svc
from backend.app.services.audit import record_event
from backend.app.services.evidence_record import now_rfc3339

SAMPLE_CSV = REPO_ROOT / "data" / "receiving_sample.csv"
REQUIRED_COLUMNS = {"po_number", "po_line", "sku", "product_title", "qty_ordered", "cartons_ordered", "units_per_carton_ordered"}
MAX_IMPORT_ROWS = 10_000
NOT_SPECIFIED = {"", "n/a", "na", "none"}


def _key(value: str) -> str:
    return (value or "").strip().upper()


# --- products -----------------------------------------------------------------------------------


def list_products(organization_id: str) -> list[dict]:
    return products_table.find(organization_id)


def get_product(organization_id: str, sku: str) -> dict | None:
    return products_table.get(organization_id, _key(sku))


def _save_product(organization_id: str, product: dict) -> dict:
    return products_table.upsert(organization_id, _key(product["sku"]), product, created_at=product["created_at"],
                                 updated_at=product["updated_at"])


def create_product(principal: dict, data: dict) -> dict:
    org = principal["organization_id"]
    if get_product(org, data["sku"]):
        raise AppError(409, f"Product {data['sku']} already exists.", "CONFLICT")
    now = now_rfc3339()
    product = {**data, "created_at": now, "updated_at": now}
    _save_product(org, product)
    record_event(principal, "product.created", "product", product["sku"], summary=f"Product {product['sku']} created")
    return product


def update_product(principal: dict, sku: str, changes: dict) -> dict:
    org = principal["organization_id"]
    product = get_product(org, sku)
    if product is None:
        raise AppError(404, "Product not found")
    changes.pop("sku", None)
    product.update(changes)
    product["updated_at"] = now_rfc3339()
    _save_product(org, product)
    record_event(principal, "product.updated", "product", product["sku"], summary=f"Product {product['sku']} updated",
                 details={"fields": sorted(changes)})
    return product


# --- purchase orders ----------------------------------------------------------------------------


def _save_po(organization_id: str, po: dict) -> dict:
    return purchase_orders_table.upsert(organization_id, _key(po["po_number"]), po, created_at=po["created_at"],
                                        updated_at=po.get("updated_at") or po["created_at"])


def create_purchase_order(principal: dict, data: dict) -> dict:
    org = principal["organization_id"]
    if purchase_orders_table.get(org, _key(data["po_number"])):
        raise AppError(409, f"Purchase order {data['po_number']} already exists.", "CONFLICT")
    now = now_rfc3339()
    po = {**data, "source": "catalogue", "created_at": now, "updated_at": now}
    _save_po(org, po)
    record_event(principal, "purchase_order.created", "purchase_order", po["po_number"],
                 summary=f"Purchase order {po['po_number']} created ({len(po.get('lines') or [])} lines)")
    return po


def _observed_quantity(inspection) -> int | None:
    for check in (inspection.record or {}).get("checks", []):
        if check["check_key"] == "total_quantity" and isinstance(check.get("observed_state"), int) and not isinstance(check.get("observed_state"), bool):
            return check["observed_state"]
    return None


def _enrich(po: dict, inspections: list) -> dict:
    """Derive received quantities, discrepancies and PO status from analysed inspections of the PO."""
    po = dict(po)
    mine = [i for i in inspections if _key(i.po.po_id) == _key(po["po_number"])]
    lines = []
    for line in po.get("lines") or []:
        line = dict(line)
        matching = [i for i in mine if _key(i.po.sku) == _key(line.get("sku"))]
        observed = [q for q in (_observed_quantity(i) for i in matching if i.record) if q is not None]
        received = sum(observed) if observed else None
        expected = line.get("expected_quantity")
        if received is None or expected is None:
            discrepancy = "unverified"
        elif received < expected:
            discrepancy = "short"
        elif received > expected:
            discrepancy = "over"
        else:
            discrepancy = "none"
        line.update(received_quantity=received, inspection_ids=[i.inspection_id for i in matching], discrepancy=discrepancy)
        lines.append(line)
    po["lines"] = lines
    if not any(line["inspection_ids"] for line in lines):
        po["status"] = "open"
    elif any(line["discrepancy"] in ("short", "over") for line in lines):
        po["status"] = "discrepancy"
    elif lines and all(line["discrepancy"] == "none" for line in lines):
        po["status"] = "received"
    else:
        po["status"] = "partially_received"
    po["inspection_count"] = len(mine)
    return po


def all_purchase_orders(organization_id: str) -> list[dict]:
    inspections = svc.repository.list(organization_id)
    stored = purchase_orders_table.find(organization_id)
    known = {_key(po["po_number"]) for po in stored}
    derived: dict[str, dict] = {}
    for inspection in inspections:
        key = _key(inspection.po.po_id)
        if key in known:
            continue
        po = derived.setdefault(key, {
            "po_number": inspection.po.po_id,
            "supplier": inspection.shipment.supplier if inspection.shipment else None,
            "expected_delivery_date": inspection.shipment.expected_delivery_date if inspection.shipment else None,
            "warehouse": inspection.shipment.warehouse if inspection.shipment else None,
            "lines": [],
            "source": "inspections",
            "created_at": svc.utc_iso(inspection.created_at),
        })
        if not any(_key(line["sku"]) == _key(inspection.po.sku) for line in po["lines"]):
            p = inspection.po
            po["lines"].append({"line": p.po_line or len(po["lines"]) + 1, "sku": p.sku, "product_name": p.product_name,
                                "variant": p.variant, "expected_quantity": p.expected_quantity,
                                "units_per_carton": p.units_per_carton, "expected_cartons": p.expected_cartons})
    return [_enrich(po, inspections) for po in stored + list(derived.values())]


def get_purchase_order(organization_id: str, po_number: str) -> dict:
    for po in all_purchase_orders(organization_id):
        if _key(po["po_number"]) == _key(po_number):
            return po
    raise AppError(404, "Purchase order not found")


# --- import -------------------------------------------------------------------------------------


def _int(value, field: str, row: int) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        raise AppError(400, f"Row {row}: {field} must be an integer.", "VALIDATION_ERROR", {"row": row, "field": field}) from None
    if number < 0 or number > 1_000_000:
        raise AppError(400, f"Row {row}: {field} out of range.", "VALIDATION_ERROR", {"row": row, "field": field})
    return number


def _text(value, limit: int = 200) -> str | None:
    text = (value or "").strip()
    return text[:limit] or None


def import_csv(principal: dict, text: str, source: str) -> dict:
    org = principal["organization_id"]
    reader = csv.DictReader(io.StringIO(text))
    columns = {c.strip() for c in reader.fieldnames or []}
    missing = sorted(REQUIRED_COLUMNS - columns)
    if missing:
        raise AppError(400, f"CSV is missing columns: {', '.join(missing)}.", "VALIDATION_ERROR", {"missing": missing})
    now = now_rfc3339()
    products: dict[str, dict] = {}
    pos: dict[str, dict] = {}
    rows = 0
    for index, raw in enumerate(reader, start=2):
        rows += 1
        if rows > MAX_IMPORT_ROWS:
            raise AppError(400, f"CSV has more than {MAX_IMPORT_ROWS} rows.", "VALIDATION_ERROR")
        row = {(k or "").strip(): (v or "") for k, v in raw.items()}
        sku = _text(row.get("sku"))
        po_number = _text(row.get("po_number"))
        if not sku or not po_number:
            raise AppError(400, f"Row {index}: sku and po_number are required.", "VALIDATION_ERROR", {"row": index})
        units = _int(row.get("units_per_carton_ordered"), "units_per_carton_ordered", index)
        cartons = _int(row.get("cartons_ordered"), "cartons_ordered", index)
        quantity = _int(row.get("qty_ordered"), "qty_ordered", index)
        components = [c.strip()[:200] for c in (row.get("spec_components") or "").split(";") if c.strip()][:50]
        variant = _text(row.get("spec_variant")) or "n/a"
        colour = _text(row.get("spec_colour"))
        supplier = _text(row.get("supplier"))
        products[_key(sku)] = {
            "sku": sku, "asin": _text(row.get("asin")), "product_name": _text(row.get("product_title")) or sku,
            "variant": variant, "colour": None if (colour or "").lower() in NOT_SPECIFIED else colour,
            "units_per_carton": units, "expected_components": components, "supplier": supplier,
        }
        po = pos.setdefault(_key(po_number), {"po_number": po_number, "supplier": supplier, "expected_delivery_date": None,
                                              "warehouse": None, "lines": {}})
        line_no = _text(row.get("po_line")) or str(len(po["lines"]) + 1)
        po["lines"][line_no] = {
            "line": int(line_no) if line_no.isdigit() else line_no, "sku": sku,
            "product_name": products[_key(sku)]["product_name"], "variant": variant, "expected_quantity": quantity,
            "units_per_carton": units, "expected_cartons": cartons, "unit_id": _text(row.get("unit_id")),
            "asin": _text(row.get("asin")), "expected_components": components,
        }
    for key, product in products.items():
        existing = products_table.get(org, key)
        merged = {**(existing or {}), **product, "created_at": (existing or {}).get("created_at", now), "updated_at": now}
        _save_product(org, merged)
    for key, po in pos.items():
        existing = purchase_orders_table.get(org, key)
        lines = {str(line.get("line")): line for line in (existing or {}).get("lines", [])}
        lines.update(po["lines"])
        merged = {**(existing or {}), **{k: v for k, v in po.items() if k != "lines"},
                  "lines": sorted(lines.values(), key=lambda line: str(line.get("line")).zfill(6)),
                  "source": "catalogue", "created_at": (existing or {}).get("created_at", now), "updated_at": now}
        if existing and existing.get("supplier"):
            merged["supplier"] = existing["supplier"]
        _save_po(org, merged)
    result = {"products": len(products), "purchase_orders": len(pos), "rows": rows}
    record_event(principal, "catalogue.imported", "catalogue", source, summary=f"Imported {rows} rows from {source}",
                 details=result)
    return result


def import_sample(principal: dict) -> dict:
    path = Path(SAMPLE_CSV)
    if not path.is_file():
        raise AppError(503, "Sample catalogue data/receiving_sample.csv is not available on this deployment.",
                       "SERVICE_UNAVAILABLE")
    return import_csv(principal, path.read_text(encoding="utf-8"), "sample")


# --- shipments & cartons (derived) ------------------------------------------------------------


def shipments(organization_id: str) -> list[dict]:
    groups: dict[str, dict] = {}
    for inspection in svc.repository.list(organization_id):
        ship = inspection.shipment
        if not ship or not ship.shipment_id:
            continue
        group = groups.setdefault(ship.shipment_id, {
            "shipment_id": ship.shipment_id, "supplier": ship.supplier, "asn": ship.asn, "warehouse": ship.warehouse,
            "expected_delivery_date": ship.expected_delivery_date, "inspection_count": 0,
            "verdict_counts": {"PASS": 0, "FAIL": 0, "UNCERTAIN": 0, "NOT_ANALYZED": 0}, "last_activity": None,
            "_inspections": [],
        })
        for field in ("supplier", "asn", "warehouse", "expected_delivery_date"):
            group[field] = group[field] or getattr(ship, field)
        group["inspection_count"] += 1
        group["verdict_counts"][svc.verdict_of(inspection) or "NOT_ANALYZED"] += 1
        updated = svc.utc_iso(inspection.updated_at)
        group["last_activity"] = max(group["last_activity"] or "", updated)
        group["_inspections"].append(inspection)
    return sorted(groups.values(), key=lambda g: g["last_activity"] or "", reverse=True)


def _observed_units(inspection) -> int | None:
    manual = inspection.manual_observations
    if manual and manual.observed_units_per_carton is not None:
        return manual.observed_units_per_carton
    for check in (inspection.record or {}).get("checks", []):
        if check["check_key"] == "units_per_carton":
            value = check.get("observed_state")
            sources = (check.get("measurements") or {}).get("sources") or []
            if isinstance(value, int) and not isinstance(value, bool) and "vision" in sources:
                return value
    return None


def cartons(organization_id: str) -> list[dict]:
    out = []
    for inspection in svc.repository.list(organization_id):
        carton_images = [i.image_id for i in inspection.images if i.image_type == "carton"]
        observed = _observed_units(inspection)
        verdict = svc.verdict_of(inspection)
        for carton in inspection.cartons:
            out.append({
                "carton_id": carton.carton_id,
                "inspection_id": inspection.inspection_id,
                "shipment_id": inspection.shipment.shipment_id if inspection.shipment else None,
                "po_id": inspection.po.po_id,
                "sku": inspection.po.sku,
                "expected_units": carton.expected_units,
                "observed_units": observed,
                "seal_condition": carton.seal_condition,
                "visible_condition": carton.visible_condition,
                "carton_type": carton.carton_type,
                "weight_kg": carton.weight_kg,
                "dimensions_cm": carton.dimensions_cm,
                "notes": carton.notes,
                "evidence_image_ids": carton_images,
                "inspection_verdict": verdict,
                "created_at": svc.utc_iso(inspection.created_at),
            })
    return out
