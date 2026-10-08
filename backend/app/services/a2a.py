"""A2A protocol cube.a2a.v1: agent card, inbound envelope processing, outbound hand-off, activity log."""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Annotated, Any
from uuid import uuid4

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from backend.app.core.config import get_settings
from backend.app.core.context import channel_var, current_correlation_id, current_request_id
from backend.app.core.errors import AppError
from backend.app.database.repository import activity_table
from backend.app.models.intake import MAX_CARTONS, Carton, ManualObservations, Shipment
from backend.app.models.po import PurchaseOrder
from backend.app.services import inspection_service as svc
from backend.app.services.audit import record_event
from backend.app.services.evidence_record import now_rfc3339
from backend.app.services.uploads import validate_base64_image

log = logging.getLogger(__name__)
A2A_VERSION = "cube.a2a.v1"
RECORD_SCHEMA = "receiving_record.v1"
HANDOFF_TARGETS = ("prep_manager", "recovery_manager", "returns_manager", "pack_manager")
DECISION_OF = {"PASS": "ACCEPT", "EXCEPTION": "REJECT", "UNCERTAIN": "PENDING_REVIEW", "PENDING_REVIEW": "PENDING_REVIEW"}
ERROR_CODES = ("VALIDATION_ERROR", "NOT_FOUND", "UNSUPPORTED_OPERATION", "UNAUTHORIZED", "VISION_UNAVAILABLE", "INTERNAL_ERROR")
_ID = re.compile(r"^[A-Za-z0-9._:\-]{1,128}$")

_idem_locks: dict[str, threading.Lock] = {}
_idem_guard = threading.Lock()


def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- agent card ---------------------------------------------------------------------------------

_INSPECTION_ID_INPUT = {"type": "object", "required": ["inspection_id"], "additionalProperties": False,
                        "properties": {"inspection_id": {"type": "string", "minLength": 1}}}
_INSPECT_INPUT = {
    "type": "object",
    "required": ["po", "images"],
    "properties": {
        "po": {"type": "object", "required": ["po_id", "sku", "product_name", "expected_quantity", "variant",
                                              "units_per_carton", "expected_cartons"]},
        "shipment": {"type": ["object", "null"]},
        "cartons": {"type": "array", "maxItems": MAX_CARTONS, "items": {"type": "object", "required": ["carton_id"]}},
        "images": {"type": "array", "minItems": 1, "items": {
            "type": "object", "required": ["filename", "content_base64"],
            "properties": {"view": {"enum": ["pallet", "carton", "unit", "label", "other"]},
                           "filename": {"type": "string"}, "content_base64": {"type": "string"}}}},
        "manual_observations": {"type": ["object", "null"]},
        "scenario": {"type": ["string", "null"], "description": "DEMO_MODE only: demo scenario name."},
    },
}
_RECORD_REF = {"$ref": "receiving_record.v1.schema.json"}


def operations() -> list[dict]:
    return [
        {"operation": "receiving.inspect",
         "description": "Create an inspection from a PO line and photos (base64), run perception plus the deterministic "
                        "rules, seal a receiving_record.v1 and return the verdict. Never PASS without evidence.",
         "input_schema": _INSPECT_INPUT,
         "output_schema": {"type": "object", "required": ["inspection_id", "verdict", "decision", "prep_hold", "record"],
                           "properties": {"inspection_id": {"type": "string"},
                                          "verdict": {"enum": ["PASS", "FAIL", "UNCERTAIN"]},
                                          "decision": {"enum": ["ACCEPT", "REJECT", "PENDING_REVIEW"]},
                                          "prep_hold": {"type": "boolean"},
                                          "review_task_id": {"type": ["string", "null"]},
                                          "issues": {"type": "array"}, "record": _RECORD_REF}}},
        {"operation": "receiving.get_record",
         "description": "Latest sealed receiving_record.v1 for an inspection.",
         "input_schema": _INSPECTION_ID_INPUT,
         "output_schema": {"type": "object", "required": ["inspection_id", "verdict", "record"],
                           "properties": {"inspection_id": {"type": "string"},
                                          "verdict": {"enum": ["PASS", "FAIL", "UNCERTAIN"]}, "record": _RECORD_REF}}},
        {"operation": "receiving.verify_record",
         "description": "Re-verify every sealed version: content hash, HMAC seal, version chain, override hashes.",
         "input_schema": _INSPECTION_ID_INPUT,
         "output_schema": {"type": "object", "required": ["inspection_id", "integrity_verified", "records", "problems"],
                           "properties": {"integrity_verified": {"type": "boolean"}, "records": {"type": "integer"},
                                          "problems": {"type": "array", "items": {"type": "string"}}}}},
        {"operation": "agent.ping",
         "description": "Liveness and readiness of this agent.",
         "input_schema": {"type": "object"},
         "output_schema": {"type": "object", "required": ["pong", "ready"],
                           "properties": {"pong": {"const": True}, "ready": {"type": "boolean"}}}},
    ]


