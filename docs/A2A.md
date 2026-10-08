# Receiving Manager · A2A protocol `cube.a2a.v1`

How other CUBE agents (Prep 02, Recovery 05, Returns, Pack) talk to the Receiving Manager.
The record carried in results is the organisers' `receiving_record.v1` (`contracts/receiving_record.v1.md`), unchanged.
JSON Schemas for every message live in `contracts/` (`a2a_request.v1.schema.json`, `a2a_response.v1.schema.json`,
`agent_card.v1.schema.json`). This envelope was designed by this pod because the organisers published only the record
contract; other pods adopting it should raise changes as an Issue labelled `contract`.

## Transport

- HTTPS + JSON. Auth: `X-API-Key` header (a key in `RECEIVING_API_KEYS`; agents normally get `"role": "agent"`).
- Every HTTP response carries `X-Request-ID` (echoed from the request or generated) and `X-Correlation-ID`.
- All timestamps are RFC 3339 UTC with a `Z` suffix.

## Discovery

`GET /.well-known/agent.json` (public) and `GET /api/agent/capabilities` (same body) return the agent card:

```jsonc
{
  "a2a_version": "cube.a2a.v1",
  "agent_id": "receiving_manager",
  "name": "CUBE Receiving Manager",
  "version": "1.0.0",
  "description": "…",
  "endpoint": "/api/agent/receive",
  "auth": { "type": "api_key", "header": "X-API-Key" },
  "record_schema": "receiving_record.v1",
  "operations": [
    { "operation": "receiving.inspect", "description": "…", "input_schema": {…}, "output_schema": {…} },
    { "operation": "receiving.get_record", … },
    { "operation": "receiving.verify_record", … },
    { "operation": "agent.ping", … }
  ],
  "status": { "ready": true, "vision_provider": "openai|demo|none", "degraded_reasons": [] }
}
```

## Request envelope — `POST /api/agent/receive`

```jsonc
{
  "a2a_version": "cube.a2a.v1",
  "message_id": "msg-…",                // sender-unique; also used as the idempotency key per sender
  "correlation_id": "corr-…",           // ties a multi-agent flow together; generated if absent
  "timestamp": "2026-10-08T12:00:00Z",
  "sender":    { "agent_id": "prep_manager", "version": "1.2.0" },
  "recipient": { "agent_id": "receiving_manager" },
  "operation": "receiving.inspect",
  "payload": { … }                      // per operation, below
}
```

## Response envelope (always this shape, HTTP 200 for completed/failed-in-protocol, 4xx/5xx only for transport/auth)

```jsonc
{
  "a2a_version": "cube.a2a.v1",
  "message_id": "msg-…",                // new id
  "in_reply_to": "msg-…",               // request message_id
  "correlation_id": "corr-…",
  "request_id": "req-…",
  "timestamp": "…",
  "sender": { "agent_id": "receiving_manager", "version": "1.0.0" },
  "operation": "receiving.inspect",
  "status": "completed|failed",
  "result": { … } | null,
  "error": null | { "code": "VALIDATION_ERROR|NOT_FOUND|UNSUPPORTED_OPERATION|UNAUTHORIZED|VISION_UNAVAILABLE|INTERNAL_ERROR",
                    "message": "…", "retryable": false, "details": {} }
}
```

## Operations

### `receiving.inspect`
payload:
```jsonc
{
  "po": { /* PurchaseOrder: po_id, sku, product_name, expected_quantity, variant, units_per_carton,
             expected_cartons, expected_components[], unit_id?, asin?, po_line? */ },
  "shipment": { "shipment_id": "…", "supplier": "…", "expected_delivery_date": "YYYY-MM-DD", "warehouse": "…", "asn": "…" },  // optional
  "cartons": [ { "carton_id": "…", "expected_units": 12, "seal_condition": "intact", "visible_condition": "good" } ],  // optional
  "images": [ { "view": "pallet|carton|unit|label|other", "filename": "x.jpg", "content_base64": "…" } ],  // 1..N, same validation as uploads
  "manual_observations": { /* optional operator counts, same shape as POST /api/inspections/{id}/run */ }
}
```
result: `{ "inspection_id", "verdict": "PASS|FAIL|UNCERTAIN", "decision": "ACCEPT|REJECT|PENDING_REVIEW",
"prep_hold": bool, "review_task_id": "…"|null, "issues": [ {issue_id, check_key, severity, reason_code} ], "record": <receiving_record.v1> }`

Verdict mapping: `PASS`→`ACCEPT`; `EXCEPTION`→`FAIL`/`REJECT`; `UNCERTAIN` or `PENDING_REVIEW`→`UNCERTAIN`/`PENDING_REVIEW`.
With no vision provider configured the inspection is still created and sealed, with every perception check
`UNCERTAIN` (`PERCEPTION_UNAVAILABLE`) and a review task opened — the agent never answers PASS without evidence.

### `receiving.get_record`
payload `{ "inspection_id" }` → result `{ "inspection_id", "verdict", "record" }` (latest sealed version).

### `receiving.verify_record`
payload `{ "inspection_id" }` → result: the `/verify` body (`integrity_verified`, `records`, `problems`, …).

### `agent.ping`
payload `{}` → result `{ "pong": true, "ready": bool }`.

## Outbound hand-off

`POST /api/inspections/{id}/handoff {"target_agent": "prep_manager|recovery_manager|returns_manager|pack_manager"}`
builds a `receiving.record_available` request envelope carrying the latest record. If `A2A_PEERS`
(`{"prep_manager": "https://…/api/agent/receive", …}`) names the target, it is POSTed for real (timeout 10 s) and
the outcome recorded as `delivered` or `failed`; otherwise it is stored as `not_configured` with the exact envelope,
so nothing is ever reported as delivered that was not.

## Activity log

Every inbound and outbound message is persisted (`GET /api/agent/activity`, `GET /api/agent/activity/{request_id}`):
direction, sender/target agent, operation, status, latency_ms, request and response envelopes (image bytes stripped).

## Try it

```bash
curl -s localhost:8000/.well-known/agent.json
curl -s -X POST localhost:8000/api/agent/receive -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"a2a_version":"cube.a2a.v1","message_id":"m1","sender":{"agent_id":"prep_manager"},"operation":"agent.ping","payload":{}}'
```
The UI's **A2A Integration** page sends real envelopes to this endpoint and shows the response.
