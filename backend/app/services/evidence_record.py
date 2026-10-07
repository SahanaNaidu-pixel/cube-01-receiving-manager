"""Sealed receiving evidence record (shared cross-pod contract, schema receiving.v1).

content_hash = SHA-256 over canonical JSON of the record without content_hash/seal.
seal = HMAC-SHA256(content_hash) with RECEIVING_SEAL_KEY, which lives outside the database,
so a record edited in the DB with its hash recomputed no longer verifies.
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

SCHEMA_VERSION = "receiving.v1"
OUTCOME = {
    "PASS": ("ACCEPT", "putaway"),
    "EXCEPTION": ("REJECT", "quarantine"),
    "UNCERTAIN": ("PENDING_REVIEW", "hold_for_review"),
    "PENDING_REVIEW": ("PENDING_REVIEW", "hold_for_review"),
}
_EPHEMERAL_KEY = secrets.token_bytes(32)
log = logging.getLogger(__name__)


def now_rfc3339() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _seal_key() -> tuple[bytes, str]:
    key = get_settings().seal_key
    if key:
        return key.encode(), "env"
    # ponytail: per-process key keeps dev runs working; seals stop verifying after restart. Set RECEIVING_SEAL_KEY.
    log.warning("RECEIVING_SEAL_KEY unset; using an ephemeral seal key")
    return _EPHEMERAL_KEY, "ephemeral"


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def compute_hash(record: dict) -> str:
    body = {k: v for k, v in record.items() if k not in ("content_hash", "seal")}
    return hashlib.sha256(canonical(body)).hexdigest()


def seal(record: dict) -> dict:
    key, key_id = _seal_key()
    record["seal_key_id"] = key_id
    record["content_hash"] = compute_hash(record)
    record["seal"] = hmac.new(key, record["content_hash"].encode(), hashlib.sha256).hexdigest()
    return record


def verify_seal(record: dict) -> list[str]:
    problems = []
    expected_hash = compute_hash(record)
    if record.get("content_hash") != expected_hash:
        problems.append("content_hash does not match record body")
    key, _ = _seal_key()
    good = hmac.new(key, expected_hash.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(str(record.get("seal", "")), good):
        problems.append("seal invalid (record altered or signed with a different key)")
    return problems


def _rule_id(check_name: str) -> str:
    return "RCV-" + check_name.removesuffix("_check").upper().replace("_", "-") + "-01"


def build_record(*, inspection, verdict: str, checks: list[dict], model_version: str, operator: dict,
                 version: int, previous: dict | None, status: str, failure_reason: str | None = None) -> dict:
    decision, disposition = OUTCOME[verdict]
    hold_reasons = [
        f"{c['check_name']}:{c.get('reason_code') or c['status']}"
        for c in checks if c["status"] in ("FAIL", "UNCERTAIN")
    ]
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
        "checks": [
            {
                "check_key": c["check_name"],
                "verdict": c["status"],
                "observed_state": c.get("observed_value"),
                "expected_state": c.get("expected_value"),
                "reason_code": c.get("reason_code", ""),
                "reason": c["reason"],
                "measurements": c.get("measurements", {}),
                "evidence_ids": c.get("evidence_ids", []),
                "model_version": model_version,
                "rule_ids": [_rule_id(c["check_name"])],
            }
            for c in checks
        ],
        "outcome": {
            "verdict": verdict,
            "decision": decision,
            "disposition": disposition,
            "prep_hold": decision != "ACCEPT" or bool(hold_reasons),
            "hold_reasons": hold_reasons,
            "failure_reason": failure_reason,
        },
        "overrides": list(previous["overrides"]) if previous else [],
        "status": status,
        "analyzed_by": operator["operator_id"],
        "created_at": now_rfc3339(),
    }
    return seal(record)


def build_override_record(previous: dict, *, verdict: str, reason: str, operator: dict) -> tuple[dict, dict]:
    decision, disposition = OUTCOME[verdict]
    override = {
        "override_id": f"OVR-{uuid4().hex[:12].upper()}",
        "operator_id": operator["operator_id"],
        "role": operator["role"],
        "from_verdict": previous["outcome"]["verdict"],
        "to_verdict": verdict,
        "reason": reason,
        "before_hash": previous["content_hash"],
        "created_at": now_rfc3339(),
    }
    record = {k: v for k, v in previous.items() if k not in ("content_hash", "seal", "seal_key_id")}
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
            "hold_reasons": [] if decision == "ACCEPT" else ["OPERATOR_OVERRIDE"],
        },
        status="overridden",
        created_at=now_rfc3339(),
    )
    return seal(record), override
