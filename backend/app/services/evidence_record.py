"""Sealed receiving evidence record (shared cross-pod contract receiving_record.v1, ../contract/).

content_hash = SHA-256 over canonical JSON of the record without content_hash/seal.
seal = HMAC-SHA256(content_hash) with RECEIVING_SEAL_KEY, which lives outside the database,
so a record edited in the DB with its hash recomputed no longer verifies.
Override rows: prev_content_hash = content_hash of the superseded record; new_content_hash = canonical hash of
the new record computed before that one field is set (a record cannot contain its own content_hash).
ponytail: damage is reported as carton_damage only; the model does not yet split carton vs unit damage.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
from datetime import datetime, timezone
from uuid import uuid4

from backend.app.core.config import get_settings

SCHEMA_VERSION = "receiving_record.v1"
CHECK_KEYS = {
    "sku_check": "identity", "carton_check": "carton_count", "units_per_carton_check": "units_per_carton",
    "quantity_check": "total_quantity", "variant_check": "variant", "damage_check": "carton_damage",
    "component_check": "components",
}
RULES_ONLY_CODES = {"NOT_REQUIRED", "PO_FIELD_MISSING", "PO_INCONSISTENT"}
EPHEMERAL_MESSAGE = "sealed with an ephemeral key from a previous process; set RECEIVING_SEAL_KEY"
OUTCOME = {
    "PASS": ("ACCEPT", "putaway"),
    "EXCEPTION": ("REJECT", "quarantine"),
    "UNCERTAIN": ("PENDING_REVIEW", "hold_for_review"),
    "PENDING_REVIEW": ("PENDING_REVIEW", "hold_for_review"),
}
_EPHEMERAL_KEY = secrets.token_bytes(32)
_EPHEMERAL_REF = hashlib.sha256(b"ref:" + _EPHEMERAL_KEY).hexdigest()[:16]
_warned_ephemeral = False
log = logging.getLogger(__name__)


def now_rfc3339() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _seal_key() -> tuple[bytes, str]:
    global _warned_ephemeral
    key = get_settings().seal_key
    if key:
        return key.encode(), "env"
    # ponytail: per-process key keeps dev runs working; seals stop verifying after restart. Set RECEIVING_SEAL_KEY.
    if not _warned_ephemeral:
        log.warning("RECEIVING_SEAL_KEY unset; using an ephemeral seal key (seals will not verify after restart)")
        _warned_ephemeral = True
    return _EPHEMERAL_KEY, "ephemeral"


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def compute_hash(record: dict) -> str:
    body = {k: v for k, v in record.items() if k not in ("content_hash", "seal")}
    return hashlib.sha256(canonical(body)).hexdigest()


def _stamp_key(record: dict) -> bytes:
    key, key_id = _seal_key()
    record["seal_key_id"] = key_id
    record["seal_key_ref"] = _EPHEMERAL_REF if key_id == "ephemeral" else None  # tells "old process" from "altered"
    return key


def seal(record: dict) -> dict:
    key = _stamp_key(record)
    record["content_hash"] = compute_hash(record)
    record["seal"] = hmac.new(key, record["content_hash"].encode(), hashlib.sha256).hexdigest()
    return record


def verify_seal(record: dict) -> list[str]:
    problems = []
    expected_hash = compute_hash(record)
    if record.get("content_hash") != expected_hash:
        problems.append("content_hash does not match record body")
    key, key_id = _seal_key()
    good = hmac.new(key, expected_hash.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(str(record.get("seal", "")), good):
        if record.get("seal_key_id") == "ephemeral" and (key_id != "ephemeral" or record.get("seal_key_ref") != _EPHEMERAL_REF):
            problems.append(f"seal not verifiable: {EPHEMERAL_MESSAGE}")
        else:
            problems.append("seal invalid (record altered or signed with a different key)")
    return problems


def _rule_id(check_name: str) -> str:
    return "RCV-" + check_name.removesuffix("_check").upper().replace("_", "-") + "-01"


def _check_key(check_name: str) -> str:
    return CHECK_KEYS.get(check_name, check_name.removesuffix("_check"))


def _hold_reasons(record_checks: list[dict]) -> list[str]:
    return [f"{c['check_key']}:{c['verdict']}" for c in record_checks if c["verdict"] in ("FAIL", "UNCERTAIN")]


def _check_model_version(c: dict, model_version: str) -> str:
    if c.get("reason_code") in RULES_ONLY_CODES or c.get("measurements", {}).get("derived"):
        return "rules"  # decided from the PO or arithmetic, not read by the model
    return model_version


def build_record(*, inspection, verdict: str, checks: list[dict], model_version: str, operator: dict,
                 version: int, previous: dict | None, status: str, failure_reason: str | None = None,
                 evidence: list[dict] | None = None) -> dict:
    decision, disposition = OUTCOME[verdict]
    image_of = {e["evidence_id"]: e["image_id"] for e in evidence or []}
    record_checks = [
        {
            "check_key": _check_key(c["check_name"]),
            "check_name": c["check_name"],
            "verdict": c["status"],
            "observed_state": c.get("observed_value"),
            "expected_state": c.get("expected_value"),
            "reason_code": c.get("reason_code", ""),
            "reason": c["reason"],
            "measurements": c.get("measurements", {}),
            "image_ids": sorted({image_of[e] for e in c.get("evidence_ids", []) if e in image_of}),
            "evidence_ids": c.get("evidence_ids", []),
            "model_version": _check_model_version(c, model_version),
            "rule_ids": [_rule_id(c["check_name"])],
        }
        for c in checks
    ]
    hold_reasons = _hold_reasons(record_checks)
    if failure_reason:
        hold_reasons.append("PERCEPTION_UNAVAILABLE")
    po = inspection.po
    record = {
        "record_id": f"RCV-{uuid4().hex[:12].upper()}",
        "schema_version": SCHEMA_VERSION,
        "organization_id": inspection.organization_id,
        "inspection_id": inspection.inspection_id,
        "version": version,
        "supersedes": {"record_id": previous["record_id"], "content_hash": previous["content_hash"]} if previous else None,
        "subject": {"unit_id": po.unit_id, "sku": po.sku, "asin": po.asin, "po_number": po.po_id, "po_line": po.po_line},
        "images": [
            {"image_id": i.image_id, "view": i.image_type, "sha256_digest": i.sha256_digest} for i in inspection.images
        ],
        "checks": record_checks,
        "outcome": {
            "verdict": verdict,
            "decision": decision,
            "disposition": disposition,
            "prep_hold": decision != "ACCEPT" or bool(hold_reasons),
            "hold_reasons": hold_reasons,
            "failure_reason": failure_reason,
        },
        "overrides": list(previous["overrides"]) if previous else [],
        "status": "pending" if status == "pending_review" else "final",
        "stage": status,
        "analyzed_by": operator["operator_id"],
        "created_at": now_rfc3339(),
    }
    return seal(record)


def build_override_record(previous: dict, *, verdict: str, reason: str, operator: dict) -> tuple[dict, dict]:
    decision, disposition = OUTCOME[verdict]
    override = {
        "override_id": f"OVR-{uuid4().hex[:12].upper()}",
        "check_key": None,  # whole-shipment override; per-check overrides are not offered yet
        "operator_id": operator["operator_id"],
        "role": operator["role"],
        "from_verdict": previous["outcome"]["verdict"],
        "to_verdict": verdict,
        "reason": reason,
        "prev_content_hash": previous["content_hash"],
        "before_hash": previous["content_hash"],
        "created_at": now_rfc3339(),
    }
    record = {k: v for k, v in previous.items() if k not in ("content_hash", "seal", "seal_key_id", "seal_key_ref")}
    record.update(
        record_id=f"RCV-{uuid4().hex[:12].upper()}",
        version=previous["version"] + 1,
        supersedes={"record_id": previous["record_id"], "content_hash": previous["content_hash"]},
        overrides=list(previous["overrides"]) + [override],
        outcome={
            **previous["outcome"],
            "verdict": verdict,
            "decision": decision,
            "disposition": disposition,
            "prep_hold": decision != "ACCEPT",
            "hold_reasons": [] if decision == "ACCEPT" else _hold_reasons(previous["checks"]) + [f"override:{verdict}"],
        },
        status="final",
        stage="overridden",
        created_at=now_rfc3339(),
    )
    _stamp_key(record)
    override["new_content_hash"] = compute_hash(record)  # the override dict is the one inside record["overrides"]
    return seal(record), override
