# Receiving Manager · REST API

Base URL: `VITE_API_BASE_URL` (dev server default `http://localhost:8000`; production builds without it use the page's
own origin). All `/api/*` routes except the public ones need `X-API-Key`. Everything is scoped to the caller's `organization_id`.

## Conventions

- **Request IDs.** Middleware reads `X-Request-ID` / `X-Correlation-ID` (generates `req-<hex12>` / reuses request id
  when absent), stores them in a contextvar, logs one structured JSON line per request
  (`ts, level, request_id, correlation_id, method, path, status, latency_ms, operator_id`), and echoes both headers.
  CORS must expose them (`expose_headers`).
- **Errors.** Every non-2xx body is
  `{"detail": "<human message>", "error": {"code": "<UPPER_SNAKE>", "message": "<same>", "request_id": "…", "details": {…}}}`.
  `detail` stays a string for every error (422 included: `detail` = first error summarised, `error.details.errors` = the list).
  Codes: `VALIDATION_ERROR` 422/400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409,
  `PAYLOAD_TOO_LARGE` 413, `SERVICE_UNAVAILABLE` 503, `INTERNAL_ERROR` 500 (never a stack trace).
- **Verdicts.** Stored/contract values stay `PASS | EXCEPTION | UNCERTAIN | PENDING_REVIEW`. Every inspection view
  also carries `verdict: "PASS" | "FAIL" | "UNCERTAIN" | null` (null = not analysed) for the UI and A2A.
- **Pagination.** List endpoints accept `page` (1-based, default 1) and `page_size` (default 25, max 200) and return
  `{items, count, total, page, page_size}` (`count` = items on this page, kept for compatibility).
- **Multi-value filters.** Enum filters (`verdict`, `status`, `severity`, `issue_type`) accept comma-separated values.
- **Dates.** Filters `date_from` / `date_to` are `YYYY-MM-DD` (inclusive, UTC) on `created_at`.
- **Roles.** `operator`, `approver`, `agent`. Only `approver` may finalise PASS (override or review decision).
- **Audit.** Every mutation writes an audit event (see below) in the same request.

## Health (public, no key)

| Method | Path | Body |
|---|---|---|
| GET | `/health` and `/api/health` | `{status:"ok", service, version, demo_mode}` — liveness only |
| GET | `/ready` and `/api/ready` | `{status:"HEALTHY|DEGRADED|UNAVAILABLE", checked_at, components:[{name, status, message}]}`; HTTP 200 unless UNAVAILABLE (503). Components: `database` (SELECT 1 + schema), `storage` (upload dir writable), `vision_provider` (configured provider; `none` → DEGRADED "Vision analysis unavailable — manual review required."), `seal_key` (unset → DEGRADED), `authentication` (keys parse), `a2a` (agent card builds; peers configured count). No secrets in messages. |

## System (key)

`GET /api/system/info` → `{agent:{agent_id,name,version}, api_version:"1.0.0", a2a_version:"cube.a2a.v1",
record_schema:"receiving_record.v1", environment:{demo_mode, vision_provider, vision_model, damage_policy,
max_image_size_mb, upload_max_images, allowed_extensions, seal_key_configured, a2a_peers:[names only]},
principal:{organization_id, operator_id, role}, storage:{root_configured, writable}}`.

## Inspections

Inspection view (every route returning an inspection) = existing model dump without `image_path`, plus:
`verdict`, `shipment` (object|null), `cartons` (list), `notes` (list), `open_issue_count`, `review_task` (latest
task summary or null), `manual_observations` (or null).

