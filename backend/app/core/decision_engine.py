"""Deterministic business rules for receiving inspections.

Rule 1: a value the system did not see gives UNCERTAIN, never the expected value.
Rule 2: a reading that only *might* differ (OCR look-alikes, a barcode where a SKU was expected, partial wording,
        an uncorroborated count, hedged damage) gives UNCERTAIN, not FAIL. FAIL needs a clear contradiction.
Rule 3: wording the rules do not fully understand never PASSes. Tolerance only ever moves a reading towards
        UNCERTAIN; PASS needs an exact match of the meaningful words.
"""

from __future__ import annotations

import re
from typing import Literal

Decision = Literal["PASS", "EXCEPTION", "UNCERTAIN"]

UNSEEN_MARKERS = {"", "unknown", "n/a", "uncertain", "not_available", "not_visible", "null", "none_visible"}
NOT_SPECIFIED_MARKERS = {"n/a", "na", "none", "-"}  # PO deliberately names no variant
_SKU_SEPARATORS = re.compile(r"[\s\-_./:#]+")
# Label text a model may copy in front of the code ("SKU: X", "Item # X", "P/N X"). Only stripped from READINGS,
# never from the PO, and only when a ':' / '#' / space separates it from the code, so "REF-100" stays "REF-100".
_SKU_LABEL = re.compile(
    r"^\s*(?:sku|item|part|p\s*/\s*n|product\s+code|model|article|art|ref)"
    r"(?:\s*(?:no\.?|number|code|#))?(?:\s*[:#]\s*|\s+)(?=\S)", re.I)
