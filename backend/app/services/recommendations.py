"""Short, deterministic retake instructions for the operator after an analysis."""

from __future__ import annotations

from backend.app.services.image_quality import describe

MAX_RECOMMENDATIONS = 6
PALLET = "Take a Pallet Overview photo showing every carton"
LABEL = "Photograph the shipping label straight-on, filling the frame"
# (key, instruction) per UNCERTAIN check; the key de-duplicates instructions that ask for the same photo.
CHECK_ADVICE = {
    "carton_check": ("pallet", PALLET),
    "quantity_check": ("pallet", PALLET),
    "units_per_carton_check": ("units_label", "Photograph the carton label that prints units per carton"),
    "sku_check": ("label", LABEL),
    "variant_check": ("unit", "Open one unit and photograph it in good light"),
    "component_check": ("components", "Lay out the kit components and photograph them"),
    "damage_check": ("faces", "Photograph each carton face"),
}
PO_CODES = {"PO_FIELD_MISSING", "PO_INCONSISTENT"}


def build_recommendations(*, decision: str, checks: list[dict], images: list, failure_reason: str | None = None) -> list[str]:
    items: dict[str, str] = {}

    def add(key: str, text: str):
        items.setdefault(key, text)

    if failure_reason:
        add("retry", "Perception was unavailable: retry the analysis, or inspect the shipment by hand")
    for image in images:  # a bad photo is usually the root cause, so retakes come first
        issues = (getattr(image, "quality", None) or {}).get("issues") or []
        if issues:
            add(f"retake:{image.image_id}", f"Retake {image.filename}: {describe(issues)}")
    if decision in ("UNCERTAIN", "PENDING_REVIEW"):
        views = {getattr(i, "image_type", "") for i in images}
        if "pallet" not in views:
            add("pallet", f"No pallet photo uploaded: {PALLET[0].lower()}{PALLET[1:]}")
        if "label" not in views:
            add("label", f"No label photo uploaded: {LABEL[0].lower()}{LABEL[1:]}")
    if not failure_reason:
        for check in checks:
            if check.get("status") != "UNCERTAIN":
                continue
            if check.get("reason_code") in PO_CODES:
                add("po", "Check the PO: a field is missing or cartons x units per carton does not equal the quantity")
            elif check.get("check_name") in CHECK_ADVICE:
                add(*CHECK_ADVICE[check["check_name"]])
    return list(items.values())[:MAX_RECOMMENDATIONS]
