# Receiving Manager Architecture

## Overview

A FastAPI modular monolith. It takes receiving photos, gets structured observations from one vision-model call, combines them across all photos, and lets deterministic Python rules decide. The result is stored as a sealed, append-only evidence record.

## Flow

```text
Frontend (X-API-Key)
  -> FastAPI auth (key -> organization, operator, role)
  -> upload: validate, store, SHA-256 per image
  -> analyze: VisionService
       live: OpenAI Responses API, strict JSON schema, blind read, 15 s timeout
       demo: scripted readings attached to the real uploaded image ids
     -> validate image ids and schema
     -> fuse each check across all photos
     -> decision_engine (PASS / FAIL / UNCERTAIN / NOT_REQUIRED per check)
     -> any failure -> PENDING_REVIEW (fail-open to a human, never to PASS)
  -> sealed record version appended (receiving.v1)
  -> override: append-only, new sealed version
  -> verify: re-check hashes, seals and chain
```

## Components

- `backend/app/api/inspections.py`: routes, auth dependency, fail-open handling, overrides, `/verify`.
- `backend/app/services/vision.py`: model call, demo readings, multi-photo fusion, check construction.
- `backend/app/core/decision_engine.py`: per-check rules and the overall verdict.
- `backend/app/services/evidence_record.py`: contract record builder, canonical hash, HMAC seal, seal check.
- `backend/app/database/repository.py`: SQLite. Tables are `inspections` (mutable working state), `records` (append-only versions) and `overrides` (append-only). Every query is scoped by `organization_id`, and appends use `BEGIN IMMEDIATE`.
- `backend/app/services/storage.py`: inspection-scoped file storage.

## Multi-photo fusion

- A value read reliably (confidence of at least 0.6) in any photo counts. Photos that do not show it do not contradict it.
- If two photos read different values, the check is `UNCERTAIN` (`VIEWS_DISAGREE`).
- Damage: one photo showing damage is enough to `FAIL`. Low-confidence or "uncertain" readings make it `UNCERTAIN`. If no photo assessed damage, it is `UNCERTAIN`.
- Components: a component seen in any photo is present. It is `FAIL` only when a photo shows it is missing; if it was not seen, the check is `UNCERTAIN`.

## Evidence record (`schema_version: receiving.v1`)

`record_id`, `organization_id`, `inspection_id`, `version`, `supersedes{record_id, content_hash}`,
`subject{unit_id, sku, asin, po_number, po_line}`, `images[{image_id, view, sha256_digest}]`,
`checks[{check_key, verdict, observed_state, expected_state, reason_code, reason, measurements, evidence_ids, model_version, rule_ids}]`,
`outcome{verdict, decision ACCEPT|REJECT|PENDING_REVIEW, disposition, prep_hold, hold_reasons, failure_reason}`,
`overrides[]`, `status`, `analyzed_by`, `created_at` (RFC 3339 UTC), `seal_key_id`, `content_hash`, `seal`.

`prep_hold` is true whenever any check is FAIL or UNCERTAIN, or the decision is not ACCEPT. The Prep pod should refuse to pass a held unit.

## Known limits

- SQLite with app-level tenancy (Postgres with forced RLS is the next step for real multi-tenant use).
- The live model call is tested with a mocked client only; no real-photo accuracy has been measured.
- One global confidence threshold (0.6), not calibrated per check.