# Characters OCR commonly confuses. A mismatch made only of these is not proof of a different SKU.
_CONFUSABLE = str.maketrans({"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "S": "5", "B": "8", "Z": "2", "G": "6"})
_WORD = re.compile(r"[a-z0-9]+")
_SYNONYM = {"gray": "grey", "colour": "color", "transparent": "clear"}

NEGATIONS = {"no", "not", "without", "zero", "nothing", "none", "never", "non"}
ABSENCE_WORDS = {"missing", "absent", "none", "no", "without", "empty", "lacking", "lacks", "gone", "removed", "nil"}
UNSEEN_WORDS = {"visible", "unclear", "obscured", "hidden", "unreadable", "illegible", "cannot", "can't", "unable"}
HEDGE_WORDS = {"possibly", "possible", "maybe", "might", "perhaps", "likely", "probably", "appears", "seems", "suspected", "potential"}
_CLAUSE_SPLIT = re.compile(r"[,;.!?()\[\]]+|\b(?:but|except|however|although|though|yet|apart from|other than|aside from)\b", re.I)

# Damage is mapped onto a closed vocabulary. Unknown wording is UNCERTAIN, never silently PASS or FAIL.
DAMAGE_WORDS = {
    "crush", "crushed", "crushing", "dent", "dented", "dents", "tear", "torn", "tears", "rip", "ripped", "puncture",
    "punctured", "punctures", "hole", "holes", "wet", "water", "damp", "moisture", "stain", "stained", "stains", "leak",
    "leaking", "broken", "break", "crack", "cracked", "open", "opened", "burst", "collapsed", "collapse", "deformed",
    "deformation", "smashed", "mold", "mould", "shattered", "spill", "spilled", "damaged", "damage", "split", "crumpled",
}
# Things whose ABSENCE is a problem: "not sealed", "no tape", "not intact" are damage, not "no damage".
INTEGRITY_WORDS = {"sealed", "seal", "seals", "tape", "taped", "intact", "closed", "wrapped", "wrap", "shrinkwrap"}
MINOR_WORDS = {"scuff", "scuffed", "scuffs", "scratch", "scratched", "scratches", "mark", "marks", "dirty", "dust", "dusty"}
# A negated clause is "no damage" only if every word in it is from this list ("no visible signs of damage").
NO_DAMAGE_FILLER = NEGATIONS | DAMAGE_WORDS | MINOR_WORDS | {
    "visible", "visibly", "apparent", "obvious", "evident", "any", "signs", "sign", "of", "to", "the", "on", "in",
    "packaging", "package", "box", "boxes", "carton", "cartons", "pallet", "unit", "units", "or", "and", "other",
    "issues", "issue", "defects", "defect", "problems", "observed", "seen", "detected", "found", "noted", "at", "all",
}
NO_DAMAGE_PHRASES = {
    "none", "no_damage", "no damage", "undamaged", "intact", "good condition", "good", "ok", "clean", "fine",
    "all intact", "looks intact", "appears intact", "in good condition",
}
UNSEEN_PHRASES = {
    "uncertain", "unknown", "not visible", "not_visible", "cannot see", "can't see", "cannot tell", "can't tell",
    "unclear", "obscured", "not assessable", "n/a", "not applicable", "not shown", "not clear",
}
COLOR_WORDS = {
    "red", "blue", "green", "yellow", "black", "white", "grey", "silver", "gold", "pink", "purple", "orange",
    "brown", "navy", "teal", "beige", "clear", "light", "dark", "pale", "bright", "matte", "gloss",
    "glossy", "violet", "cyan", "magenta", "cream", "ivory", "olive", "maroon", "turquoise", "rose", "charcoal",
}
_MEASURE = re.compile(r"^\d+(?:ml|l|cl|oz|floz|g|kg|lb|lbs|cm|mm|m|in|inch|pcs|pc|pack|ct)?$|^(?:ml|l|cl|oz|g|kg|lb|lbs|cm|mm|in|inch)$")


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


def _tokens(text) -> list[str]:
    return [_SYNONYM.get(t, t) for t in _WORD.findall(str(text or "").lower())]


def _singular(word: str) -> str:
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and word.endswith(("ches", "shes", "xes", "sses")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _clauses(text: str) -> list[str]:
    return [c.strip() for c in _CLAUSE_SPLIT.split(str(text or "")) if c and c.strip()]


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


# --- SKU -----------------------------------------------------------------------------------------


def _sku_compact(value):
    """Uppercase and drop separators. No label stripping, no O/0 substitution."""
    cleaned = _normalize(value)
    if not isinstance(cleaned, str):
        return cleaned
    return _SKU_SEPARATORS.sub("", cleaned).upper() or None


def strip_sku_label(value):
    """Remove label text a model copied in front of the code ("SKU: X", "Item # X"), repeatedly."""
    if not isinstance(value, str):
        return value
    text = value
    for _ in range(3):
        stripped = _SKU_LABEL.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped
    return text


def normalize_sku(value):
    """Canonical form of a SKU READING (label stripped, compacted). Use sku_matches() to compare with the PO."""
    return _sku_compact(strip_sku_label(value) if isinstance(value, str) else value)


def sku_matches(expected_sku, observed_sku) -> bool:
    expected = _sku_compact(expected_sku)
    return expected is not None and expected in {_sku_compact(observed_sku), normalize_sku(observed_sku)}


def evaluate_sku_check(expected_sku, observed_sku):
    expected = _sku_compact(expected_sku)
    observed = normalize_sku(observed_sku)

    if expected is None:
        return _result("UNCERTAIN", "Expected SKU information is missing.", "PO_FIELD_MISSING")
    if observed is None:
        return _result("UNCERTAIN", "SKU was not read from any photo.", "NOT_OBSERVED")
    if sku_matches(expected_sku, observed_sku):
        return _result("PASS", "Observed SKU matches the expected SKU.", "MATCH")
    candidates = {observed, _sku_compact(observed_sku)} - {None}
    if any(c.translate(_CONFUSABLE) == expected.translate(_CONFUSABLE) for c in candidates):
        return _result("UNCERTAIN", f"Read {observed_sku!s}; it differs from {expected_sku} only in characters OCR often "
                                    "confuses (O/0, I/1, S/5, B/8). Confirm on the label.", "OCR_AMBIGUOUS")
    if observed.isdigit() and len(observed) >= 8 and not expected.isdigit():
        return _result("UNCERTAIN", f"Read a barcode number ({observed_sku}), not the SKU text; it cannot be compared "
                                    "to the PO SKU.", "IDENTIFIER_TYPE")
    return _result("FAIL", f"SKU mismatch: expected {expected_sku}, observed {observed_sku}.", "SKU_MISMATCH")


# --- Counts --------------------------------------------------------------------------------------


def as_count(value):
    """A count reading as int, or None. Accepts ints, integral floats and plain digit strings ("24", "24 units")."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        return int(value) if value.is_integer() and value >= 0 else None
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d{1,6})\s*(?:units?|pcs|pieces|cartons?|boxes|cases?|x)?\s*", value, re.I)
        return int(match.group(1)) if match else None
    return None


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
    """Total units. Uses a direct count, or cartons x units/carton when both were counted. Never the PO value.

    A direct count that disagrees with the PO but is not corroborated by cartons x units/carton is UNCERTAIN:
    on closed cartons a model tends to count only the units it can see, which is not a short shipment.
    """
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
    if observed_total is not None and derived is None and int(observed_total) != int(po.expected_quantity):
        return _result(
            "UNCERTAIN",
            f"A photo shows {observed_total} units against {po.expected_quantity} expected, but the carton count and "
            "units per carton were not both read to confirm it.",
            "UNCORROBORATED_COUNT",
        )
    total = observed_total if observed_total is not None else derived
    return evaluate_count_check("quantity", po.expected_quantity, total)


# --- Damage --------------------------------------------------------------------------------------


def _classify_damage_clause(clause: str) -> str:
    text = re.sub(r"[_\s]+", " ", clause.strip().lower()).strip(" .!-:")
    if not text:
        return "empty"
    if text in UNSEEN_MARKERS or text in UNSEEN_PHRASES:
        return "unseen"
    if text in NO_DAMAGE_PHRASES:
        return "none"
    words = _tokens(text)
    wordset = set(words)
    negated = bool(wordset & NEGATIONS)
    if negated and wordset & INTEGRITY_WORDS:
        return "damage"  # "not sealed", "no tape", "not intact": the packaging is open or compromised
    if wordset & HEDGE_WORDS and wordset & (DAMAGE_WORDS | MINOR_WORDS):
        return "possible"  # "possibly crushed": a person decides
    if negated:
        if wordset <= NO_DAMAGE_FILLER and wordset & {"visible", "visibly", "clear"} and not wordset & (DAMAGE_WORDS | MINOR_WORDS | {"issues", "defects", "problems", "signs"}):
            return "unseen"  # "not visible", "not clearly visible"
        if wordset <= NO_DAMAGE_FILLER:
            return "none"  # "no visible damage", "not damaged", "no signs of crushing or tears"
        return "unknown"  # a negation plus words the rules do not know: never a silent PASS
    if wordset & DAMAGE_WORDS:
        return "damage"
    if wordset & MINOR_WORDS:
        return "minor"
    if wordset & UNSEEN_WORDS or {"cannot", "see"} <= wordset:
        return "unseen"
    if wordset & INTEGRITY_WORDS and not wordset - (INTEGRITY_WORDS | {"all", "looks", "appears", "fully", "properly", "and", "box", "boxes", "carton", "cartons"}):
        return "none"  # "sealed and intact"
    return "unknown"


_DAMAGE_RANK = ["damage", "possible", "minor", "unknown", "unseen", "none"]


def classify_damage(token) -> str:
    """One damage reading -> 'none' | 'unseen' | 'damage' | 'possible' | 'minor' | 'unknown'.

    Each clause is classified on its own ("no damage, one corner crushed" -> damage) and the most serious wins.
    """
    kinds = [k for k in (_classify_damage_clause(c) for c in _clauses(token)) if k != "empty"]
    if not kinds:
        return "unseen"
    return min(kinds, key=_DAMAGE_RANK.index)


def normalize_damage(observation) -> list[str] | None:
    """Damage readings arrive as str, list or None. Return tokens, or None when nothing was read."""
    if observation is None or isinstance(observation, (bool, int, float)):
        return None  # a number is not a damage assessment
    items = observation if isinstance(observation, list) else [observation]
    tokens = [str(item).strip().lower() for item in items if item is not None and str(item).strip()]
    if isinstance(observation, list) and not tokens:
        return ["none"]  # an empty list of damage types = nothing damaged was seen
    return tokens or None


def evaluate_damage_check(observed_damage):
    """observed_damage: None (no reliable reading at all) or list/str of tokens from every reliable view."""
    if observed_damage == []:
        return _result("PASS", "No visible damage was detected.", "NO_DAMAGE")
    tokens = normalize_damage(observed_damage)
    if tokens is None:
        return _result("UNCERTAIN", "Damage was not assessed in any photo.", "NOT_OBSERVED")
    kinds = {t: classify_damage(t) for t in tokens}
    damage = sorted({t for t, k in kinds.items() if k == "damage"})
    if damage:
        return _result("FAIL", f"Visible damage detected: {', '.join(damage)}.", "DAMAGE_VISIBLE")
    possible = sorted({t for t, k in kinds.items() if k == "possible"})
    if possible:
        return _result("UNCERTAIN", f"Possible damage reported ({', '.join(possible)}); a person must look.", "POSSIBLE_DAMAGE")
    minor = sorted({t for t, k in kinds.items() if k == "minor"})
    if minor:
        return _result("UNCERTAIN", f"Cosmetic marks seen ({', '.join(minor)}); a person decides if they matter.", "MINOR_MARKS")
    unknown = sorted({t for t, k in kinds.items() if k == "unknown"})
    if unknown:
        return _result("UNCERTAIN", f"Unrecognised condition reading: {', '.join(unknown)}.", "UNRECOGNIZED_READING")
    if any(k == "unseen" for k in kinds.values()):
        return _result("UNCERTAIN", "Damage could not be assessed reliably in at least one photo.", "LOW_VISIBILITY")
    return _result("PASS", "No visible damage was detected.", "NO_DAMAGE")


# --- Components ----------------------------------------------------------------------------------

COMPONENT_FILLER = {"a", "an", "the", "of", "with", "and", "on", "in", "from", "for", "to", "is", "are", "be", "slot",
                    "present", "visible", "seen", "included", "attached", "in place", "place", "it", "its"}
DEFECT_WORDS = {"broken", "damaged", "torn", "cracked", "loose", "open", "opened", "split", "bent", "defective", "ripped"}


def split_component_reading(value) -> tuple[str, str] | None:
    """One component reading -> (name, state) with state 'present' | 'missing' | 'defect' | 'unseen', or None.

    Any negation or absence word means the part is NOT counted as present: 'cap missing.', 'Cap - missing!',
    'cap (missing)', 'cap: none', 'empty cap slot', 'no cap' -> missing; 'cap not visible' -> unseen;
    'broken seal' -> defect. Only a plain name ('caps', 'bottle cap') is present.
    """
    text = str(value or "").strip()
    if not text or text.lower() in UNSEEN_MARKERS:
        return None
    words = _tokens(text)
    wordset = set(words)
    if text.lower().startswith("missing:"):
        state = "missing"
    elif wordset & UNSEEN_WORDS or ("not" in wordset and wordset & {"seen", "shown", "clear", "visible"}):
        state = "unseen"
    elif wordset & ABSENCE_WORDS or wordset & NEGATIONS:
        state = "missing"
    elif wordset & DEFECT_WORDS:
        state = "defect"
    else:
        state = "present"
    name = " ".join(w for w in words if w not in ABSENCE_WORDS | NEGATIONS | UNSEEN_WORDS | DEFECT_WORDS | {"missing"})
    return (name, state) if name else None


def _component_key(text) -> frozenset[str]:
    return frozenset(_singular(t) for t in _tokens(text) if t not in COMPONENT_FILLER)


def _component_matches(expected: str, observed: set[str]) -> bool:
    """'cap' matches 'caps', 'Cap', 'bottle cap'. Every word of the expected name must appear in the reading."""
    want = _component_key(expected)
    return bool(want) and any(want <= _component_key(item) for item in observed)


def evaluate_component_check(expected_components, observed_components, confirmed_missing=None, defective=None):
    """observed_components: seen present in any view. confirmed_missing: explicitly reported absent.
    defective: reported present but broken/damaged.

    An expected component that was neither seen nor confirmed missing is UNCERTAIN, not FAIL.
    """
    expected = [str(item).strip() for item in (expected_components or []) if str(item).strip()]
    present = {str(item).strip() for item in (observed_components or []) if str(item).strip()}
    missing = {str(item).strip() for item in (confirmed_missing or []) if str(item).strip()}
    broken = {str(item).strip() for item in (defective or []) if str(item).strip()}

    if not expected:
        return _result("NOT_REQUIRED", "The PO lists no components.", "NOT_REQUIRED")

    seen = {item: _component_matches(item, present) for item in expected}
    gone = {item: _component_matches(item, missing) for item in expected}
    bad = {item: _component_matches(item, broken) for item in expected}
    confirmed = [item for item in expected if gone[item] and not seen[item]]
    if confirmed:
        return _result("FAIL", f"Missing expected components: {', '.join(confirmed)}.", "COMPONENT_MISSING")
    conflicting = [item for item in expected if gone[item] and seen[item]]
    if conflicting:
        return _result("UNCERTAIN", f"Photos disagree on whether these are present: {', '.join(conflicting)}.", "VIEWS_DISAGREE")
    defects = [item for item in expected if bad[item]]
    if defects:
        return _result("UNCERTAIN", f"Reported as damaged or defective: {', '.join(defects)}. A person must look.", "COMPONENT_DEFECT")
    unseen = [item for item in expected if not seen[item]]
    if unseen:
        return _result("UNCERTAIN", f"Components not seen in any photo: {', '.join(unseen)}.", "NOT_OBSERVED")
    return _result("PASS", "All expected components are present.", "MATCH")


# --- Variant -------------------------------------------------------------------------------------


def _variant_words(observed_variant, expected_variant=None, product_name: str | None = None) -> set[str]:
    want = set(_tokens(expected_variant))
    product_words = set(_tokens(product_name)) - want
    got = set(_tokens(observed_variant)) - product_words
    # When the PO variant names no size/volume, a size printed next to the colour ("Blue / 500 ml") is not a
    # different variant. When the PO does name one, every size word counts.
    if want and not any(_MEASURE.match(w) for w in want):
        got = {w for w in got if not _MEASURE.match(w)}
    return got


def variant_key(observed_variant, expected_variant=None, product_name: str | None = None):
    """Canonical form of a variant reading for voting across photos: "Blue", "blue bottle" and "BLUE." vote together."""
    observed = _normalize(observed_variant)
    if not isinstance(observed, str):
        return None
    return " ".join(sorted(_variant_words(observed, expected_variant, product_name))) or None


def evaluate_variant_check(expected_variant, observed_variant, product_name: str | None = None):
    """Word-level comparison. PASS only when the meaningful words are exactly the PO variant's words
    (product-name words, and sizes the PO does not specify, are ignored). Any extra or missing word, or a
    negation, is UNCERTAIN ("Sky Blue", "X-Large", "Mint Chocolate"); no shared word at all is FAIL.
    """
    if isinstance(expected_variant, str) and expected_variant.strip().lower() in NOT_SPECIFIED_MARKERS:
        return _result("NOT_REQUIRED", "The PO does not specify a variant.", "NOT_REQUIRED")
    expected = _normalize(expected_variant)
    observed = _normalize(observed_variant)

    if expected is None:
        return _result("UNCERTAIN", "Expected variant information is missing.", "PO_FIELD_MISSING")
    if observed is None:
        return _result("UNCERTAIN", "Variant was not identified in any photo.", "NOT_OBSERVED")
    want = set(_tokens(expected))
    got = _variant_words(observed, expected, product_name)
    if not want or not got:
        return _result("UNCERTAIN", f"Variant reading '{observed_variant}' could not be compared.", "UNRECOGNIZED_READING")
    if got & NEGATIONS:
        return _result("UNCERTAIN", f"Variant reading '{observed_variant}' is negated or unclear.", "UNRECOGNIZED_READING")
    if got == want:
        return _result("PASS", "Observed variant matches the expected variant.", "MATCH")
    if want & got:
        extra = sorted(got - want)
        detail = f"adds {', '.join(extra)}" if extra else "only partly matches"
        return _result("UNCERTAIN", f"Observed '{observed_variant}' {detail} compared with '{expected_variant}'; "
                                    "confirm it is the same variant.", "PARTIAL_MATCH")
    return _result("FAIL", f"Variant mismatch: expected {expected_variant}, observed {observed_variant}.", "VARIANT_MISMATCH")