def agent_card(include_status: bool = True) -> dict:
    settings = get_settings()
    card = {
        "a2a_version": A2A_VERSION,
        "agent_id": settings.agent_id,
        "name": "CUBE Receiving Manager",
        "version": settings.app_version,
        "description": "Checks inbound shipments against the purchase order from photos and operator counts, "
                       "seals a tamper-evident receiving_record.v1 and holds anything it could not verify.",
        "endpoint": "/api/agent/receive",
        "auth": {"type": "api_key", "header": "X-API-Key"},
        "record_schema": RECORD_SCHEMA,
        "operations": operations(),
    }
    if include_status:
        from backend.app.services.health import readiness
        from backend.app.services.vision_providers import select_provider

        ready = readiness()
        card["status"] = {
            "ready": ready["status"] != "UNAVAILABLE",
            "vision_provider": select_provider(settings).name,
            "degraded_reasons": [f"{c['name']}: {c['message']}" for c in ready["components"] if c["status"] != "HEALTHY"],
        }
    else:
        card["status"] = {"ready": True, "vision_provider": "unknown", "degraded_reasons": []}
    return card


# --- inbound ------------------------------------------------------------------------------------


class ProtocolError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None, retryable: bool = False):
        super().__init__(message)
        self.code = code if code in ERROR_CODES else "INTERNAL_ERROR"
        self.message = message
        self.details = details or {}
        self.retryable = retryable


class A2AImage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    view: str = "other"
    filename: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    content_base64: str = Field(..., min_length=1)


class InspectPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    po: PurchaseOrder
    shipment: Shipment | None = None
    cartons: list[Carton] = Field(default_factory=list, max_length=MAX_CARTONS)
    images: list[A2AImage] = Field(..., min_length=1)
    manual_observations: ManualObservations | None = None
    scenario: str | None = Field(default=None, max_length=100)


class InspectionRef(BaseModel):
    model_config = ConfigDict(extra="ignore")

    inspection_id: Annotated[str, StringConstraints(min_length=1, max_length=64, strip_whitespace=True)]


def _validation_details(exc: ValidationError) -> dict:
    return {"errors": [{"loc": [str(p) for p in e.get("loc", ())], "msg": str(e.get("msg", "")), "type": e.get("type")}
                       for e in exc.errors()]}


def _from_http(exc: HTTPException, context: dict | None = None) -> ProtocolError:
    code = {404: "NOT_FOUND", 401: "UNAUTHORIZED", 403: "UNAUTHORIZED"}.get(exc.status_code)
    if code is None:
        code = "VALIDATION_ERROR" if 400 <= exc.status_code < 500 else "INTERNAL_ERROR"
    details = dict(getattr(exc, "details", None) or {})
    details.update(context or {})
    details["http_status"] = exc.status_code
    return ProtocolError(code, str(exc.detail), details, retryable=exc.status_code >= 500)


def _op_inspect(principal: dict, payload: dict) -> tuple[dict, str | None]:
    try:
        req = InspectPayload.model_validate(payload)
    except ValidationError as exc:
        raise ProtocolError("VALIDATION_ERROR", "Invalid receiving.inspect payload.", _validation_details(exc)) from None
    settings = get_settings()
    if len(req.images) > settings.upload_max_images:
        raise ProtocolError("VALIDATION_ERROR", f"Too many images ({len(req.images)} > {settings.upload_max_images}).")
    ids = [c.carton_id for c in req.cartons]
    if len(ids) != len(set(ids)):
        raise ProtocolError("VALIDATION_ERROR", "cartons: carton_id values must be unique.")
    try:
        svc.validate_scenario(req.scenario)
    except HTTPException as exc:
        raise _from_http(exc) from None
    inspection_id = svc.repository.generate_id()
    validated = []
    for index, image in enumerate(req.images):
        try:
            validated.append(validate_base64_image(image.filename, image.content_base64, inspection_id))
        except HTTPException as exc:
            raise _from_http(exc, {"image_index": index}) from None
    inspection = svc.create_inspection(principal, req.po, req.shipment, req.cartons, channel="a2a",
                                       inspection_id=inspection_id)
    svc.store_images(principal, inspection.inspection_id, validated, [svc.contract_view(i.view) for i in req.images],
                     source="a2a")
    run = svc.run_inspection(principal, inspection.inspection_id, req.scenario, req.manual_observations,
                             manual_provided=req.manual_observations is not None)
    record = run["record"]
    task = run.get("review_task")
    return {
        "inspection_id": inspection.inspection_id,
        "verdict": run["verdict"],
        "decision": record["outcome"]["decision"],
        "prep_hold": record["outcome"]["prep_hold"],
        "review_task_id": task["task_id"] if task else None,
        "issues": run["issues"],
        "record": record,
    }, inspection.inspection_id


