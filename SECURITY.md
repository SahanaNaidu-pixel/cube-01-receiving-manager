# Security

This file describes what the code does today. Anything not listed here is not implemented.

## Authentication and roles

- **Public routes.** Every route needs an `X-API-Key` header except these: `/health`, `/api/health`, `/ready`, `/api/ready` and `/.well-known/agent.json`.
- **Key map.** `RECEIVING_API_KEYS` (JSON) maps each key to `{organization_id, operator_id, role}`. The role is `operator`, `approver` or `agent`; an unknown role becomes `operator`.
- **Fails closed.** If the variable is unset or malformed, authenticated routes answer 503. The parse error goes to the server log; the client only sees "Server API keys are misconfigured."
- **Public example keys.** Keys starting with `change-me` (the ones in `.env.example`) are refused with 503 unless `DEMO_MODE=true`. Readiness reports this as `authentication: UNAVAILABLE`.
- **Key comparison.** Keys are compared with `hmac.compare_digest`. A missing key gives 401 "Missing X-API-Key header."; a wrong key gives 401 "Invalid API key."
- **Identity comes from the credential.** The operator id and role on overrides, review decisions, notes, uploads (`uploaded_by`) and audit events come from the key, never from the request body.
- **Finalising PASS.** Only `approver` may finalise PASS, through an override or a review decision; otherwise 403. `operator` and `agent` may set EXCEPTION / FAIL or UNCERTAIN.

## Organisation scoping

- Every SQL query filters by the caller's `organization_id`. This covers inspections, records, overrides, issues, review tasks, notes, audit events, agent activity, products and purchase orders.
- Another organisation's inspection, image, issue, review, evidence file or activity returns 404.
- The A2A idempotency key is scoped per organisation as well.
- Limit: this is application-level scoping on one SQLite file. A multi-tenant deployment should move to Postgres with forced row-level security.

## Upload validation

The same checks apply to multipart uploads (`services/uploads.py`) and to A2A base64 images:

- **Filename.** The extension must be in `ALLOWED_EXTENSIONS`; a missing extension, `.` or `..` is rejected. The display name is reduced to its basename. Control characters, quotes and `;` are stripped, and the name is limited to 100 characters. The raw client name is never stored or echoed, and download filenames are re-sanitised.
- **Size.** At most `MAX_IMAGE_SIZE_MB + 1` bytes are read per file before the size check (413). Empty files are rejected. For base64, the decoded size is estimated and refused before decoding, and decoding is strict (`validate=True`).
- **Magic bytes.** The content must start with a PNG, JPEG or WebP (`RIFF…WEBP`) signature. The detected type must be in `ALLOWED_IMAGE_TYPES` and must agree with the extension. A declared `Content-Type` must be an allowed type or `application/octet-stream`.
- **Count.** At most `UPLOAD_MAX_IMAGES` per inspection. This is checked before reading and again under the inspection lock. A batch is validated in full before anything is saved, and saved files are deleted if the batch fails.
- **Storage paths.** The stored name is server-generated (`<uuid>_<inspection_id>.<ext>`). Path components are sanitised to `[A-Za-z0-9._-]`. Reads are resolved and must stay inside the inspection folder ("Path traversal detected" otherwise). `image_path` is never returned by the API.
- **No client-supplied image records.** Clients cannot pass image records when creating an inspection (400). Images enter only through the upload route or `receiving.inspect`.
- **SHA-256.** Each image's SHA-256 is computed at upload, stored, and copied into every record.
- Not done: EXIF / GPS metadata is kept on stored images. There is no decompression-bomb pixel limit, because images are never decoded server-side.

## Request size limits

- **Upload middleware.** Runs before body parsing. `POST /api/inspections/{id}/images` with a declared `Content-Length` over `UPLOAD_MAX_IMAGES × MAX_IMAGE_SIZE_MB + 1 MiB` gets 413 `PAYLOAD_TOO_LARGE`. It is registered inside CORS, so the 413 still carries CORS headers.
- **A2A envelope.** `POST /api/agent/receive` refuses envelopes over 64 MiB, by declared length and by actual body size.
- **Catalogue import.** CSV files are limited to 5 MB and 10,000 rows, and must be UTF-8.
- **Field limits.** Pydantic models bound field sizes: text 200 characters, reasons and notes 2000, up to 200 cartons, 50 components, 500 PO lines, and counts up to 1,000,000. Unknown fields are rejected (`extra="forbid"`) on REST bodies.
- Gap: the upload middleware relies on the declared `Content-Length`. A chunked request without one is not pre-rejected; the per-file read cap still applies.

## Errors and logging

- **Error envelope.** Every non-2xx response uses one envelope: `{"detail", "error": {code, message, request_id, details}}`.
- **No stack traces.** Unhandled exceptions are logged and answered as `500 INTERNAL_ERROR` "Internal server error." A2A answers internal failures as a `failed` envelope with only the exception class name.
- **Validation errors.** These echo at most 200 characters of scalar input values.
- **Perception failure reasons.** These are stored in records and returned to clients with URLs replaced by `<url>` and are cut to 300 characters. Outbound hand-off errors are redacted the same way.
- **Request IDs.** `X-Request-ID` and `X-Correlation-ID` from clients are accepted only if they match `^[A-Za-z0-9._:-]{1,128}$`; otherwise a fresh `req-<hex12>` is generated. This keeps header and log injection out.
- **Structured logs.** Logs are JSON, one access line per request. The log line contains the method, path, status, latency and operator id, but not request bodies or keys.

