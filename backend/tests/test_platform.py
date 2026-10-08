"""Platform features from docs/API.md and docs/A2A.md. Demo scenarios or monkeypatched providers only: no network/AI."""

import base64
import csv
import io
import json
import os
import sqlite3
from pathlib import Path

import httpx
import jsonschema
import pytest
from fastapi.testclient import TestClient

from backend.tests.test_backend import (  # noqa: F401  (_fresh_settings is an autouse fixture)
    A, A_APPROVER, B, CLEAN, PO, _create_inspection, _fresh_settings, _obs, _png_bytes, _set_env, _upload, client,
)
from backend.app.core.config import REPO_ROOT, get_settings
from backend.app.main import app
from backend.app.services import a2a as a2a_service
from backend.app.services import dashboard as dashboard_service
from backend.app.services import vision_providers
from backend.app.services.vision import VisionAnalysisResponse

CONTRACTS = REPO_ROOT / "contracts"
BASE_KEYS = json.loads(os.environ["RECEIVING_API_KEYS"])
UNAVAILABLE = "Vision analysis unavailable — manual review required."


def _schema(name):
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def _validate(instance, name):
    schema = _schema(name)
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.Draft202012Validator(schema).validate(instance)


def _demo(monkeypatch, **extra):
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None, OPENAI_API_KEY=None, VISION_PROVIDER=None, **extra)


def _no_vision(monkeypatch):
    _set_env(monkeypatch, DEMO_MODE="false", AI_API_KEY=None, OPENAI_API_KEY=None, VISION_PROVIDER="none")


def _org(monkeypatch, name):
    """A fresh tenant (operator + approver keys) so counts are not affected by other tests."""
    keys = {**BASE_KEYS,
            f"key-{name}-op": {"organization_id": f"org-{name}", "operator_id": f"op-{name}", "role": "operator"},
            f"key-{name}-appr": {"organization_id": f"org-{name}", "operator_id": f"sup-{name}", "role": "approver"},
            f"key-{name}-agent": {"organization_id": f"org-{name}", "operator_id": f"agent-{name}", "role": "agent"}}
    _set_env(monkeypatch, RECEIVING_API_KEYS=json.dumps(keys))
    return {"X-API-Key": f"key-{name}-op"}, {"X-API-Key": f"key-{name}-appr"}, {"X-API-Key": f"key-{name}-agent"}


class FakeProvider:
    name = "openai"
    model = "fake-vision-1"
    model_version = "fake-vision-1"

    def __init__(self, observations):
        self.observations = observations

    def available(self):
        return True, "fake"

    def analyze(self, inspection, scenario=None):
        return VisionAnalysisResponse.model_validate({"images": [
            {"image_id": inspection.images[0].image_id, "visibility": "clear", "observations": self.observations}]})


def _fake_vision(monkeypatch, observations):
    _set_env(monkeypatch, DEMO_MODE="false")
    monkeypatch.setattr(vision_providers, "select_provider", lambda settings=None: FakeProvider(observations))


def _swap(**changes):
    return [o for o in CLEAN if o["check_type"] not in changes] + [_obs(k, v) for k, v in changes.items()]