New optional intake on create (all fields optional strings unless noted, max 200 chars):
- `shipment`: `{shipment_id, supplier, expected_delivery_date (YYYY-MM-DD), warehouse, asn}`
- `cartons`: list (≤200) of `{carton_id (required), expected_units:int≥0, carton_type, weight_kg:float≥0,
  dimensions_cm (e.g. "40x30x30"), seal_condition: intact|broken|resealed|unknown, visible_condition:
  good|crushed|torn|punctured|wet|open|label_damaged|unknown, notes ≤500}`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/inspections` | filters `q` (matches id, po_id, sku, product_name, supplier, shipment_id), `verdict` (PASS/FAIL/UNCERTAIN/NOT_ANALYZED), `status`, `supplier`, `sku`, `po`, `shipment_id`, `date_from`, `date_to`, `has_open_issues` (bool), `sort` (created_at, updated_at, po_id, sku, verdict; default created_at), `order` (asc/desc, default desc), paginated |
| POST | `/api/inspections` | `{po, shipment?, cartons?}` → 201 inspection view (`images` in body still 400) |
| GET | `/api/inspections/{id}` | view + `issues` (all), `review_tasks` (all), `evidence_files` (images) |
| POST | `/api/inspections/{id}/images` | unchanged multipart upload; `image_type` form field |
| POST | `/api/inspections/{id}/run` | canonical run. Body optional `{manual_observations?, scenario?}`; `?scenario=` query still accepted. `/analyze` stays as an alias (same handler). |
| POST | `/api/inspections/{id}/review` | `{reason (1..2000), assigned_to?}` → 201 creates a review task manually |
| POST | `/api/inspections/{id}/override` | unchanged (PASS needs approver) — also resolves an open review task as `overridden` |
| POST | `/api/inspections/{id}/notes` | `{text 1..2000}` → 201 note `{note_id, author, text, created_at}` |
| POST | `/api/inspections/{id}/handoff` | `{target_agent}` → activity entry (see A2A.md) |
| GET | `/api/inspections/{id}/verify` | unchanged |
| GET | `/api/inspections/{id}/export?format=json|csv|html` | json = `{inspection view, records:[all sealed versions], audit:[…]}`; csv = one row per check (inspection_id, po, sku, check_key, verdict, expected, observed, reason_code, reason, confidence, evidence image ids); html = self-contained printable report. `Content-Disposition: attachment`. |
| GET | `/api/inspections/{id}/audit` | audit events for this inspection |

### Manual observations (operator counts — real evidence, not AI)

```jsonc
{ "observed_sku": "…", "observed_quantity": 24, "observed_cartons": 2, "observed_units_per_carton": 12,
  "observed_variant": "Blue", "damage": ["crushing"] | "none", "components_present": ["cap"],
  "components_missing": ["label"], "note": "…" }   // every field optional
```
Fused with vision readings as an extra reading source `operator` (confidence 1.0, evidence id `OPR-0001…`,
`image_id` = `"operator"`). Disagreement between operator and vision → `VIEWS_DISAGREE` (UNCERTAIN). Checks decided
only from operator input carry `model_version: "operator"`. With no vision provider and no manual observations,
every perception check is UNCERTAIN (`PERCEPTION_UNAVAILABLE`) and the verdict is PENDING_REVIEW.

### Engine additions
- `carton_condition_check` (check_key `carton_condition`, contract extension): from intake `cartons`: any
  `seal_condition` broken/resealed or `visible_condition` not good/unknown → FAIL (`CARTON_CONDITION_REPORTED`) or
  UNCERTAIN under `DAMAGE_POLICY=review`; all intact+good → PASS; all unknown → UNCERTAIN (`NOT_OBSERVED`);
  no cartons → NOT_REQUIRED. model_version `operator`.
- `DAMAGE_POLICY` env `fail` (default) | `review`: under `review`, visible damage gives UNCERTAIN
  (`DAMAGE_REVIEW_REQUIRED`) instead of FAIL.

## Vision providers (`backend/app/services/vision_providers.py`)

`VisionProvider` interface: `name`, `model`, `available() -> (bool, reason)`, `analyze(inspection) -> VisionAnalysisResponse`.
Implementations: `OpenAICompatibleProvider` (current OpenAI Responses code; works with any OpenAI-compatible
`OPENAI_BASE_URL`), `DemoScenarioProvider` (current demo catalogue; only when `DEMO_MODE=true`),
`UnavailableProvider` (raises `VisionUnavailable("Vision analysis unavailable — manual review required.")`).
Selection: `VISION_PROVIDER=auto|openai|demo|none` (auto: demo if DEMO_MODE, else openai if a key is set, else none).

## Issues (exceptions)

Created on every run for each check with verdict FAIL or UNCERTAIN (one per check). When a later run happens, the
previous issues still `open`/`in_review` become `superseded` (with `superseded_by_record`); resolved issues are kept.
`{issue_id "ISS-…", inspection_id, check_key, check_name, issue_type (reason_code), severity: high (FAIL) |
medium (UNCERTAIN), status: open|in_review|resolved|superseded, title, reason, expected, observed,
evidence_image_ids[], po_id, sku, supplier, assigned_to, notes[], created_at, updated_at, resolved_at, resolved_by}`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/issues` | filters `status`, `severity`, `issue_type`, `inspection_id`, `sku`, `po`, `q`, dates; paginated, newest first |
| GET | `/api/issues/{id}` | issue + inspection summary + evidence file metadata |
| POST | `/api/issues/{id}/actions` | `{action: start_review|resolve|reopen|assign, note?, assigned_to?}`; invalid transition → 409 |
| POST | `/api/issues/{id}/notes` | `{text}` → 201 |
| POST | `/api/issues/{id}/evidence` | `{image_id}` link an image of the same inspection → issue |