def _load_ref(principal: dict, payload: dict):
    try:
        ref = InspectionRef.model_validate(payload)
    except ValidationError as exc:
        raise ProtocolError("VALIDATION_ERROR", "payload.inspection_id is required.", _validation_details(exc)) from None
    try:
        return svc.load(principal, ref.inspection_id)
    except HTTPException as exc:
        raise _from_http(exc) from None


def _op_get_record(principal: dict, payload: dict) -> tuple[dict, str | None]:
    inspection = _load_ref(principal, payload)
    if inspection.record is None:
        raise ProtocolError("NOT_FOUND", "No sealed record yet: the inspection has not been analysed.",
                            {"inspection_id": inspection.inspection_id})
    return {"inspection_id": inspection.inspection_id, "verdict": svc.verdict_of(inspection),
            "record": inspection.record}, inspection.inspection_id


def _op_verify(principal: dict, payload: dict) -> tuple[dict, str | None]:
    inspection = _load_ref(principal, payload)
    return svc.verify(principal, inspection.inspection_id), inspection.inspection_id


def _op_ping(principal: dict, payload: dict) -> tuple[dict, str | None]:
    from backend.app.services.health import readiness

    return {"pong": True, "ready": readiness()["status"] != "UNAVAILABLE"}, None


HANDLERS = {
    "receiving.inspect": _op_inspect,
    "receiving.get_record": _op_get_record,
    "receiving.verify_record": _op_verify,
    "agent.ping": _op_ping,
}


def strip_binary(envelope: Any) -> Any:
    """Copy of an envelope with image bytes replaced by a size + digest marker."""
    if not isinstance(envelope, dict):
        return envelope
    clean = copy.deepcopy(envelope)
    payload = clean.get("payload")
    if isinstance(payload, dict) and isinstance(payload.get("images"), list):
        for image in payload["images"]:
            if isinstance(image, dict) and isinstance(image.get("content_base64"), str):
                raw = image["content_base64"]
                image["content_base64"] = f"<stripped {len(raw)} base64 chars sha256:{hashlib.sha256(raw.encode()).hexdigest()[:16]}>"
    return clean


def build_response(*, in_reply_to: str | None, correlation_id: str | None, operation: str | None, status: str,
                   result: dict | None, error: dict | None) -> dict:
    settings = get_settings()
    return {
        "a2a_version": A2A_VERSION,
        "message_id": f"msg-{uuid4().hex[:16]}",
        "in_reply_to": in_reply_to,
        "correlation_id": correlation_id,
        "request_id": current_request_id(),
        "timestamp": _ts(),
        "sender": {"agent_id": settings.agent_id, "version": settings.app_version},
        "operation": operation,
        "status": status,
        "result": result,
        "error": error,
    }