def _new(headers=A, po=None, **intake):
    r = client.post("/api/inspections", json={"po": po or PO, **intake}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["inspection_id"]


def _run(iid, headers=A, scenario=None, **body):
    params = {"scenario": scenario} if scenario else None
    r = client.post(f"/api/inspections/{iid}/run", params=params, json=body or None, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _checks(body):
    return {c["check_key"]: c for c in body["record"]["checks"]}


def _scenario_run(monkeypatch, scenario, headers=A, **intake):
    _demo(monkeypatch)
    iid = _new(headers, **intake)
    _upload(iid, headers=headers)
    return iid, _run(iid, headers, scenario=scenario)


# --- health, readiness, errors, request ids ---------------------------------------------------


def test_health_and_ready_are_public_and_leak_no_secrets(monkeypatch):
    for path in ("/health", "/api/health"):
        body = client.get(path).json()
        assert body["status"] == "ok" and body["version"] == "1.0.0" and isinstance(body["demo_mode"], bool)
    _demo(monkeypatch)
    r = client.get("/ready")
    assert r.status_code == 200 and client.get("/api/ready").status_code == 200
    body = r.json()
    assert body["status"] in {"HEALTHY", "DEGRADED"} and body["checked_at"].endswith("Z")
    names = {c["name"] for c in body["components"]}
    assert names == {"database", "storage", "vision_provider", "seal_key", "authentication", "a2a"}
    assert "test-seal-key" not in r.text and "key-a-op" not in r.text

    _no_vision(monkeypatch)
    vision = next(c for c in client.get("/ready").json()["components"] if c["name"] == "vision_provider")
    assert vision["status"] == "DEGRADED" and vision["message"] == UNAVAILABLE

    _set_env(monkeypatch, RECEIVING_API_KEYS="")
    r = client.get("/ready")
    assert r.status_code == 503 and r.json()["status"] == "UNAVAILABLE"


def test_error_envelope_and_request_ids():
    r = client.post("/api/inspections", json={"po": {**PO, "expected_quantity": -1}}, headers={**A, "X-Request-ID": "req-test-123"})
    assert r.status_code == 422
    body = r.json()
    assert isinstance(body["detail"], str) and "expected_quantity" in body["detail"]
    assert body["error"]["code"] == "VALIDATION_ERROR" and body["error"]["message"] == body["detail"]
    assert body["error"]["request_id"] == "req-test-123" == r.headers["x-request-id"]
    assert isinstance(body["error"]["details"]["errors"], list) and body["error"]["details"]["errors"]
    assert r.headers["x-correlation-id"] == "req-test-123"  # reuses the request id when no correlation id given

    r = client.get("/api/inspections/INS-NOPE", headers={**A, "X-Correlation-ID": "corr-flow-1"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND"
    assert r.headers["x-correlation-id"] == "corr-flow-1" and r.headers["x-request-id"].startswith("req-")
    assert client.get("/api/issues").json()["error"]["code"] == "UNAUTHORIZED"
    assert client.get("/api/inspections", headers={**A, "X-Request-ID": "bad id with spaces"}).headers["x-request-id"].startswith("req-")


def test_unhandled_error_is_500_without_stack_trace(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(dashboard_service, "build", boom)
    safe_client = TestClient(app, raise_server_exceptions=False)
    r = safe_client.get("/api/dashboard", headers=A)
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "INTERNAL_ERROR" and r.json()["detail"] == "Internal server error."
    assert "secret" not in r.text and "Traceback" not in r.text
    assert r.headers.get("x-request-id")


def test_cors_allows_put_and_exposes_ids():
    r = client.options("/api/products/X", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "PUT",
                                                   "Access-Control-Request-Headers": "x-api-key,content-type"})
    assert r.status_code == 200
    r = client.get("/health", headers={"Origin": "http://localhost:5173"})
    exposed = r.headers.get("access-control-expose-headers", "").lower()
    assert "x-request-id" in exposed and "x-correlation-id" in exposed


def test_system_info(monkeypatch):
    _demo(monkeypatch, A2A_PEERS=json.dumps({"prep_manager": {"url": "https://prep.example/api/agent/receive", "api_key": "peer-secret"}}))
    r = client.get("/api/system/info", headers=A)
    body = r.json()
    assert body["a2a_version"] == "cube.a2a.v1" and body["record_schema"] == "receiving_record.v1"
    assert body["principal"] == {"organization_id": "org-a", "operator_id": "op-alice", "role": "operator"}
    assert body["environment"]["a2a_peers"] == ["prep_manager"] and body["environment"]["vision_provider"] == "demo"
    assert "peer-secret" not in r.text and "prep.example" not in r.text and "test-seal-key" not in r.text


# --- verdict scenarios --------------------------------------------------------------------------


def test_correct_shipment_passes_and_view_has_new_fields(monkeypatch):
    iid, body = _scenario_run(monkeypatch, "correct_shipment")
    assert body["decision"] == "PASS" and body["verdict"] == "PASS" and body["issues"] == [] and body["review_task"] is None
    _validate(body["record"], "receiving_record.v1.schema.json")
    view = client.get(f"/api/inspections/{iid}", headers=A).json()
    for key in ("verdict", "shipment", "cartons", "notes", "open_issue_count", "review_task", "manual_observations",
                "issues", "review_tasks", "evidence_files"):
        assert key in view, key
    assert view["verdict"] == "PASS" and view["open_issue_count"] == 0
    assert "image_path" not in json.dumps(view)
    assert _checks(body)["carton_condition"]["verdict"] == "NOT_REQUIRED"


def test_short_shipment_fails_with_quantity_issues(monkeypatch):
    iid, body = _scenario_run(monkeypatch, "short_shipment")
    assert body["verdict"] == "FAIL" and body["record"]["outcome"]["decision"] == "REJECT"
    keys = {i["check_key"] for i in body["issues"]}
    assert {"total_quantity", "units_per_carton"} <= keys
    assert all(i["severity"] == "high" for i in body["issues"])


def test_overage_and_wrong_sku_fail(monkeypatch):
    _fake_vision(monkeypatch, _swap(quantity=30, units_per_carton=15))
    iid = _new()
    _upload(iid)
    body = _run(iid)
    checks = _checks(body)
    assert checks["total_quantity"]["verdict"] == "FAIL" and checks["total_quantity"]["observed_state"] == 30
    assert body["verdict"] == "FAIL" and checks["identity"]["model_version"] == "fake-vision-1"

    _fake_vision(monkeypatch, _swap(sku="RED-BOTTLE-002"))
    iid = _new()
    _upload(iid)
    body = _run(iid)
    assert _checks(body)["identity"]["verdict"] == "FAIL" and _checks(body)["identity"]["reason_code"] == "SKU_MISMATCH"


def test_wrong_variant_and_missing_component(monkeypatch):
    _, body = _scenario_run(monkeypatch, "wrong_variant")
    assert _checks(body)["variant"]["verdict"] == "FAIL" and body["verdict"] == "FAIL"
    _, body = _scenario_run(monkeypatch, "missing_component")
    assert _checks(body)["components"]["verdict"] == "FAIL" and body["verdict"] == "FAIL"


def test_damaged_carton_under_both_damage_policies(monkeypatch):
    _, body = _scenario_run(monkeypatch, "damaged_carton")
    assert _checks(body)["carton_damage"]["verdict"] == "FAIL" and body["verdict"] == "FAIL"

    _demo(monkeypatch, DAMAGE_POLICY="review")
    iid = _new()
    _upload(iid)
    body = _run(iid, scenario="damaged_carton")
    damage = _checks(body)["carton_damage"]
    assert damage["verdict"] == "UNCERTAIN" and damage["reason_code"] == "DAMAGE_REVIEW_REQUIRED"
    assert body["verdict"] == "UNCERTAIN" and body["review_task"]["trigger"] == "uncertain"


def test_operator_carton_condition_check(monkeypatch):
    broken = [{"carton_id": "C1", "seal_condition": "broken", "visible_condition": "good"},
              {"carton_id": "C2", "seal_condition": "intact", "visible_condition": "good"}]
    _, body = _scenario_run(monkeypatch, "correct_shipment", cartons=broken)
    cond = _checks(body)["carton_condition"]
    assert cond["verdict"] == "FAIL" and cond["reason_code"] == "CARTON_CONDITION_REPORTED"
    assert cond["model_version"] == "operator" and body["verdict"] == "FAIL"

    _demo(monkeypatch, DAMAGE_POLICY="review")
    iid = _new(cartons=broken)
    _upload(iid)
    body = _run(iid, scenario="correct_shipment")
    assert _checks(body)["carton_condition"]["verdict"] == "UNCERTAIN" and body["verdict"] == "UNCERTAIN"

    good = [{"carton_id": "C1", "seal_condition": "intact", "visible_condition": "good"}]
    _, body = _scenario_run(monkeypatch, "correct_shipment", cartons=good)
    assert _checks(body)["carton_condition"]["verdict"] == "PASS" and body["verdict"] == "PASS"
    _, body = _scenario_run(monkeypatch, "correct_shipment", cartons=[{"carton_id": "C1"}])
    assert _checks(body)["carton_condition"]["reason_code"] == "NOT_OBSERVED" and body["verdict"] == "UNCERTAIN"

    bad = client.post("/api/inspections", json={"po": PO, "cartons": [{"carton_id": "C1", "seal_condition": "melted"}]}, headers=A)
    assert bad.status_code == 422


def test_ambiguous_photos_are_uncertain_with_review_task(monkeypatch):
    iid, body = _scenario_run(monkeypatch, "ambiguous")
    assert body["verdict"] == "UNCERTAIN" and body["decision"] == "UNCERTAIN"
    assert body["review_task"]["trigger"] == "uncertain" and "identity" in body["review_task"]["reason"]
    assert all(i["severity"] == "medium" for i in body["issues"])
    assert _checks(body)["identity"]["observed_state"] is None  # not seen is never the PO value


def test_vision_unavailable_is_pending_review_with_task(monkeypatch):
    _no_vision(monkeypatch)
    iid = _new()
    _upload(iid)
    body = _run(iid)
    assert body["decision"] == "PENDING_REVIEW" and body["verdict"] == "UNCERTAIN"
    assert body["failure_reason"] == UNAVAILABLE and body["status"] == "pending"
    assert body["record"]["status"] == "pending" and body["record"]["outcome"]["decision"] == "PENDING_REVIEW"
    perception = [c for c in body["record"]["checks"] if c["check_key"] != "carton_condition"]
    assert all(c["verdict"] == "UNCERTAIN" and c["reason_code"] == "PERCEPTION_UNAVAILABLE" for c in perception)
    assert body["review_task"]["trigger"] == "perception_unavailable"
    view = client.get(f"/api/inspections/{iid}", headers=A).json()
    assert view["review_task"]["status"] == "open" and view["evidence_files"][0]["analysis_status"] == "perception_unavailable"
    assert view["agent_summary"].startswith("Perception was unavailable, so nothing was checked")


def test_vision_unavailable_summary_reports_operator_carton_findings(monkeypatch):
    _no_vision(monkeypatch)
    iid = _new(cartons=[{"carton_id": "C1", "seal_condition": "intact", "visible_condition": "crushed"}])
    _upload(iid)
    body = _run(iid)
    assert body["decision"] == "PENDING_REVIEW"  # contract rule 3: perception failure stays pending
    assert _checks(body)["carton_condition"]["verdict"] == "FAIL"
    assert "nothing was checked" not in body["agent_summary"] and "carton condition FAIL" in body["agent_summary"]


def test_manual_observations_without_vision_give_defensible_verdicts(monkeypatch):
    _no_vision(monkeypatch)
    full = {"observed_sku": "BLUE-BOTTLE-001", "observed_quantity": 24, "observed_cartons": 2,
            "observed_units_per_carton": 12, "observed_variant": "Blue", "damage": "none",
            "components_present": ["cap", "label"], "note": "Counted on the dock."}
    iid = _new()
    _upload(iid)
    body = _run(iid, manual_observations=full)
    assert body["decision"] == "PASS" and body["status"] == "completed" and body["record"]["status"] == "final"
    assert body["failure_reason"] is None and body["vision_status"] == "unavailable"
    assert body["analysis_status"] == "operator_only"
    identity = _checks(body)["identity"]
    assert identity["model_version"] == "operator" and identity["evidence_ids"][0].startswith("OPR-")
    assert identity["image_ids"] == []  # the operator is not an image
    assert any(e["image_id"] == "operator" for e in body["evidence"])
    _validate(body["record"], "receiving_record.v1.schema.json")

    iid = _new()  # no photo at all: operator counts alone
    body = _run(iid, manual_observations={**full, "observed_quantity": 20, "observed_units_per_carton": 10})
    assert body["decision"] == "EXCEPTION" and _checks(body)["total_quantity"]["verdict"] == "FAIL"

    iid = _new()
    body = _run(iid, manual_observations={"observed_sku": "BLUE-BOTTLE-001"})
    checks = _checks(body)
    assert checks["identity"]["verdict"] == "PASS"
    assert checks["variant"]["verdict"] == "UNCERTAIN" and checks["variant"]["reason_code"] == "PERCEPTION_UNAVAILABLE"
    assert body["decision"] == "UNCERTAIN" and body["review_task"]["trigger"] == "uncertain"

    iid = _new()
    assert client.post(f"/api/inspections/{iid}/run", json={}, headers=A).status_code == 400  # nothing to analyse


def test_conflicting_operator_and_vision_readings_are_uncertain(monkeypatch):
    _demo(monkeypatch)
    iid = _new()
    _upload(iid)
    body = _run(iid, scenario="correct_shipment", manual_observations={"observed_quantity": 20})
    q = _checks(body)["total_quantity"]
    assert q["verdict"] == "UNCERTAIN" and q["reason_code"] == "VIEWS_DISAGREE"
    assert set(q["measurements"]["sources"]) == {"operator", "vision"}

    body = _run(iid, scenario="damaged_carton", manual_observations={"damage": "none"})
    d = _checks(body)["carton_damage"]
    assert d["verdict"] == "UNCERTAIN" and d["reason_code"] == "VIEWS_DISAGREE"

    body = _run(iid, scenario="correct_shipment", manual_observations={"observed_sku": "BLUE BOTTLE 001"})
    assert _checks(body)["identity"]["verdict"] == "PASS"  # agreeing sources stay decided


# --- issues -------------------------------------------------------------------------------------


def test_issue_lifecycle(monkeypatch):
    iid, body = _scenario_run(monkeypatch, "short_shipment")
    first = [i["issue_id"] for i in body["issues"]]
    listed = client.get("/api/issues", params={"inspection_id": iid}, headers=A).json()
    assert listed["total"] == len(first) and all(i["status"] == "open" for i in listed["items"])

    _run(iid, scenario="correct_shipment")
    statuses = {i["issue_id"]: i["status"] for i in client.get("/api/issues", params={"inspection_id": iid}, headers=A).json()["items"]}
    assert all(statuses[i] == "superseded" for i in first)
    assert client.get(f"/api/inspections/{iid}", headers=A).json()["open_issue_count"] == 0

    sup = client.post(f"/api/issues/{first[0]}/actions", json={"action": "resolve"}, headers=A)
    assert sup.status_code == 409 and sup.json()["error"]["code"] == "CONFLICT"

    body = _run(iid, scenario="short_shipment")
    issue_id = body["issues"][0]["issue_id"]
    act = lambda **b: client.post(f"/api/issues/{issue_id}/actions", json=b, headers=A)  # noqa: E731
    assert act(action="start_review").json()["status"] == "in_review"
    resolved = act(action="resolve", note="Supplier credited 2 units.").json()
    assert resolved["status"] == "resolved" and resolved["resolved_by"] == "op-alice" and resolved["notes"][0]["text"]
    again = act(action="resolve")
    assert again.status_code == 409
    assert act(action="reopen").json()["status"] == "open"
    assert act(action="assign", assigned_to="op-dana").json()["assigned_to"] == "op-dana"
    assert act(action="assign").status_code == 422
    assert act(action="explode").status_code == 422

    note = client.post(f"/api/issues/{issue_id}/notes", json={"text": "Called supplier"}, headers=A)
    assert note.status_code == 201 and note.json()["author"] == "op-alice"
    image_id = client.get(f"/api/inspections/{iid}", headers=A).json()["images"][0]["image_id"]
    linked = client.post(f"/api/issues/{issue_id}/evidence", json={"image_id": image_id}, headers=A).json()
    assert image_id in linked["evidence_image_ids"]
    other = _new()
    other_image = _upload(other)[0]
    assert client.post(f"/api/issues/{issue_id}/evidence", json={"image_id": other_image}, headers=A).status_code == 404
    detail = client.get(f"/api/issues/{issue_id}", headers=A).json()
    assert detail["inspection"]["inspection_id"] == iid and detail["evidence_files"][0]["evidence_id"] == image_id
    high = client.get("/api/issues", params={"severity": "high", "status": "open,in_review", "inspection_id": iid}, headers=A).json()
    assert all(i["severity"] == "high" and i["status"] in ("open", "in_review") for i in high["items"])


# --- reviews ------------------------------------------------------------------------------------


def test_review_decision_preserves_machine_verdict(monkeypatch):
    iid, body = _scenario_run(monkeypatch, "ambiguous")
    task_id = body["review_task"]["task_id"]
    machine_checks = body["record"]["checks"]
    denied = client.post(f"/api/reviews/{task_id}/decision", json={"decision": "PASS", "note": "Looks fine"}, headers=A)
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "FORBIDDEN"

    r = client.post(f"/api/reviews/{task_id}/decision", json={"decision": "FAIL", "note": "Label unreadable on dock too."}, headers=A)
    assert r.status_code == 200, r.text
    task = r.json()
    assert task["status"] == "completed" and task["human_decision"] == "FAIL" and task["machine_verdict"] == "UNCERTAIN"
    assert task["decided_by"] == "op-alice"
    record = task["record"]
    assert record["outcome"]["decision"] == "REJECT" and record["checks"] == machine_checks
    assert record["overrides"][-1]["to_verdict"] == "EXCEPTION" and record["overrides"][-1]["from_verdict"] == "UNCERTAIN"
    assert client.get(f"/api/inspections/{iid}/verify", headers=A).json()["integrity_verified"] is True
    assert client.post(f"/api/reviews/{task_id}/decision", json={"decision": "FAIL", "note": "x"}, headers=A).status_code == 409
    detail = client.get(f"/api/reviews/{task_id}", headers=A).json()
    assert detail["inspection"]["verdict"] == "FAIL"

    iid, body = _scenario_run(monkeypatch, "ambiguous")
    ok = client.post(f"/api/reviews/{body['review_task']['task_id']}/decision",
                     json={"decision": "PASS", "note": "Verified by hand."}, headers=A_APPROVER)
    assert ok.status_code == 200 and ok.json()["record"]["outcome"]["decision"] == "ACCEPT"


def test_request_evidence_flow_and_manual_review(monkeypatch):
    iid, body = _scenario_run(monkeypatch, "ambiguous")
    task_id = body["review_task"]["task_id"]
    r = client.post(f"/api/reviews/{task_id}/request-evidence", json={"note": "Photograph the label close up."}, headers=A)
    assert r.status_code == 200 and r.json()["status"] == "evidence_requested"
    queue = client.get("/api/reviews", params={"status": "open,evidence_requested"}, headers=A).json()
    assert task_id in {t["task_id"] for t in queue["items"]}
    _upload(iid, view="label")
    rerun = _run(iid, scenario="ambiguous")
    assert rerun["review_task"]["task_id"] == task_id and rerun["review_task"]["status"] == "open"
    assert client.post(f"/api/reviews/{task_id}/notes", json={"text": "New photo uploaded"}, headers=A).status_code == 201
    assert client.post(f"/api/reviews/{task_id}/assign", json={"assigned_to": "sup-bob"}, headers=A).json()["assigned_to"] == "sup-bob"

    # A decisive re-run cancels the automatic task.
    done = _run(iid, scenario="correct_shipment")
    assert done["review_task"] is None
    assert client.get(f"/api/reviews/{task_id}", headers=A).json()["status"] == "cancelled"

    manual = client.post(f"/api/inspections/{iid}/review", json={"reason": "Customer complaint on this lot"}, headers=A)
    assert manual.status_code == 201 and manual.json()["trigger"] == "manual" and manual.json()["machine_verdict"] == "PASS"
    assert client.post(f"/api/inspections/{iid}/review", json={"reason": "again"}, headers=A).status_code == 409
    over = client.post(f"/api/inspections/{iid}/override", json={"decision": "EXCEPTION", "reason": "Lot recalled"}, headers=A).json()
    assert over["review_task"]["status"] == "completed"
    task = client.get(f"/api/reviews/{manual.json()['task_id']}", headers=A).json()
    assert task["resolution"] == "overridden" and task["human_decision"] == "FAIL"


# --- evidence, notes, audit ---------------------------------------------------------------------


def test_evidence_listing_and_detail(monkeypatch):
    _demo(monkeypatch)
    iid = _new()
    image_id = _upload(iid, view="carton")[0]
    item = client.get(f"/api/evidence/{image_id}", headers=A).json()
    assert item["analysis_status"] == "not_analyzed" and item["source"] == "upload" and item["file_type"] == "image/png"
    assert item["uploaded_by"] == "op-alice" and item["provenance"]["request_id"].startswith("req-")
    _run(iid, scenario="damaged_carton")
    item = client.get(f"/api/evidence/{image_id}", headers=A).json()
    assert item["analysis_status"] == "analyzed" and "carton_damage" in item["linked_checks"] and item["readings"]
    assert item["linked_issue_ids"]
    listed = client.get("/api/evidence", params={"inspection_id": iid, "view": "carton"}, headers=A).json()
    assert [e["evidence_id"] for e in listed["items"]] == [image_id]
    assert client.get("/api/evidence/IMG-NOPE", headers=A).status_code == 404


def test_notes_and_audit_trail(monkeypatch):
    _demo(monkeypatch)
    created = client.post("/api/inspections", json={"po": PO}, headers={**A, "X-Request-ID": "req-audit-create"})
    iid = created.json()["inspection_id"]
    _upload(iid)
    _run(iid, scenario="damaged_carton")
    note = client.post(f"/api/inspections/{iid}/notes", json={"text": "Pallet wrap torn on arrival."}, headers=A)
    assert note.status_code == 201 and set(note.json()) >= {"note_id", "author", "text", "created_at"}
    client.post(f"/api/inspections/{iid}/override", json={"decision": "EXCEPTION", "reason": "Confirmed"}, headers=A)
    assert client.get(f"/api/inspections/{iid}", headers=A).json()["notes"][0]["text"] == "Pallet wrap torn on arrival."
    events = client.get(f"/api/inspections/{iid}/audit", headers=A).json()["items"]
    actions = [e["action"] for e in events]
    for expected in ("inspection.created", "evidence.uploaded", "inspection.run", "issue.created", "note.added", "inspection.overridden"):
        assert expected in actions, expected
    created_event = next(e for e in events if e["action"] == "inspection.created")
    assert created_event["request_id"] == "req-audit-create" and created_event["actor"] == "op-alice"
    assert created_event["correlation_id"] == "req-audit-create" and created_event["event_id"].startswith("AUD-")
    filtered = client.get("/api/audit", params={"action": "inspection.overridden", "inspection_id": iid}, headers=A).json()
    assert filtered["total"] == 1

    path = get_settings().database_url.removeprefix("sqlite:///")
    conn = sqlite3.connect(path)
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("UPDATE audit_events SET data = '{}'")
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("DELETE FROM audit_events")
    conn.close()


# --- exports ------------------------------------------------------------------------------------


def test_exports_json_csv_html_escape(monkeypatch):
    _demo(monkeypatch)
    evil = {**PO, "product_name": "<script>alert('x')</script>", "sku": "=HYPERLINK(\"http://evil\")"}
    iid = _new(po=evil, shipment={"shipment_id": "SHP-<b>1</b>", "supplier": "Acme & Sons"})
    _upload(iid)
    _run(iid, scenario="correct_shipment")
    client.post(f"/api/inspections/{iid}/notes", json={"text": "<img src=x onerror=alert(1)>"}, headers=A)

    r = client.get(f"/api/inspections/{iid}/export", params={"format": "json"}, headers=A)
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    body = r.json()
    assert body["inspection"]["inspection_id"] == iid and len(body["records"]) == 1 and body["audit"]

    r = client.get(f"/api/inspections/{iid}/export", params={"format": "csv"}, headers=A)
    rows = list(csv.DictReader(io.StringIO(r.text)))
    assert "attachment" in r.headers["content-disposition"] and len(rows) == 8
    assert set(rows[0]) == {"inspection_id", "po", "sku", "check_key", "verdict", "expected", "observed", "reason_code",
                            "reason", "confidence", "evidence_image_ids"}
    assert rows[0]["sku"].startswith("'=")  # formula injection neutralised

    r = client.get(f"/api/inspections/{iid}/export", params={"format": "html"}, headers=A)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    html = r.text
    assert "<script>alert" not in html and "&lt;script&gt;" in html
    assert "<img src=x" not in html and "&lt;img src=x onerror=alert(1)&gt;" in html
    assert "SHP-&lt;b&gt;1&lt;/b&gt;" in html and "Acme &amp; Sons" in html
    assert client.get(f"/api/inspections/{iid}/export", params={"format": "pdf"}, headers=A).status_code == 422


# --- catalogue, purchase orders, shipments, cartons ---------------------------------------------


def test_catalogue_import_and_po_received_quantities(monkeypatch):
    op, _, _ = _org(monkeypatch, "cat")
    r = client.post("/api/catalogue/import", json={"source": "sample"}, headers=op)
    assert r.status_code == 200, r.text
    result = r.json()
    with open(REPO_ROOT / "data" / "receiving_sample.csv", encoding="utf-8") as fh:
        sample_rows = list(csv.DictReader(fh))
    assert result["rows"] == len(sample_rows) and result["products"] > 0 and result["purchase_orders"] > 0
    product = client.get("/api/products/SKU-TOWEL-BLU", headers=op).json()
    assert product["product_name"] == "Cotton Bath Towel" and product["expected_components"] == ["towel"]
    po = client.get("/api/purchase-orders/PO-7000", headers=op).json()
    assert po["status"] == "open" and po["source"] == "catalogue"
    line = next(line for line in po["lines"] if line["sku"] == "SKU-TOWEL-BLU")
    assert line["received_quantity"] is None and line["discrepancy"] == "unverified"

    _no_vision(monkeypatch)
    insp_po = {"po_id": "PO-7000", "sku": "SKU-TOWEL-BLU", "product_name": "Cotton Bath Towel", "expected_quantity": line["expected_quantity"],
               "variant": "bath", "units_per_carton": line["units_per_carton"], "expected_cartons": line["expected_cartons"]}
    iid = _new(op, po=insp_po)
    _run(iid, op, manual_observations={"observed_quantity": line["expected_quantity"] - 4})
    po = client.get("/api/purchase-orders/PO-7000", headers=op).json()
    line = next(line for line in po["lines"] if line["sku"] == "SKU-TOWEL-BLU")
    assert line["received_quantity"] == line["expected_quantity"] - 4 and line["discrepancy"] == "short"
    assert line["inspection_ids"] == [iid] and po["status"] == "discrepancy"

    # Inspections on an unknown PO appear as a derived PO.
    _new(op, po={**PO, "po_id": "PO-ADHOC-1"})
    derived = client.get("/api/purchase-orders/PO-ADHOC-1", headers=op).json()
    assert derived["source"] == "inspections" and derived["lines"][0]["sku"] == PO["sku"]
    listed = client.get("/api/purchase-orders", params={"q": "PO-7000"}, headers=op).json()
    assert [p["po_number"] for p in listed["items"]] == ["PO-7000"]

    upload = "po_number,po_line,supplier,sku,asin,product_title,spec_colour,spec_variant,spec_components,cartons_ordered,units_per_carton_ordered,qty_ordered\n" \
             "PO-9001,1,Up Co,SKU-NEW-1,B0X,New Thing,red,large,box;manual,2,6,12\n"
    r = client.post("/api/catalogue/import", files={"file": ("cat.csv", upload.encode(), "text/csv")}, headers=op)
    assert r.json() == {"products": 1, "purchase_orders": 1, "rows": 1}
    assert client.get("/api/products/SKU-NEW-1", headers=op).json()["colour"] == "red"
    bad = client.post("/api/catalogue/import", files={"file": ("bad.csv", b"a,b\n1,2\n", "text/csv")}, headers=op)
    assert bad.status_code == 400 and "missing columns" in bad.json()["detail"]
    assert client.post("/api/catalogue/import", json={"source": "web"}, headers=op).status_code == 422
    audit = client.get("/api/audit", params={"action": "catalogue.imported"}, headers=op).json()
    assert audit["total"] == 2


def test_products_and_purchase_orders_crud(monkeypatch):
    op, _, _ = _org(monkeypatch, "crud")
    body = {"sku": "SKU-P1", "product_name": "Widget", "variant": "Blue", "units_per_carton": 6, "expected_components": ["cap"]}
    assert client.post("/api/products", json=body, headers=op).status_code == 201
    assert client.post("/api/products", json=body, headers=op).status_code == 409
    updated = client.put("/api/products/SKU-P1", json={"product_name": "Widget v2"}, headers=op).json()
    assert updated["product_name"] == "Widget v2" and updated["units_per_carton"] == 6
    assert client.put("/api/products/SKU-NONE", json={"product_name": "x"}, headers=op).status_code == 404
    assert client.get("/api/products", params={"q": "widget"}, headers=op).json()["total"] == 1
    assert client.get("/api/products/SKU-P1", headers=op).json()["inspections"] == []

    po = {"po_number": "PO-C1", "supplier": "Acme", "expected_delivery_date": "2026-10-10",
          "lines": [{"line": 1, "sku": "SKU-P1", "expected_quantity": 12, "units_per_carton": 6, "expected_cartons": 2}]}
    r = client.post("/api/purchase-orders", json=po, headers=op)
    assert r.status_code == 201 and r.json()["status"] == "open" and r.json()["lines"][0]["discrepancy"] == "unverified"
    assert client.post("/api/purchase-orders", json=po, headers=op).status_code == 409
    assert client.post("/api/purchase-orders", json={**po, "po_number": "PO-C2", "expected_delivery_date": "10/10/2026"}, headers=op).status_code == 422


def test_shipments_and_cartons(monkeypatch):
    op, _, _ = _org(monkeypatch, "ship")
    _demo(monkeypatch)
    _org(monkeypatch, "ship")
    shipment = {"shipment_id": "SHP-100", "supplier": "Acme", "asn": "ASN-1", "warehouse": "WH-1", "expected_delivery_date": "2026-10-09"}
    cartons = [{"carton_id": "C1", "expected_units": 12, "seal_condition": "intact", "visible_condition": "crushed",
                "weight_kg": 4.2, "dimensions_cm": "40x30x30"},
               {"carton_id": "C2", "expected_units": 12, "seal_condition": "intact", "visible_condition": "good"}]
    iid = _new(op, shipment=shipment, cartons=cartons)
    _upload(iid, headers=op, view="carton")
    _run(iid, op, scenario="correct_shipment", manual_observations={"observed_units_per_carton": 12})
    _new(op, shipment=shipment)
    ships = client.get("/api/shipments", headers=op).json()["items"]
    ship = next(s for s in ships if s["shipment_id"] == "SHP-100")
    assert ship["inspection_count"] == 2 and ship["verdict_counts"] == {"PASS": 0, "FAIL": 1, "UNCERTAIN": 0, "NOT_ANALYZED": 1}
    detail = client.get("/api/shipments/SHP-100", headers=op).json()
    assert len(detail["inspections"]) == 2
    assert client.get("/api/shipments/NOPE", headers=op).status_code == 404

    crushed = client.get("/api/cartons", params={"condition": "crushed"}, headers=op).json()["items"]
    assert [c["carton_id"] for c in crushed] == ["C1"]
    carton = client.get(f"/api/cartons/{iid}/C1", headers=op).json()
    assert carton["observed_units"] == 12 and carton["evidence_image_ids"] and carton["inspection_verdict"] == "FAIL"
    assert carton["shipment_id"] == "SHP-100" and carton["dimensions_cm"] == "40x30x30"
    assert client.get(f"/api/cartons/{iid}/C9", headers=op).status_code == 404


# --- dashboard and list filters -----------------------------------------------------------------


def test_dashboard_counts_and_ranges(monkeypatch):
    op, _, _ = _org(monkeypatch, "dash")
    _demo(monkeypatch)
    _org(monkeypatch, "dash")
    for scenario in ("correct_shipment", "short_shipment", "wrong_variant", "damaged_carton", "missing_component", "ambiguous"):
        iid = _new(op)
        _upload(iid, headers=op)
        _run(iid, op, scenario=scenario)
    _new(op)  # not analysed
    body = client.get("/api/dashboard", params={"range": "today"}, headers=op).json()
    t = body["totals"]
    assert t["inspections"] == 7 and t["not_analyzed"] == 1 and t["pass"] == 1 and t["fail"] == 4 and t["uncertain"] == 1
    assert t["quantity_discrepancies"] == 1 and t["variant_mismatches"] == 1 and t["damaged_cartons"] == 1
    assert t["missing_components"] == 1 and t["product_mismatches"] == 0 and t["damaged_products"] == 0
    assert t["open_reviews"] == 1 and t["open_issues"] > 0
    assert len(body["recent_inspections"]) == 7 and body["system"]["status"] in {"HEALTHY", "DEGRADED"}
    assert body["daily"][-1]["fail"] == 4 and body["issues_by_type"]
    assert len(client.get("/api/dashboard", params={"range": "7d"}, headers=op).json()["daily"]) == 7
    past = client.get("/api/dashboard", params={"range": "custom", "date_from": "2000-01-01", "date_to": "2000-01-31"}, headers=op).json()
    assert past["totals"]["inspections"] == 0 and past["range"] == {"from": "2000-01-01", "to": "2000-01-31"}
    assert client.get("/api/dashboard", params={"range": "custom"}, headers=op).status_code == 422
    assert client.get("/api/dashboard", params={"range": "year"}, headers=op).status_code == 422
    assert client.get("/api/dashboard", params={"range": "all"}, headers=op).json()["totals"]["inspections"] == 7


def test_inspection_list_filters_sort_pagination(monkeypatch):
    op, _, _ = _org(monkeypatch, "list")
    _demo(monkeypatch)
    _org(monkeypatch, "list")
    ids = {}
    for po_id, scenario in (("PO-B", "correct_shipment"), ("PO-A", "short_shipment"), ("PO-C", None)):
        iid = _new(op, po={**PO, "po_id": po_id}, shipment={"shipment_id": f"SHP-{po_id}", "supplier": "Acme"})
        if scenario:
            _upload(iid, headers=op)
            _run(iid, op, scenario=scenario)
        ids[po_id] = iid
    get = lambda **p: client.get("/api/inspections", params=p, headers=op).json()  # noqa: E731
    page = get()
    assert page["total"] == 3 and page["page"] == 1 and page["page_size"] == 25 and page["count"] == 3
    assert [i["inspection_id"] for i in get(verdict="PASS")["items"]] == [ids["PO-B"]]
    assert [i["inspection_id"] for i in get(verdict="NOT_ANALYZED")["items"]] == [ids["PO-C"]]
    assert [i["inspection_id"] for i in get(verdict="FAIL")["items"]] == [ids["PO-A"]]
    assert [i["po"]["po_id"] for i in get(sort="po_id", order="asc")["items"]] == ["PO-A", "PO-B", "PO-C"]
    second = get(sort="po_id", order="asc", page=2, page_size=1)
    assert second["count"] == 1 and second["total"] == 3 and second["items"][0]["po"]["po_id"] == "PO-B"
    assert get(q="shp-po-c")["total"] == 1 and get(shipment_id="SHP-PO-A")["total"] == 1 and get(supplier="acme")["total"] == 3
    assert [i["inspection_id"] for i in get(has_open_issues="true")["items"]] == [ids["PO-A"]]
    assert get(status="draft")["total"] == 1
    assert {i["inspection_id"] for i in get(verdict="FAIL,NOT_ANALYZED")["items"]} == {ids["PO-A"], ids["PO-C"]}
    assert client.get("/api/inspections", params={"verdict": "FAIL,MAYBE"}, headers=op).status_code == 422
    assert get(date_from="2999-01-01")["total"] == 0
    assert client.get("/api/inspections", params={"date_from": "01-01-2026"}, headers=op).status_code == 422
    assert client.get("/api/inspections", params={"page_size": 500}, headers=op).status_code == 422
    assert get(sort="verdict", order="asc")["items"][-1]["verdict"] is None  # not analysed sorts last


# --- A2A ----------------------------------------------------------------------------------------


def _env(operation, payload=None, message_id=None, **extra):
    return {"a2a_version": "cube.a2a.v1", "message_id": message_id or f"m-{os.urandom(6).hex()}",
            "correlation_id": "corr-a2a-test", "timestamp": "2026-10-08T12:00:00Z",
            "sender": {"agent_id": "prep_manager", "version": "1.2.0"}, "recipient": {"agent_id": "receiving_manager"},
            "operation": operation, "payload": payload if payload is not None else {}, **extra}


def _send(envelope, headers=A, valid_request=True):
    if isinstance(envelope, dict):
        if valid_request:
            _validate(envelope, "a2a_request.v1.schema.json")
        r = client.post("/api/agent/receive", json=envelope, headers=headers)
    else:
        r = client.post("/api/agent/receive", content=envelope, headers={**headers, "Content-Type": "application/json"})
    assert r.status_code == 200, r.text
    _validate(r.json(), "a2a_response.v1.schema.json")
    return r


def _inspect_payload(**extra):
    return {"po": PO, "images": [{"view": "carton", "filename": "c.png", "content_base64": base64.b64encode(_png_bytes()).decode()}],
            **extra}


def test_agent_card_public_and_schema(monkeypatch):
    _demo(monkeypatch)
    card = client.get("/.well-known/agent.json").json()
    _validate(card, "agent_card.v1.schema.json")
    assert card["agent_id"] == "receiving_manager" and card["endpoint"] == "/api/agent/receive"
    assert {o["operation"] for o in card["operations"]} == {"receiving.inspect", "receiving.get_record", "receiving.verify_record", "agent.ping"}
    assert card["status"]["vision_provider"] == "demo"
    assert client.get("/api/agent/capabilities", headers=A).json()["operations"] == card["operations"]
    assert client.get("/api/agent/capabilities").status_code == 401
    for name in ("a2a_request.v1.schema.json", "a2a_response.v1.schema.json", "agent_card.v1.schema.json", "receiving_record.v1.schema.json"):
        jsonschema.Draft202012Validator.check_schema(_schema(name))


def test_a2a_ping_inspect_get_verify(monkeypatch):
    _demo(monkeypatch)
    r = _send(_env("agent.ping"))
    body = r.json()
    assert body["status"] == "completed" and body["result"]["pong"] is True and body["error"] is None
    assert body["correlation_id"] == "corr-a2a-test" == r.headers["x-correlation-id"]
    assert body["request_id"] == r.headers["x-request-id"] and body["sender"]["agent_id"] == "receiving_manager"

    r = _send(_env("receiving.inspect", _inspect_payload(scenario="correct_shipment",
                                                          shipment={"shipment_id": "SHP-A2A", "supplier": "Acme"},
                                                          cartons=[{"carton_id": "C1", "seal_condition": "intact", "visible_condition": "good"}])))
    result = r.json()["result"]
    assert result["verdict"] == "PASS" and result["decision"] == "ACCEPT" and result["prep_hold"] is False
    assert result["review_task_id"] is None and result["issues"] == []
    _validate(result["record"], "receiving_record.v1.schema.json")
    iid = result["inspection_id"]
    view = client.get(f"/api/inspections/{iid}", headers=A).json()
    assert view["channel"] == "a2a" and view["evidence_files"][0]["source"] == "a2a"
    assert view["evidence_files"][0]["provenance"]["channel"] == "a2a"

    got = _send(_env("receiving.get_record", {"inspection_id": iid})).json()
    assert got["result"]["record"]["record_id"] == result["record"]["record_id"] and got["result"]["verdict"] == "PASS"
    verified = _send(_env("receiving.verify_record", {"inspection_id": iid})).json()
    assert verified["result"]["integrity_verified"] is True

    failed = _send(_env("receiving.inspect", _inspect_payload(scenario="short_shipment"))).json()["result"]
    assert failed["verdict"] == "FAIL" and failed["decision"] == "REJECT" and failed["issues"]

    activity = client.get("/api/agent/activity", params={"operation": "receiving.inspect", "direction": "inbound"}, headers=A).json()
    stored = json.dumps(activity["items"][0]["request"])
    assert "<stripped" in stored and base64.b64encode(_png_bytes()).decode() not in stored
    detail = client.get(f"/api/agent/activity/{activity['items'][0]['request_id']}", headers=A).json()
    assert detail["direction"] == "inbound" and detail["agent"] == "prep_manager"


def test_a2a_vision_unavailable_never_passes(monkeypatch):
    _no_vision(monkeypatch)
    result = _send(_env("receiving.inspect", _inspect_payload())).json()["result"]
    assert result["verdict"] == "UNCERTAIN" and result["decision"] == "PENDING_REVIEW" and result["prep_hold"] is True
    assert result["review_task_id"].startswith("REV-") and result["record"]["status"] == "pending"


def test_a2a_protocol_errors(monkeypatch):
    _demo(monkeypatch)
    body = _send(_env("receiving.teleport"), valid_request=False).json()
    assert body["status"] == "failed" and body["error"]["code"] == "UNSUPPORTED_OPERATION" and body["result"] is None
    body = _send({k: v for k, v in _env("agent.ping").items() if k != "a2a_version"}, valid_request=False).json()
    assert body["error"]["code"] == "VALIDATION_ERROR" and "a2a_version" in body["error"]["message"]
    body = _send(b"{not json").json()
    assert body["error"]["code"] == "VALIDATION_ERROR" and body["in_reply_to"] is None
    body = _send(_env("agent.ping", recipient={"agent_id": "someone_else"}), valid_request=False).json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    body = _send(_env("receiving.get_record", {"inspection_id": "INS-NOPE"})).json()
    assert body["error"]["code"] == "NOT_FOUND"
    body = _send(_env("receiving.get_record", {}), valid_request=False).json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    bad_image = _inspect_payload()
    bad_image["images"][0]["content_base64"] = base64.b64encode(b"not an image at all").decode()
    body = _send(_env("receiving.inspect", bad_image)).json()
    assert body["error"]["code"] == "VALIDATION_ERROR" and body["error"]["details"]["image_index"] == 0
    bad_image["images"][0]["content_base64"] = "%%%not-base64%%%"
    assert _send(_env("receiving.inspect", bad_image)).json()["error"]["code"] == "VALIDATION_ERROR"
    assert _send(_env("receiving.inspect", {"po": PO, "images": []}), valid_request=False).json()["error"]["code"] == "VALIDATION_ERROR"
    wrong_ext = _inspect_payload()
    wrong_ext["images"][0]["filename"] = "c.jpg"  # PNG bytes with a .jpg name: same check as multipart
    assert _send(_env("receiving.inspect", wrong_ext)).json()["error"]["code"] == "VALIDATION_ERROR"

    r = client.post("/api/agent/receive", json=_env("agent.ping"))
    assert r.status_code == 401 and r.json()["error"]["code"] == "UNAUTHORIZED"
    r = client.post("/api/agent/receive", json=_env("agent.ping"), headers={"X-API-Key": "nope"})
    assert r.status_code == 401


def test_a2a_idempotent_replay(monkeypatch):
    _demo(monkeypatch)
    envelope = _env("receiving.inspect", _inspect_payload(scenario="correct_shipment"), message_id="msg-idem-1")
    first = _send(envelope)
    second = _send(envelope)
    assert second.json() == first.json() and second.headers.get("x-idempotent-replay") == "true"
    iid = first.json()["result"]["inspection_id"]
    matching = [i for i in client.get("/api/inspections", params={"page_size": 200}, headers=A).json()["items"] if i["inspection_id"] == iid]
    assert len(matching) == 1
    inbound = client.get("/api/agent/activity", params={"agent": "prep_manager", "operation": "receiving.inspect"}, headers=A).json()["items"]
    assert sum(1 for a in inbound if a["message_id"] == "msg-idem-1") == 1
    # Same message id from another sender is a different message.
    other = {**envelope, "sender": {"agent_id": "recovery_manager"}}
    assert _send(other).json()["result"]["inspection_id"] != iid
    # The key is per tenant: org-b replaying org-a's message id gets its own processing.
    assert _send(_env("agent.ping", message_id="msg-idem-1"), headers=B).json()["result"]["pong"] is True


def test_handoff_not_configured_delivered_and_failed(monkeypatch):
    _demo(monkeypatch, A2A_PEERS=None)
    iid = _new()
    assert client.post(f"/api/inspections/{iid}/handoff", json={"target_agent": "prep_manager"}, headers=A).status_code == 409
    _upload(iid)
    _run(iid, scenario="damaged_carton")
    r = client.post(f"/api/inspections/{iid}/handoff", json={"target_agent": "prep_manager"}, headers=A)
    act = r.json()
    assert r.status_code == 200 and act["status"] == "not_configured" and act["direction"] == "outbound"
    assert act["request"]["operation"] == "receiving.record_available" and act["request"]["payload"]["prep_hold"] is True
    _validate(act["request"], "a2a_request.v1.schema.json")
    assert client.post(f"/api/inspections/{iid}/handoff", json={"target_agent": "skynet"}, headers=A).status_code == 422

    sent = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.update(url=url, json=json, headers=headers, timeout=timeout)
        return httpx.Response(200, json={"a2a_version": "cube.a2a.v1", "status": "completed", "result": {"ok": True}},
                              request=httpx.Request("POST", url))

    _demo(monkeypatch, A2A_PEERS=json.dumps({"prep_manager": {"url": "https://prep.example/api/agent/receive", "api_key": "peer-key"}}))
    monkeypatch.setattr(a2a_service.httpx, "post", fake_post)
    act = client.post(f"/api/inspections/{iid}/handoff", json={"target_agent": "prep_manager"}, headers={**A, "X-Correlation-ID": "corr-hand"}).json()
    assert act["status"] == "delivered" and act["http_status"] == 200 and act["response"]["result"] == {"ok": True}
    assert sent["url"] == "https://prep.example/api/agent/receive" and sent["timeout"] == 10.0
    assert sent["headers"]["X-API-Key"] == "peer-key" and sent["json"]["correlation_id"] == "corr-hand"
    assert sent["json"]["payload"]["record"]["record_id"]

    def failing_post(url, **kwargs):
        raise httpx.ConnectError("connection refused to https://prep.example/x")

    monkeypatch.setattr(a2a_service.httpx, "post", failing_post)
    act = client.post(f"/api/inspections/{iid}/handoff", json={"target_agent": "prep_manager"}, headers=A).json()
    assert act["status"] == "failed" and "ConnectError" in act["error"] and "prep.example" not in act["error"]
    outbound = client.get("/api/agent/activity", params={"direction": "outbound"}, headers=A).json()["items"]
    assert {"not_configured", "delivered", "failed"} <= {a["status"] for a in outbound}
    assert "a2a.handoff" in [e["action"] for e in client.get(f"/api/inspections/{iid}/audit", headers=A).json()["items"]]


# --- tenancy ------------------------------------------------------------------------------------


def test_cross_tenant_isolation_on_new_routes(monkeypatch):
    iid, body = _scenario_run(monkeypatch, "ambiguous")
    issue_id = body["issues"][0]["issue_id"]
    task_id = body["review_task"]["task_id"]
    image_id = client.get(f"/api/inspections/{iid}", headers=A).json()["images"][0]["image_id"]
    client.post("/api/products", json={"sku": "SKU-SECRET-A", "product_name": "Secret"}, headers=A)
    for path in (f"/api/issues/{issue_id}", f"/api/reviews/{task_id}", f"/api/evidence/{image_id}",
                 f"/api/inspections/{iid}/export", f"/api/inspections/{iid}/audit", "/api/products/SKU-SECRET-A",
                 f"/api/purchase-orders/{PO['po_id']}"):
        assert client.get(path, headers=B).status_code == 404, path
    for path, payload in ((f"/api/issues/{issue_id}/actions", {"action": "resolve"}),
                          (f"/api/reviews/{task_id}/decision", {"decision": "FAIL", "note": "x"}),
                          (f"/api/inspections/{iid}/notes", {"text": "x"}),
                          (f"/api/inspections/{iid}/handoff", {"target_agent": "prep_manager"}),
                          (f"/api/inspections/{iid}/review", {"reason": "x"})):
        assert client.post(path, json=payload, headers=B).status_code == 404, path
    for path in ("/api/issues", "/api/reviews", "/api/evidence", "/api/audit", "/api/agent/activity"):
        items = client.get(path, params={"page_size": 200}, headers=B).json()["items"]
        assert iid not in json.dumps(items), path
    assert client.get("/api/dashboard", params={"range": "all"}, headers=B).json()["recent_inspections"] == [] or \
        iid not in json.dumps(client.get("/api/dashboard", params={"range": "all"}, headers=B).json())
    body = _send(_env("receiving.get_record", {"inspection_id": iid}), headers=B).json()
    assert body["error"]["code"] == "NOT_FOUND"


def test_agent_role_cannot_finalise_pass(monkeypatch):
    _, _, agent = _org(monkeypatch, "agentrole")
    _demo(monkeypatch)
    _org(monkeypatch, "agentrole")
    iid = _new(agent)
    _upload(iid, headers=agent)
    _run(iid, agent, scenario="ambiguous")
    r = client.post(f"/api/inspections/{iid}/override", json={"decision": "PASS", "reason": "agent says ok"}, headers=agent)
    assert r.status_code == 403
    assert client.get("/api/system/info", headers=agent).json()["principal"]["role"] == "agent"


def test_existing_database_without_new_tables_is_upgraded(tmp_path, monkeypatch):
    """Schema creation is idempotent on a pre-platform database (old inspection rows still load)."""
    from backend.app.database import repository as repo_module

    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(repo_module.SCHEMA)
    old_row = {"inspection_id": "INS-OLD1", "organization_id": "org-a", "po": PO, "images": [], "observations": [],
               "evidence": [], "checks": [], "final_decision": "UNCERTAIN", "override_decision": None, "override_reason": None,
               "agent_summary": "", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
               "status": "draft", "prep_hold": True}
    conn.execute("INSERT INTO inspections VALUES (?, ?, ?)", ("INS-OLD1", "org-a", json.dumps(old_row)))
    conn.commit()
    conn.close()
    _set_env(monkeypatch, DATABASE_URL=f"sqlite:///{Path(db).as_posix()}")
    ok, message = repo_module.schema_ok()
    assert ok, message
    loaded = repo_module.InspectionRepository().get("org-a", "INS-OLD1")
    assert loaded.shipment is None and loaded.cartons == [] and loaded.channel == "api"
    with sqlite3.connect(db) as check:
        assert check.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"


def test_issue_filters_accept_comma_separated_values(monkeypatch):
    op, _, _ = _org(monkeypatch, "isscsv")
    _demo(monkeypatch)
    _org(monkeypatch, "isscsv")
    iid = _new(op, cartons=[{"carton_id": "C1", "seal_condition": "broken"}])
    _upload(iid, headers=op)
    _run(iid, op, scenario="damaged_carton")
    get = lambda **p: client.get("/api/issues", params=p, headers=op).json()  # noqa: E731
    damaged = get(issue_type="DAMAGE_VISIBLE,CARTON_CONDITION_REPORTED")
    assert {i["issue_type"] for i in damaged["items"]} == {"DAMAGE_VISIBLE", "CARTON_CONDITION_REPORTED"}
    totals = client.get("/api/dashboard", params={"range": "today"}, headers=op).json()["totals"]
    assert damaged["total"] == 2 and totals["damaged_cartons"] == 1  # count is per inspection, issues per check
    assert get(severity="high,medium")["total"] == get()["total"]
    assert get(status="open,in_review", severity="high")["total"] == 2
    assert get(issue_type="DAMAGE_VISIBLE")["total"] == 1
