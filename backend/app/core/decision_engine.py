"""Deterministic business rules for receiving inspections.

Rule for every check: a value the system did not see gives UNCERTAIN, never the expected value.
"""

from __future__ import annotations

from typing import Literal

Decision = Literal["PASS", "EXCEPTION", "UNCERTAIN"]

UNSEEN_MARKERS = {"", "unknown", "n/a", "uncertain", "not_available", "not_visible"}
NO_DAMAGE_MARKERS = {"none", "no_damage", "no damage"}


def _normalize(value):
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip().lower()
        if cleaned in UNSEEN_MARKERS:
            return None
        return cleaned
    return value


def _result(status: str, reason: str, reason_code: str) -> dict:
    return {"status": status, "reason": reason, "reason_code": reason_code}


def evaluate_overall(checks: list[dict]) -> Decision:
    """FAIL anywhere -> EXCEPTION; else UNCERTAIN anywhere -> UNCERTAIN; else PASS. NOT_REQUIRED is ignored."""
    statuses = [str(check.get("status", "UNCERTAIN")).upper() for check in checks]
    required = [s for s in statuses if s != "NOT_REQUIRED"]
    if not required:
        return "UNCERTAIN"
    if "FAIL" in required:
        return "EXCEPTION"
    if any(s != "PASS" for s in required):
        return "UNCERTAIN"
    return "PASS"


evaluate_inspection = evaluate_overall


def evaluate_sku_check(expected_sku, observed_sku):
    expected = _normalize(expected_sku)
    observed = _normalize(observed_sku)

    if expected is None:
        return _result("UNCERTAIN", "Expected SKU information is missing.", "PO_FIELD_MISSING")
    if observed is None:
        return _result("UNCERTAIN", "SKU was not read from any photo.", "NOT_OBSERVED")
    if observed == expected:
        return _result("PASS", "Observed SKU matches the expected SKU.", "MATCH")
    return _result("FAIL", f"SKU mismatch: expected {expected_sku}, observed {observed_sku}.", "SKU_MISMATCH")


def evaluate_count_check(label: str, expected, observed):
    """Exact integer comparison for cartons, units per carton or total units."""
    if expected is None:
        return _result("UNCERTAIN", f"Expected {label} is missing.", "PO_FIELD_MISSING")
    if observed is None or isinstance(observed, bool):
        return _result("UNCERTAIN", f"{label.capitalize()} was not counted in any photo.", "NOT_OBSERVED")
    if int(observed) < 0:
        return _result("UNCERTAIN", f"Observed {label} is invalid.", "INVALID_READING")
    if int(observed) == int(expected):
        return _result("PASS", f"Observed {label} matches the PO.", "MATCH")
    return _result("FAIL", f"{label.capitalize()} mismatch: expected {expected}, observed {observed}.", "COUNT_MISMATCH")


def evaluate_quantity_check(expected_quantity, observed_quantity):
    return evaluate_count_check("quantity", expected_quantity, observed_quantity)


def evaluate_carton_check(expected_cartons, observed_cartons):
    return evaluate_count_check("carton count", expected_cartons, observed_cartons)


def evaluate_units_per_carton_check(expected_units_per_carton, observed_units_per_carton):
    return evaluate_count_check("units per carton", expected_units_per_carton, observed_units_per_carton)


def evaluate_total_quantity_check(po, observed_total, observed_cartons, observed_units_per_carton):
    """Total units. Uses a direct count, or cartons x units/carton when both were counted. Never the PO value."""
    if po.expected_cartons * po.units_per_carton != po.expected_quantity:
        return _result(
            "UNCERTAIN",
            f"PO is internally inconsistent: {po.expected_cartons} cartons x {po.units_per_carton} != {po.expected_quantity}.",
            "PO_INCONSISTENT",
        )
    derived = None
    if observed_cartons is not None and observed_units_per_carton is not None:
        derived = int(observed_cartons) * int(observed_units_per_carton)
    if observed_total is not None and derived is not None and int(observed_total) != derived:
        return _result(
            "UNCERTAIN",
            f"Direct count {observed_total} disagrees with cartons x units/carton = {derived}.",
            "READINGS_DISAGREE",
        )
    total = observed_total if observed_total is not None else derived
    return evaluate_count_check("quantity", po.expected_quantity, total)


def normalize_damage(observation) -> list[str] | None:
    """Damage readings arrive as str, list or None. Return tokens, or None when nothing was read."""
    if observation is None:
        return None
    items = observation if isinstance(observation, list) else [observation]
    tokens = [str(item).strip().lower() for item in items if item is not None and str(item).strip()]
    return tokens or None


def evaluate_damage_check(observed_damage):
    """observed_damage: None (no reading at all) or list/str of tokens from every view."""
    if observed_damage == []:
        return _result("PASS", "No visible damage was detected.", "NO_DAMAGE")
    tokens = normalize_damage(observed_damage)
    if tokens is None:
        return _result("UNCERTAIN", "Damage was not assessed in any photo.", "NOT_OBSERVED")
    damage = [t for t in tokens if t and t not in UNSEEN_MARKERS and t not in NO_DAMAGE_MARKERS]
    if damage:
        return _result("FAIL", f"Visible damage detected: {', '.join(sorted(set(damage)))}.", "DAMAGE_VISIBLE")
    if any(t in UNSEEN_MARKERS for t in tokens):
        return _result("UNCERTAIN", "Damage could not be assessed reliably in at least one photo.", "LOW_VISIBILITY")
    return _result("PASS", "No visible damage was detected.", "NO_DAMAGE")


def evaluate_component_check(expected_components, observed_components, confirmed_missing=None):
    """observed_components: seen present in any view. confirmed_missing: explicitly reported absent.

    An expected component that was neither seen nor confirmed missing is UNCERTAIN, not FAIL.
    """
    expected = [str(item).strip() for item in (expected_components or []) if str(item).strip()]
    present = {str(item).strip().lower() for item in (observed_components or []) if str(item).strip()}
    missing = {str(item).strip().lower() for item in (confirmed_missing or []) if str(item).strip()}

    if not expected:
        return _result("NOT_REQUIRED", "The PO lists no components.", "NOT_REQUIRED")

    confirmed = [item for item in expected if item.lower() in missing and item.lower() not in present]
    if confirmed:
        return _result("FAIL", f"Missing expected components: {', '.join(confirmed)}.", "COMPONENT_MISSING")
    unseen = [item for item in expected if item.lower() not in present]
    if unseen:
        return _result("UNCERTAIN", f"Components not seen in any photo: {', '.join(unseen)}.", "NOT_OBSERVED")
    return _result("PASS", "All expected components are present.", "MATCH")


def evaluate_variant_check(expected_variant, observed_variant):
    expected = _normalize(expected_variant)
    observed = _normalize(observed_variant)

    if expected is None:
        return _result("UNCERTAIN", "Expected variant information is missing.", "PO_FIELD_MISSING")
    if observed is None:
        return _result("UNCERTAIN", "Variant was not identified in any photo.", "NOT_OBSERVED")
    if observed == expected:
        return _result("PASS", "Observed variant matches the expected variant.", "MATCH")
    return _result("FAIL", f"Variant mismatch: expected {expected_variant}, observed {observed_variant}.", "VARIANT_MISMATCH")