def parse_envelope(raw: bytes) -> tuple[dict | Any, ProtocolError | None]:
    try:
        envelope = json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, ProtocolError("VALIDATION_ERROR", "Request body is not valid JSON.")
    if not isinstance(envelope, dict):
        return envelope, ProtocolError("VALIDATION_ERROR", "Envelope must be a JSON object.")
    problems = []
    if envelope.get("a2a_version") != A2A_VERSION:
        problems.append(f"a2a_version must be '{A2A_VERSION}'")
    message_id = envelope.get("message_id")
    if not isinstance(message_id, str) or not _ID.match(message_id):
        problems.append("message_id must be a string of 1-128 chars [A-Za-z0-9._:-]")
    sender = envelope.get("sender")
    if not isinstance(sender, dict) or not isinstance(sender.get("agent_id"), str) or not _ID.match(sender.get("agent_id") or ""):
        problems.append("sender.agent_id is required")
    if not isinstance(envelope.get("operation"), str) or not envelope.get("operation"):
        problems.append("operation is required")
    if "payload" in envelope and not isinstance(envelope.get("payload"), dict):
        problems.append("payload must be an object")
    corr = envelope.get("correlation_id")
    if corr is not None and (not isinstance(corr, str) or not _ID.match(corr)):
        problems.append("correlation_id must be a string of 1-128 chars [A-Za-z0-9._:-]")
    recipient = envelope.get("recipient")
    if recipient is not None:
        if not isinstance(recipient, dict):
            problems.append("recipient must be an object")
        elif recipient.get("agent_id") not in (None, get_settings().agent_id):
            problems.append(f"recipient.agent_id must be '{get_settings().agent_id}'")
    if problems:
        return envelope, ProtocolError("VALIDATION_ERROR", "Invalid A2A envelope: " + "; ".join(problems),
                                       {"problems": problems})
    return envelope, None


def idempotency_key(envelope: Any) -> str | None:
    if not isinstance(envelope, dict):
        return None
    sender = envelope.get("sender") if isinstance(envelope.get("sender"), dict) else {}
    agent, message_id = sender.get("agent_id"), envelope.get("message_id")
    if isinstance(agent, str) and _ID.match(agent) and isinstance(message_id, str) and _ID.match(message_id):
        return f"{agent}|{message_id}"
    return None


def find_replay(organization_id: str, key: str | None) -> dict | None:
    if not key:
        return None
    found = activity_table.find(organization_id, idem=key)
    return found[-1] if found else None


def idem_lock(organization_id: str, key: str | None) -> threading.Lock:
    with _idem_guard:
        return _idem_locks.setdefault(f"{organization_id}/{key}", threading.Lock())


def process(principal: dict, envelope: Any, envelope_error: ProtocolError | None, correlation_id: str) -> tuple[dict, bool]:
    """Returns (response envelope, replayed). Never raises for protocol problems."""
    org = principal["organization_id"]
    key = idempotency_key(envelope) if envelope_error is None else None
    channel_var.set("a2a")
    with idem_lock(org, key):
        replay = find_replay(org, key)
        if replay is not None:
            return replay["response"], True
        started = time.perf_counter()
        operation = envelope.get("operation") if isinstance(envelope, dict) and isinstance(envelope.get("operation"), str) else None
        in_reply_to = envelope.get("message_id") if isinstance(envelope, dict) and isinstance(envelope.get("message_id"), str) else None
        inspection_id = None
        result, error = None, None
        try:
            if envelope_error is not None:
                raise envelope_error
            handler = HANDLERS.get(operation)
            if handler is None:
                raise ProtocolError("UNSUPPORTED_OPERATION", f"Operation {operation!r} is not supported.",
                                    {"supported": sorted(HANDLERS)})
            result, inspection_id = handler(principal, envelope.get("payload") or {})
        except ProtocolError as exc:
            error = {"code": exc.code, "message": exc.message, "retryable": exc.retryable, "details": exc.details}
        except HTTPException as exc:
            perr = _from_http(exc)
            error = {"code": perr.code, "message": perr.message, "retryable": perr.retryable, "details": perr.details}
        except Exception as exc:  # noqa: BLE001 - protocol answers, never a stack trace
            log.exception("A2A %s failed", operation)
            error = {"code": "INTERNAL_ERROR", "message": "Internal error while processing the message.",
                     "retryable": True, "details": {"exception": type(exc).__name__}}
        status = "failed" if error else "completed"
        response = build_response(in_reply_to=in_reply_to, correlation_id=correlation_id, operation=operation,
                                  status=status, result=result, error=error)
        sender = envelope.get("sender", {}).get("agent_id") if isinstance(envelope, dict) and isinstance(envelope.get("sender"), dict) else None
        activity = _store_activity(
            org, direction="inbound", agent=sender if isinstance(sender, str) else None, operation=operation,
            status=status, http_status=200, latency_ms=round((time.perf_counter() - started) * 1000, 2),
            inspection_id=inspection_id, error=error, request=strip_binary(envelope), response=response,
            message_id=in_reply_to, correlation_id=correlation_id, idem=key,
        )
        record_event(principal, "a2a.received", "agent_activity", activity["activity_id"], inspection_id=inspection_id,
                     summary=f"A2A {operation or '?'} from {activity['agent'] or '?'}: {status}",
                     details={"message_id": in_reply_to, "operation": operation, "status": status,
                              "error_code": (error or {}).get("code")})
        return response, False


