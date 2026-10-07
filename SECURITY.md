# Security

This file describes what the code does today. Anything not listed here is not implemented.

## Authentication and tenancy

- Every `/api/inspections*` route requires an `X-API-Key` header. `/api/health` is public.
- `RECEIVING_API_KEYS` (JSON) maps each key to `{organization_id, operator_id, role}`. If it is unset, the API answers 503 (fails closed).
- Keys are compared in constant time (`hmac.compare_digest`).
- Every database query is filtered by the caller's `organization_id`. Another tenant's inspection, image, analysis, override or verify call returns 404.
- Operator identity on overrides comes from the credential, never from the request body.
- Only role `approver` may override a verdict to `PASS`; `operator` may override to `EXCEPTION` or `UNCERTAIN`.
- Limit: SQLite with application-level scoping. A multi-tenant deployment should move to Postgres with forced row-level security.

## Evidence integrity

- Each analysis and each override appends a new record version to the `records` table. SQLite triggers abort any `UPDATE` or `DELETE` on `records` and `overrides`.
- `content_hash` is SHA-256 over the canonical JSON of the record (sorted keys, no whitespace), excluding `content_hash` and `seal`.
- `seal` is HMAC-SHA256 of `content_hash` with `RECEIVING_SEAL_KEY`, which is held outside the database. Someone who edits the database file and recomputes the hash cannot produce a valid seal.
- Each record links to the previous version (`supersedes.content_hash`). Each override row stores `before_hash` and `after_hash`.
- `GET /api/inspections/{id}/verify` re-checks every version: hash, seal, version sequence, chain links and override hashes.
- Limit: if `RECEIVING_SEAL_KEY` is unset, a random per-process key is used and a warning is logged; records sealed that way stop verifying after a restart.
- Each uploaded image's SHA-256 is recorded at upload and copied into the record.

## Upload validation

- Extension allowlist, MIME allowlist, magic-byte signature check, and extension/signature agreement.
- At most `MAX_IMAGE_SIZE_MB + 1` bytes are read per file before the size check.
- Empty files and too many images per inspection are rejected.
- Clients cannot supply image records at inspection creation; images enter only through the upload route.
- Stored file names are server-generated, and reads are resolved inside the inspection folder (path traversal check).
- Server file paths are not returned in API responses.
- Not done: EXIF/GPS metadata is kept on stored images; there is no decompression-bomb pixel limit because images are not decoded server-side.

## Model output handling

- The model reads blind: the prompt contains no PO values, so it cannot echo the expected answer.
- The prompt tells the model that text printed on packaging is data, not instructions. This lowers the risk of prompt injection but does not prevent it. The real control is that the model never decides: it returns observations, and Python makes the verdict.
- The response must match a strict JSON schema (`text.format`, `strict: true`) and is validated again with Pydantic.
- An `image_id` the server did not issue makes the whole analysis fail, which results in `PENDING_REVIEW`.
- Any model error, timeout (`AI_TIMEOUT_S`, default 15 s), missing key or malformed output results in `PENDING_REVIEW` with `prep_hold: true`, never a 500 and never a pass.

## Secrets

Secrets come from environment variables (`.env` is gitignored). The frontend reads its API key from `localStorage.receivingApiKey` or `VITE_RECEIVING_API_KEY`. Any value baked into a build is visible to anyone who loads the page, so use the build variable only for local development.

## Not implemented

Rate limiting, key rotation, and a real user login.
