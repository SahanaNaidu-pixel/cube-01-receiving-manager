# Receiving record · contract v1

The baseline record every Receiving Manager emits, so Prep (02) and Recovery (05) can read it without per-pod adapters. Extend it with extra fields if you need to. Don't rename or drop fields.

**Status:** draft baseline published by the organisers' repo. Pods agreeing a change should raise it as an Issue labelled `contract`.

## Shape

```jsonc
{
  "record_id": "RCV-…",                 // unique, never reused
  "schema_version": "receiving_record.v1",
  "organization_id": "org_…",           // tenant; every read is scoped by it
  "created_at": "2026-06-04T17:32:00Z", // RFC 3339, UTC, "Z" suffix (all timestamps)
  "subject": {
    "unit_id": "UNIT-0001",             // chain join key
    "sku": "…", "asin": "…",
    "po_number": "PO-7000", "po_line": 2
  },
  "images": [
    { "image_id": "…", "view": "pallet|carton|unit|label|other", "sha256_digest": "hex" }
  ],
  "checks": [
    {
      "check_key": "identity|carton_count|units_per_carton|total_quantity|carton_damage|unit_damage|colour|variant|components",
      "verdict": "PASS|FAIL|UNCERTAIN|NOT_REQUIRED",
      "observed_state": "…",            // what was SEEN, or null if nothing was seen
      "expected_state": "…",            // from the PO line
      "reason_code": "…",
      "measurements": {},               // raw numbers behind the verdict
      "model_version": "…",             // model id, or "rules" for deterministic checks
      "rule_ids": ["…"],
      "image_ids": ["…"]                // which images support this verdict
    }
  ],
  "outcome": {
    "decision": "ACCEPT|REJECT|PENDING_REVIEW",
    "disposition": "…",                 // e.g. accept, quarantine, return_to_supplier
    "prep_hold": true,
    "hold_reasons": ["carton_damage:UNCERTAIN"]
  },
  "overrides": [                        // append-only, never edited or deleted
    {
      "override_id": "…", "check_key": "…",
      "from_verdict": "…", "to_verdict": "…",
      "reason": "…", "operator_id": "…", // bound to the authenticated credential
      "created_at": "…",
      "prev_content_hash": "hex", "new_content_hash": "hex"
    }
  ],
  "status": "final|pending",            // pending = model failed or timed out; capture still saved
  "content_hash": "hex",                // SHA-256 of canonical JSON (see below)
  "seal": "hex"                         // HMAC-SHA256(content_hash) with a key held outside the database
}
```

## Rules

1. **Not seen is UNCERTAIN.** A value the system did not observe gives `UNCERTAIN` with `observed_state: null`. It is never filled with the expected (PO) value.
2. **Hold signal.** Any check that is `FAIL` or `UNCERTAIN` sets `outcome.prep_hold = true` and lists the check in `hold_reasons`. `ACCEPT` is only possible when every required check is `PASS` or `NOT_REQUIRED`.
3. **Fail open, not fail accept.** A model error or timeout still writes the record, with `status: "pending"` and `decision: "PENDING_REVIEW"`.
4. **Prep reads upstream.** A Prep record carries `upstream: [{ "record_id": "RCV-…", "content_hash": "hex" }]`, and Prep must not pass a unit whose receiving record has `prep_hold = true` unless an override clears it.
5. **Canonical JSON for `content_hash`:** UTF-8, keys sorted, no insignificant whitespace (`json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`), computed over the record without the `content_hash` and `seal` fields.
6. **Overrides are data.** An override appends a row, recomputes `content_hash` and `seal`, and records both hashes. The original verdict stays in `checks`.

A content hash on its own is not tamper-evident: anyone who can edit the row can recompute it. Only claim tamper evidence if the seal key is kept outside the database and `/verify` checks the seal.