## Review tasks (human review queue)

Opened automatically when a run ends UNCERTAIN or PENDING_REVIEW (reason lists the uncertain checks / failure),
or manually. One open task per inspection at most (a new run updates the open one's machine snapshot and returns it
to `open`; a run ending PASS or EXCEPTION cancels an automatic task with `resolution: superseded_by_run`, while a
manual task stays open). A manual request while a task is active → 409.
`{task_id "REV-…", inspection_id, status: open|evidence_requested|completed|cancelled, reason, trigger:
uncertain|perception_unavailable|manual, machine_verdict, machine_record_id, human_decision (PASS|FAIL|UNCERTAIN|null),
decided_by, decided_at, assigned_to, notes[], created_at, updated_at, po_id, sku, supplier}`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/reviews` | filters `status` (comma-separated allowed, e.g. `open,evidence_requested`; omitted = all), `q`, dates; paginated |
| GET | `/api/reviews/{id}` | task + inspection view |
| POST | `/api/reviews/{id}/decision` | `{decision: PASS|FAIL|UNCERTAIN, note (1..2000)}` → appends a contract override (FAIL→EXCEPTION) via the existing override path, sets `human_decision`, status `completed`. PASS needs approver (403). Machine verdict stays in record `checks` and in `machine_verdict`. |
| POST | `/api/reviews/{id}/request-evidence` | `{note}` → status `evidence_requested`; a later run returns it to `open` |
| POST | `/api/reviews/{id}/notes` | `{text}` → 201 |
| POST | `/api/reviews/{id}/assign` | `{assigned_to}` |

## Evidence

Evidence file = an uploaded image. `GET /api/evidence` (filters `inspection_id`, `view`, `analysis_status`, `q`,
dates; paginated) and `GET /api/evidence/{image_id}` return
`{evidence_id (=image_id), inspection_id, filename, file_type (mime), file_size, view (classification), source:
"upload"|"a2a", uploaded_at, uploaded_by, sha256_digest, analysis_status: not_analyzed|analyzed|perception_unavailable,
readings:[Evidence observations for this image], linked_issue_ids[], linked_checks[], po_id, sku, provenance:{
request_id, channel}}`. File bytes: `GET /api/inspections/{id}/images/{image_id}` (existing).

## Catalogue, purchase orders, shipments, cartons

- **Products** `{sku (unique per org), asin, product_name, variant, colour, units_per_carton, expected_components[],
  supplier, created_at, updated_at}` — `GET /api/products` (q, paginated), `POST /api/products` (201; 409 duplicate),
  `GET /api/products/{sku}` (+ `inspections` summary list), `PUT /api/products/{sku}`.
- **Purchase orders** `{po_number (unique per org), supplier, expected_delivery_date, warehouse, status:
  open|partially_received|received|discrepancy (derived), lines:[{line, sku, product_name, variant, expected_quantity,
  units_per_carton, expected_cartons, received_quantity (sum of observed quantities from analysed inspections of
  this po+sku; null if none observed), inspection_ids[], discrepancy: none|short|over|unverified}], created_at}` —
  `GET /api/purchase-orders`, `POST /api/purchase-orders` (201), `GET /api/purchase-orders/{po_number}`.
  Inspections whose `po.po_id` has no PO row still appear as a derived PO (`source: "inspections"`).
- **Import** `POST /api/catalogue/import` multipart `file` (CSV with the columns of `data/receiving_sample.csv`) or
  JSON `{source: "sample"}` to import `data/receiving_sample.csv` (rows for every org are imported into the caller's
  org); upserts products and POs, returns `{products, purchase_orders, rows}`.
- **Shipments** (derived from inspections' `shipment`): `GET /api/shipments` → `{shipment_id, supplier, asn,
  warehouse, expected_delivery_date, inspection_count, verdict_counts:{PASS,FAIL,UNCERTAIN,NOT_ANALYZED},
  last_activity}`; `GET /api/shipments/{shipment_id}` adds `inspections`.
- **Cartons** (derived from inspections' `cartons`): `GET /api/cartons` (filters inspection_id, shipment_id, po,
  sku, condition) → `{carton_id, inspection_id, shipment_id, po_id, sku, expected_units, observed_units (operator
  observed_units_per_carton, else vision units_per_carton observed value, else null), seal_condition,
  visible_condition, carton_type, weight_kg, dimensions_cm, evidence_image_ids (images with view carton),
  inspection_verdict}`; `GET /api/cartons/{inspection_id}/{carton_id}`.

## Dashboard

`GET /api/dashboard?range=today|7d|30d|all|custom&date_from&date_to` →
```jsonc
{ "range": {"from": "…", "to": "…"},
  "totals": {"inspections", "not_analyzed", "pass", "fail", "uncertain", "open_issues", "open_reviews",
             "quantity_discrepancies", "product_mismatches", "variant_mismatches", "damaged_cartons",
             "damaged_products", "missing_components"},
  "daily": [{"date": "YYYY-MM-DD", "pass", "fail", "uncertain", "not_analyzed"}],
  "issues_by_type": [{"issue_type", "count"}],
  "recent_inspections": [inspection summaries ×8],
  "recent_agent_activity": [activity ×8],
  "system": <the /ready body> }