## Evidence integrity

- **Append-only records.** Each run and each override appends a new version to `records`. SQLite triggers abort any `UPDATE` or `DELETE` on `records`, `overrides` and `audit_events`.
- **`content_hash`.** SHA-256 over the canonical JSON of the record: sorted keys, no whitespace, UTF-8, excluding `content_hash` and `seal`.
- **`seal`.** HMAC-SHA256 of `content_hash` with `RECEIVING_SEAL_KEY`, which is held outside the database. Someone who edits the database file and recomputes the hash cannot produce a valid seal without the key.
- **Chain links.** Each version links to the previous one (`supersedes.content_hash`). Override entries carry `prev_content_hash` and `new_content_hash`, and each `overrides` row stores `before_hash` and `after_hash`.
- **Verification.** `GET /api/inspections/{id}/verify` and the A2A `receiving.verify_record` operation re-check every version. They check the hash, seal, the stored hash column, the version sequence, chain links, override hashes, and that each override's before and after records are consecutive in the chain. The result is `integrity_verified` plus a list of problems. The UI's Evidence detail page can also re-hash a downloaded photo in the browser and compare it with the stored digest.
- **Seal key.** If `RECEIVING_SEAL_KEY` is unset, a random per-process key is used and a warning is logged, and readiness reports `seal_key: DEGRADED`. Records sealed that way are marked `seal_key_id: "ephemeral"` and report "sealed with an ephemeral key from a previous process" after a restart, instead of "altered".
- Limits:
  - The triggers stop accidental or application-level edits, not someone with write access to the file. The seal is the real protection for records.
  - Audit events and the mutable document tables (issues, review tasks, activity, catalogue, notes) are not sealed.
  - A key rotation makes older records stop verifying.

## Model output handling

- **Blind reading.** The prompt contains no PO values, so the model cannot echo the expected answer.
- **Prompt injection.** The prompt says that text printed on packaging is data, not instructions. This lowers the risk of prompt injection but does not prevent it. The real control is that the model never decides: it returns readings, and Python makes the verdict.
- **Strict schema.** The response must match a strict JSON schema (`text.format`, `strict: true`) and is validated again with Pydantic. Unknown or duplicate image ids, or the reserved id `operator`, fail the run.
- **Fail open.** Any model error, refusal, incomplete response, timeout (`AI_TIMEOUT_S`, default 45 s, two client retries), missing key or malformed output gives `PENDING_REVIEW` with `prep_hold: true`. It never gives a 500 and never a pass.

## CORS

- **Origins.** Only the comma-separated `CORS_ALLOWED_ORIGINS`.
- **Credentials.** `allow_credentials=False`, because auth is a header, not cookies.
- **Methods.** `GET`, `POST`, `PUT`, `OPTIONS`.
- **Allowed headers.** `X-API-Key`, `Content-Type`, `X-Request-ID`, `X-Correlation-ID`.
- **Exposed headers.** `X-Request-ID`, `X-Correlation-ID`, `Content-Disposition`, `X-Idempotent-Replay`.

## Secrets handling

- **Where secrets live.** Secrets come from environment variables or the repo-root `.env`. `.env` and `.env.*` are gitignored (except `.env.example`) and excluded from the Docker image by `.dockerignore`.
- **What is never revealed.** `/api/system/info`, `/ready` and the agent card never return keys. They report only booleans (`seal_key_configured`), counts, role names and A2A peer names.
- **Frontend key storage.** The frontend keeps the operator key in `localStorage` (`receivingApiKey`), so any script running on the page can read it. `VITE_RECEIVING_API_KEY` is baked into the bundle; use it only for local development.
- **Render.** The blueprint generates `RECEIVING_SEAL_KEY` and prompts for `RECEIVING_API_KEYS` (`sync: false`), so neither is committed.

## A2A peer keys

- **Inbound agents.** Inbound agents authenticate with their own entry in `RECEIVING_API_KEYS`, normally with `"role": "agent"`. That role cannot finalise PASS.
- **Outbound peers.** The `A2A_PEERS` entries may carry an `api_key`, which is sent as `X-API-Key` on the hand-off POST (10 s timeout). Entries without an `http(s)` URL are dropped, and invalid JSON disables outbound hand-off with a log line. Peer keys are never echoed: activity rows store the request envelope, not the headers.
- **Activity log.** Inbound activity rows replace image bytes with a size and digest marker.
- **Idempotency.** Idempotency is keyed on `(organization, sender.agent_id, message_id)`; a replay returns the stored response with `X-Idempotent-Replay: true`.
- **Recipient check.** `recipient.agent_id`, if present, must equal `AGENT_ID`.

## Known gaps

- No rate limiting, no key rotation or expiry, no user login or SSO.
- `sender.agent_id` in an A2A envelope is self-declared and not bound to the API key that sent it. It is used for idempotency and display only.
- The public `/ready` and `/.well-known/agent.json` reveal component health messages, such as whether a seal key or vision provider is configured, but no secret values.
- In-process locks and SQLite: no protection against concurrent writers across processes beyond SQLite's own locking and `BEGIN IMMEDIATE` for record appends.
- EXIF metadata is retained, and stored photos are not encrypted at rest.
- The Vercel deployment defaults to `DEMO_MODE=true` and `/tmp` storage. Set real keys, `DEMO_MODE=false` and persistent storage before using it for anything real.