def _store_activity(organization_id: str, *, direction: str, agent: str | None, operation: str | None, status: str,
                    http_status: int | None, latency_ms: float, inspection_id: str | None, error: Any,
                    request: Any, response: Any, message_id: str | None, correlation_id: str | None,
                    idem: str | None = None) -> dict:
    activity = {
        "activity_id": f"ACT-{uuid4().hex[:12].upper()}",
        "request_id": current_request_id(),
        "correlation_id": correlation_id,
        "message_id": message_id,
        "direction": direction,
        "agent": agent,
        "operation": operation,
        "status": status,
        "http_status": http_status,
        "latency_ms": latency_ms,
        "inspection_id": inspection_id,
        "error": error,
        "request": request,
        "response": response,
        "created_at": now_rfc3339(),
    }
    activity_table.insert(organization_id, activity["activity_id"], activity, created_at=activity["created_at"],
                          inspection_id=inspection_id, status=status, kind=operation, ref=activity["request_id"],
                          idem=idem)
    return activity


# --- outbound hand-off --------------------------------------------------------------------------


def handoff(principal: dict, inspection_id: str, target_agent: str) -> dict:
    from backend.app.services.health import parse_peers

    inspection = svc.load(principal, inspection_id)
    if inspection.record is None:
        raise AppError(409, "Analyze the inspection before handing it off.")
    settings = get_settings()
    record = inspection.record
    correlation_id = current_correlation_id() or current_request_id()
    envelope = {
        "a2a_version": A2A_VERSION,
        "message_id": f"msg-{uuid4().hex[:16]}",
        "correlation_id": correlation_id,
        "timestamp": _ts(),
        "sender": {"agent_id": settings.agent_id, "version": settings.app_version},
        "recipient": {"agent_id": target_agent},
        "operation": "receiving.record_available",
        "payload": {
            "inspection_id": inspection_id,
            "verdict": svc.verdict_of(inspection),
            "decision": record["outcome"]["decision"],
            "prep_hold": record["outcome"]["prep_hold"],
            "hold_reasons": record["outcome"].get("hold_reasons", []),
            "record": record,
        },
    }
    peer = parse_peers().get(target_agent)
    started = time.perf_counter()
    http_status, response, error = None, None, None
    if peer is None:
        status = "not_configured"
        error = f"No A2A_PEERS entry for {target_agent}; the envelope was recorded but not sent."
    else:
        headers = {"Content-Type": "application/json", "X-Request-ID": current_request_id() or "",
                   "X-Correlation-ID": correlation_id or ""}
        if peer.get("api_key"):
            headers["X-API-Key"] = peer["api_key"]
        try:
            reply = httpx.post(peer["url"], json=envelope, headers=headers, timeout=10.0)
            http_status = reply.status_code
            try:
                response = reply.json()
            except ValueError:
                response = {"text": reply.text[:2000]}
            peer_failed = isinstance(response, dict) and response.get("status") == "failed"
            if 200 <= reply.status_code < 300 and not peer_failed:
                status = "delivered"
            else:
                status = "failed"
                error = f"Peer answered HTTP {reply.status_code}" + (" with status=failed" if peer_failed else "")
        except httpx.HTTPError as exc:
            status = "failed"
            error = f"{type(exc).__name__}: " + re.sub(r"https?://\S+", "<url>", str(exc))[:300]
    activity = _store_activity(
        principal["organization_id"], direction="outbound", agent=target_agent, operation="receiving.record_available",
        status=status, http_status=http_status, latency_ms=round((time.perf_counter() - started) * 1000, 2),
        inspection_id=inspection_id, error=error, request=envelope, response=response,
        message_id=envelope["message_id"], correlation_id=correlation_id,
    )
    record_event(principal, "a2a.handoff", "agent_activity", activity["activity_id"], inspection_id=inspection_id,
                 summary=f"Hand-off to {target_agent}: {status}",
                 details={"target_agent": target_agent, "status": status, "http_status": http_status,
                          "message_id": envelope["message_id"], "record_id": record["record_id"]})
    return activity


def list_activity(organization_id: str) -> list[dict]:
    return activity_table.find(organization_id)


def get_activity(organization_id: str, request_id: str) -> dict | None:
    found = activity_table.find(organization_id, ref=request_id)
    return found[-1] if found else None