```
Counts derive from the latest record per inspection. `product_mismatches` = identity FAIL;
`damaged_cartons` = carton_damage or carton_condition FAIL; `damaged_products` = unit_damage FAIL (0 until split).

## Audit

`{event_id "AUD-…", organization_id, actor, role, action (e.g. inspection.created, evidence.uploaded,
inspection.run, inspection.overridden, review.created, review.decided, review.evidence_requested, issue.resolved,
note.added, a2a.received, a2a.handoff, catalogue.imported), entity_type, entity_id, inspection_id, summary,
details{}, channel (api|a2a), request_id, correlation_id, created_at}` — append-only (triggers like records).
`GET /api/audit` (filters entity_type, entity_id, inspection_id, action, actor, dates; paginated).

## Agent

`GET /api/agent/capabilities`, `POST /api/agent/receive`, `GET /api/agent/activity` (filters direction,
operation, status, agent, correlation_id, dates; paginated), `GET /api/agent/activity/{request_id}` — see `docs/A2A.md`.
Activity item: `{activity_id, request_id, correlation_id, message_id, direction: inbound|outbound, agent (sender or target),
operation, status: completed|failed|delivered|not_configured, http_status, latency_ms, inspection_id, error,
request (envelope, base64 stripped), response, created_at}`.
