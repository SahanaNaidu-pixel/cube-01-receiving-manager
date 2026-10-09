import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import types

_TMP = tempfile.mkdtemp(prefix="rcv-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["UPLOAD_ROOT_DIR"] = f"{_TMP}/uploads"
os.environ["RECEIVING_SEAL_KEY"] = "test-seal-key"
os.environ["RECEIVING_DISABLE_DOTENV"] = "1"  # never pick up a developer .env
os.environ["RECEIVING_API_KEYS"] = json.dumps({
    "key-a-op": {"organization_id": "org-a", "operator_id": "op-alice", "role": "operator"},
    "key-a-appr": {"organization_id": "org-a", "operator_id": "sup-bob", "role": "approver"},
    "key-b-op": {"organization_id": "org-b", "operator_id": "op-carol", "role": "operator"},
})

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from backend.app.core.config import get_settings  # noqa: E402
from backend.app.core.decision_engine import (  # noqa: E402
    evaluate_component_check,
    evaluate_inspection,
    evaluate_total_quantity_check,
)
from backend.app.main import app  # noqa: E402
from backend.app.models.inspection import Inspection, InspectionCheck, ReceivingImage  # noqa: E402
from backend.app.models.po import PurchaseOrder  # noqa: E402
from backend.app.services.evidence_record import compute_hash  # noqa: E402
from backend.app.services.vision import VisionAnalysisResponse, VisionService  # noqa: E402

get_settings.cache_clear()
client = TestClient(app)
A = {"X-API-Key": "key-a-op"}
A_APPROVER = {"X-API-Key": "key-a-appr"}
B = {"X-API-Key": "key-b-op"}
PO = {
    "po_id": "PO-1001",
    "sku": "BLUE-BOTTLE-001",
    "product_name": "Blue Bottle",
    "expected_quantity": 24,
    "variant": "Blue",
    "units_per_carton": 12,
    "expected_cartons": 2,
    "expected_components": ["cap", "label"],
}


@pytest.fixture(autouse=True)
def _fresh_settings():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()  # monkeypatch has restored env; drop settings cached from the patched env


def _png_bytes() -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"


def _jpeg_bytes() -> bytes:
    return b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xdb\x00C\x00" + b"\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\xff\xc0\x00\x11\x08\x00\x01\x00\x01\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01\xff\xc4\x00\x14\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\xff\xc4\x00\x14\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\x3f"


def _create_inspection(po=None, headers=A):
    response = client.post("/api/inspections", json={"po": po or PO}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def _upload(inspection_id, n=1, headers=A, view="carton"):
    files = [("files", (f"p{i}.png", _png_bytes(), "image/png")) for i in range(n)]
    response = client.post(f"/api/inspections/{inspection_id}/images", files=files, data={"image_type": view}, headers=headers)
    assert response.status_code == 200, response.text
    return [img["image_id"] for img in response.json()["images"]]


def _set_env(monkeypatch, **values):
    for key, value in values.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    get_settings.cache_clear()


def _service(images=("IMG-1", "IMG-2"), po=None):
    inspection = Inspection(
        inspection_id="INS-T",
        organization_id="org-a",
        po=PurchaseOrder(**(po or PO)),
        images=[ReceivingImage(image_id=i, inspection_id="INS-T", filename="x.png", stored_filename="x.png", image_path="x") for i in images],
    )
    return VisionService(inspection)


def _obs(check_type, observation, confidence=0.95):
    return {"check_type": check_type, "observation": observation, "confidence": confidence, "description": "t"}


CLEAN = [
    _obs("sku", "BLUE-BOTTLE-001"), _obs("quantity", 24), _obs("carton", 2), _obs("units_per_carton", 12),
    _obs("variant", "Blue"), _obs("damage", "none"), _obs("components", ["cap", "label"]),
]


def _run(images_payload, po=None):
    service = _service(po=po)
    payload = VisionAnalysisResponse.model_validate({"images": images_payload})
    result = service._build_result(service._validate_payload(payload))
    return result["decision"], {c["check_name"]: c for c in result["checks"]}


# --- basics -----------------------------------------------------------------------------------


def test_health_endpoint_is_public():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_cors_headers_are_enabled_for_allowed_origin():
    response = client.options("/api/health", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_create_and_retrieve_inspection():
    data = _create_inspection()
    assert data["organization_id"] == "org-a"
    response = client.get(f"/api/inspections/{data['inspection_id']}", headers=A)
    assert response.status_code == 200
    assert response.json()["inspection_id"] == data["inspection_id"]


def test_client_cannot_inject_image_records():
    fake = {"image_id": "IMG-X", "inspection_id": "x", "filename": "a.png", "stored_filename": "a.png", "image_path": "/etc/passwd"}
    response = client.post("/api/inspections", json={"po": PO, "images": [fake]}, headers=A)
    assert response.status_code == 400


def test_invalid_quantity():
    response = client.post("/api/inspections", json={"po": {**PO, "expected_quantity": -1}}, headers=A)
    assert response.status_code in {400, 422}


def test_invalid_confidence():
    with pytest.raises(ValidationError):
        InspectionCheck(check_name="quantity_check", status="PASS", reason="ok", confidence=1.5)


def test_overall_decision_rules():
    assert evaluate_inspection([{"status": "PASS"}, {"status": "NOT_REQUIRED"}]) == "PASS"
    assert evaluate_inspection([{"status": "PASS"}, {"status": "FAIL"}]) == "EXCEPTION"
    assert evaluate_inspection([{"status": "PASS"}, {"status": "UNCERTAIN"}]) == "UNCERTAIN"
    assert evaluate_inspection([]) == "UNCERTAIN"


# --- auth and tenancy -------------------------------------------------------------------------


def test_requests_without_or_with_bad_key_are_rejected():
    assert client.get("/api/inspections").status_code == 401
    assert client.get("/api/inspections", headers={"X-API-Key": "nope"}).status_code == 401


def test_auth_fails_closed_when_unconfigured(monkeypatch):
    _set_env(monkeypatch, RECEIVING_API_KEYS="")
    assert client.get("/api/inspections", headers=A).status_code == 503
    _set_env(monkeypatch, RECEIVING_API_KEYS=os.environ["RECEIVING_API_KEYS"])


def test_tenants_cannot_see_each_other():
    mine = _create_inspection()
    image_id = _upload(mine["inspection_id"])[0]
    assert client.get(f"/api/inspections/{mine['inspection_id']}", headers=B).status_code == 404
    assert client.get(f"/api/inspections/{mine['inspection_id']}/images/{image_id}", headers=B).status_code == 404
    assert client.post(f"/api/inspections/{mine['inspection_id']}/analyze", headers=B).status_code == 404
    listed = client.get("/api/inspections", headers=B).json()["items"]
    assert all(item["organization_id"] == "org-b" for item in listed)
    assert mine["inspection_id"] not in {item["inspection_id"] for item in listed}


# --- uploads ----------------------------------------------------------------------------------


def test_valid_jpeg_upload_records_digest_and_retrieves():
    inspection = _create_inspection()
    response = client.post(f"/api/inspections/{inspection['inspection_id']}/images", files=[("files", ("photo.jpg", _jpeg_bytes(), "image/jpeg"))], headers=A)
    assert response.status_code == 200
    image = response.json()["images"][0]
    assert image["sha256_digest"] == hashlib.sha256(_jpeg_bytes()).hexdigest()
    assert "image_path" not in image
    retrieval = client.get(f"/api/inspections/{inspection['inspection_id']}/images/{image['image_id']}", headers=A)
    assert retrieval.status_code == 200
    assert retrieval.headers["content-type"].startswith("image/jpeg")


def test_upload_rejections():
    iid = _create_inspection()["inspection_id"]
    url = f"/api/inspections/{iid}/images"
    assert client.post(url, files=[("files", ("bad.txt", b"hello", "text/plain"))], headers=A).status_code == 400
    assert client.post(url, files=[("files", ("empty.jpg", b"", "image/jpeg"))], headers=A).status_code == 400
    assert client.post(url, files=[("files", ("huge.jpg", b"x" * (11 * 1024 * 1024), "image/jpeg"))], headers=A).status_code == 413
    assert client.post(url, files=[("files", ("not_real.png", b"this is not an image", "image/png"))], headers=A).status_code == 400
    assert client.post("/api/inspections/missing/images", files=[("files", ("u.png", _png_bytes(), "image/png"))], headers=A).status_code == 404
    assert client.get(f"/api/inspections/{iid}/images/IMG-DOES-NOT-EXIST", headers=A).status_code == 404


def test_image_belongs_to_different_inspection_fails():
    first = _create_inspection()["inspection_id"]
    second = _create_inspection()["inspection_id"]
    image_id = _upload(first)[0]
    assert client.get(f"/api/inspections/{second}/images/{image_id}", headers=A).status_code == 404


def test_max_image_count_enforced(monkeypatch):
    _set_env(monkeypatch, UPLOAD_MAX_IMAGES="2")
    iid = _create_inspection()["inspection_id"]
    files = [("files", (f"{n}.png", _png_bytes(), "image/png")) for n in range(3)]
    assert client.post(f"/api/inspections/{iid}/images", files=files, headers=A).status_code == 400
    _set_env(monkeypatch, UPLOAD_MAX_IMAGES=None)


# --- vision fusion: every photo counts, unseen is never OK ----------------------------------------


def test_clean_multi_photo_passes():
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN}])
    assert decision == "PASS", checks


def test_damage_seen_only_on_second_photo_fails():
    decision, checks = _run([
        {"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("damage", ["crushing"])]},
    ])
    assert checks["damage_check"]["status"] == "FAIL"
    assert decision == "EXCEPTION"


def test_photos_disagreeing_on_sku_gives_uncertain():
    decision, checks = _run([
        {"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("sku", "RED-BOTTLE-002")]},
    ])
    assert checks["sku_check"]["status"] == "UNCERTAIN"
    assert checks["sku_check"]["reason_code"] == "VIEWS_DISAGREE"
    assert decision == "UNCERTAIN"


def test_value_read_on_any_photo_is_used():
    no_sku = [o for o in CLEAN if o["check_type"] != "sku"]
    _, checks = _run([
        {"image_id": "IMG-1", "visibility": "clear", "observations": no_sku},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("sku", "BLUE-BOTTLE-001")]},
    ])
    assert checks["sku_check"]["status"] == "PASS"


def test_missing_carton_count_is_uncertain_not_po_value():
    obs = [o for o in CLEAN if o["check_type"] not in {"carton", "quantity"}]
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert checks["carton_check"]["status"] == "UNCERTAIN"
    assert checks["carton_check"]["observed_value"] is None
    assert checks["quantity_check"]["status"] == "UNCERTAIN"
    assert decision == "UNCERTAIN"


def test_uncertain_or_low_confidence_damage_is_uncertain():
    for damage in (_obs("damage", "uncertain"), _obs("damage", "none", confidence=0.3), _obs("damage", None)):
        obs = [o for o in CLEAN if o["check_type"] != "damage"] + [damage]
        _, checks = _run([{"image_id": "IMG-1", "visibility": "blurred", "observations": obs}])
        assert checks["damage_check"]["status"] == "UNCERTAIN", damage


def test_no_damage_reading_at_all_is_uncertain():
    obs = [o for o in CLEAN if o["check_type"] != "damage"]
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert checks["damage_check"]["status"] == "UNCERTAIN"


def test_damage_as_list_or_string_does_not_crash():
    for damage in (["tear", "wet"], "tear", ["none"], []):
        obs = [o for o in CLEAN if o["check_type"] != "damage"] + [_obs("damage", damage)]
        _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
        assert checks["damage_check"]["status"] in {"FAIL", "PASS", "UNCERTAIN"}
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": [_obs("damage", ["tear", "wet"])]}])
    assert checks["damage_check"]["status"] == "FAIL"


def test_quantity_checks_cartons_units_per_carton_and_total_separately():
    obs = [o for o in CLEAN if o["check_type"] not in {"units_per_carton", "quantity"}] + [_obs("units_per_carton", 10), _obs("quantity", 20)]
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert checks["carton_check"]["status"] == "PASS"
    assert checks["units_per_carton_check"]["status"] == "FAIL"
    assert checks["quantity_check"]["status"] == "FAIL"

    po = PurchaseOrder(**PO)
    assert evaluate_total_quantity_check(po, None, 2, 12)["status"] == "PASS"  # derived from counted cartons
    assert evaluate_total_quantity_check(po, None, None, None)["status"] == "UNCERTAIN"
    assert evaluate_total_quantity_check(po, 24, 2, 11)["status"] == "UNCERTAIN"  # readings disagree
    assert evaluate_total_quantity_check(PurchaseOrder(**{**PO, "expected_quantity": 25}), 25, None, None)["status"] == "UNCERTAIN"


def test_components():
    assert evaluate_component_check([], [])["status"] == "NOT_REQUIRED"
    assert evaluate_component_check(["cap"], [])["status"] == "UNCERTAIN"
    assert evaluate_component_check(["cap"], [], ["cap"])["status"] == "FAIL"
    assert evaluate_component_check(["cap"], ["Cap"])["status"] == "PASS"
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN}], po={**PO, "expected_components": []})
    assert checks["component_check"]["status"] == "NOT_REQUIRED"
    assert decision == "PASS"


def test_unknown_image_id_from_model_is_rejected():
    service = _service()
    payload = VisionAnalysisResponse.model_validate({"images": [{"image_id": "IMG-FAKE", "visibility": "clear", "observations": CLEAN}]})
    with pytest.raises(ValueError):
        service._validate_payload(payload)


# --- OpenAI Responses API call shape -----------------------------------------------------------


class _FakeResponses:
    calls = []
    reply = None
    error = None

    def create(self, **kwargs):
        _FakeResponses.calls.append(kwargs)
        if _FakeResponses.error:
            raise _FakeResponses.error
        return types.SimpleNamespace(status="completed", model="gpt-test-2026", output_text=json.dumps(_FakeResponses.reply))


class _FakeOpenAI:
    init_kwargs = {}

    def __init__(self, **kwargs):
        _FakeOpenAI.init_kwargs = kwargs
        self.responses = _FakeResponses()


def _fake_openai(monkeypatch, reply=None, error=None):
    _FakeResponses.calls, _FakeResponses.reply, _FakeResponses.error = [], reply, error
    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=_FakeOpenAI))
    _set_env(monkeypatch, AI_API_KEY="sk-test", DEMO_MODE="false")


def test_live_call_uses_responses_text_format_and_image_ids(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid, n=2)
    _fake_openai(monkeypatch, reply={"images": [
        {"image_id": ids[0], "visibility": "clear", "observations": CLEAN},
        {"image_id": ids[1], "visibility": "clear", "observations": [_obs("damage", "none")]},
    ]})
    response = client.post(f"/api/inspections/{iid}/analyze", headers=A)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["decision"] == "PASS"
    assert body["record"]["checks"][0]["model_version"] == "gpt-test-2026"

    kwargs = _FakeResponses.calls[0]
    assert "response_format" not in kwargs
    assert kwargs["text"]["format"]["type"] == "json_schema"
    assert kwargs["text"]["format"]["strict"] is True
    texts = " ".join(part.get("text", "") for part in kwargs["input"][0]["content"])
    assert ids[0] in texts and ids[1] in texts
    assert "BLUE-BOTTLE-001" not in texts  # blind read: PO values never reach the model
    assert _FakeOpenAI.init_kwargs["timeout"] == 45 and _FakeOpenAI.init_kwargs["max_retries"] == 1


def test_model_inventing_image_id_goes_to_pending_review(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    _fake_openai(monkeypatch, reply={"images": [{"image_id": "IMG-INVENTED", "visibility": "clear", "observations": CLEAN}]})
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PENDING_REVIEW"
    assert body["record"]["outcome"]["prep_hold"] is True


def test_model_timeout_goes_to_pending_review(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    _fake_openai(monkeypatch, error=TimeoutError("read timed out"))
    response = client.post(f"/api/inspections/{iid}/analyze", headers=A)
    assert response.status_code == 200
    body = response.json()
    assert body["decision"] == "PENDING_REVIEW"
    assert "TimeoutError" in body["failure_reason"]
    assert all(c["status"] == "UNCERTAIN" for c in body["checks"])


def test_missing_api_key_goes_to_pending_review(monkeypatch):
    _set_env(monkeypatch, AI_API_KEY=None, OPENAI_API_KEY=None, DEMO_MODE=None)
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    response = client.post(f"/api/inspections/{iid}/analyze", headers=A)
    assert response.status_code == 200
    body = response.json()
    assert body["decision"] == "PENDING_REVIEW"
    assert body["record"]["outcome"]["decision"] == "PENDING_REVIEW"
    assert "PERCEPTION_UNAVAILABLE" in body["record"]["outcome"]["hold_reasons"]


# --- demo mode -------------------------------------------------------------------------------


def test_demo_mode_with_uploaded_photos_uses_real_image_ids(monkeypatch):
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None)
    iid = _create_inspection()["inspection_id"]
    image_id = _upload(iid)[0]
    response = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "correct_shipment"}, headers=A)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["decision"] == "PASS"
    assert {e["image_id"] for e in body["evidence"]} == {image_id}
    short = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "short_shipment"}, headers=A).json()
    assert short["decision"] == "EXCEPTION"
    _set_env(monkeypatch, DEMO_MODE=None)


# --- sealed record, overrides, verify ---------------------------------------------------------


def _analyzed(monkeypatch, scenario="damaged_carton"):
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None)
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    body = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": scenario}, headers=A).json()
    return iid, body


def test_record_follows_contract(monkeypatch):
    iid, body = _analyzed(monkeypatch)
    record = body["record"]
    for field in ("record_id", "schema_version", "organization_id", "subject", "images", "checks", "outcome", "overrides", "status", "content_hash", "seal", "created_at"):
        assert field in record, field
    assert record["schema_version"] == "receiving_record.v1"
    assert record["created_at"].endswith("Z")
    assert record["subject"]["po_number"] == "PO-1001"
    assert record["images"][0]["sha256_digest"] == hashlib.sha256(_png_bytes()).hexdigest()
    assert record["outcome"]["decision"] == "REJECT"
    assert record["outcome"]["prep_hold"] is True
    assert record["content_hash"] == compute_hash(record)
    assert client.get(f"/api/inspections/{iid}/verify", headers=A).json()["integrity_verified"] is True


def test_operator_cannot_override_to_pass_but_approver_can(monkeypatch):
    iid, _ = _analyzed(monkeypatch)
    denied = client.post(f"/api/inspections/{iid}/override", json={"decision": "PASS", "reason": "looks fine"}, headers=A)
    assert denied.status_code == 403
    ok = client.post(f"/api/inspections/{iid}/override", json={"decision": "PASS", "reason": "Crush is cosmetic."}, headers=A_APPROVER)
    assert ok.status_code == 200
    body = ok.json()
    assert body["override"]["operator_id"] == "sup-bob"  # from the credential, not the request
    assert body["record"]["outcome"]["decision"] == "ACCEPT"
    assert body["record"]["outcome"]["prep_hold"] is False


def test_override_requires_an_analysis():
    iid = _create_inspection()["inspection_id"]
    response = client.post(f"/api/inspections/{iid}/override", json={"decision": "EXCEPTION", "reason": "x"}, headers=A)
    assert response.status_code == 409


def test_rerun_keeps_overrides_and_chain_verifies(monkeypatch):
    iid, first = _analyzed(monkeypatch)
    client.post(f"/api/inspections/{iid}/override", json={"decision": "EXCEPTION", "reason": "Confirmed on dock."}, headers=A)
    rerun = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "damaged_carton"}, headers=A).json()
    assert len(rerun["record"]["overrides"]) == 1
    assert rerun["record"]["version"] == 3
    assert rerun["record"]["supersedes"]["record_id"] != first["record"]["record_id"]
    fetched = client.get(f"/api/inspections/{iid}", headers=A).json()
    assert len(fetched["overrides"]) == 1
    verify = client.get(f"/api/inspections/{iid}/verify", headers=A).json()
    assert verify["integrity_verified"] is True, verify
    assert verify["records"] == 3


def test_db_records_are_append_only_and_tampering_is_detected(monkeypatch):
    iid, _ = _analyzed(monkeypatch)
    path = get_settings().database_url.removeprefix("sqlite:///")
    conn = sqlite3.connect(path)
    with pytest.raises(sqlite3.DatabaseError):  # the append-only trigger blocks updates
        conn.execute("UPDATE records SET record_json = '{}' WHERE inspection_id = ?", (iid,))
    # An attacker with file access drops the trigger, flips the verdict and recomputes the plain hash.
    row = conn.execute("SELECT record_id, record_json FROM records WHERE inspection_id = ?", (iid,)).fetchone()
    record = json.loads(row[1])
    record["outcome"]["decision"] = "ACCEPT"
    record["content_hash"] = compute_hash(record)
    conn.execute("DROP TRIGGER records_no_update")
    conn.execute("UPDATE records SET record_json = ?, content_hash = ? WHERE record_id = ?", (json.dumps(record), record["content_hash"], row[0]))
    conn.commit()
    conn.executescript("CREATE TRIGGER records_no_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;")
    conn.close()
    verify = client.get(f"/api/inspections/{iid}/verify", headers=A).json()
    assert verify["integrity_verified"] is False
    assert any("seal invalid" in p for p in verify["problems"])


# --- real photos, real-time stream, health --------------------------------------------------


def test_demo_mode_never_scripts_a_real_run_without_a_scenario(monkeypatch):
    # The bug: DEMO_MODE=true gave a real upload the scripted 'correct_shipment' verdict. A plain run must read the photo.
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None, OPENAI_API_KEY=None)
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PENDING_REVIEW" and body["demo_mode"] is False
    assert "not configured" in body["failure_reason"]
    scripted = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "correct_shipment"}, headers=A).json()
    assert scripted["demo_mode"] is True and scripted["analysis_status"] == "demo"


def _stream_events(iid, **params):
    with client.stream("POST", f"/api/inspections/{iid}/analyze/stream", params=params, headers=A) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        return [json.loads(line) for line in response.iter_lines() if line]


def test_stream_emits_real_pipeline_steps_then_the_result(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid)
    _fake_openai(monkeypatch, reply={"images": [{"image_id": ids[0], "visibility": "clear", "shows_whole_shipment": True, "observations": CLEAN}]})
    events = [e for e in _stream_events(iid) if e["type"] != "heartbeat"]
    types_ = [e["type"] for e in events]
    assert types_[:4] == ["start", "perception", "perception_done", "photo"]
    assert types_.count("check") == 7 and types_[-3:] == ["decision", "sealed", "done"]
    assert all(isinstance(e["t_ms"], int) for e in events)
    done = events[-1]["result"]
    assert done["decision"] == "PASS" and done["record"]["version"] == 1
    assert client.get(f"/api/inspections/{iid}/verify", headers=A).json()["integrity_verified"] is True


def test_stream_fail_open_and_request_errors(monkeypatch):
    _set_env(monkeypatch, AI_API_KEY=None, OPENAI_API_KEY=None, DEMO_MODE="false")
    iid = _create_inspection()["inspection_id"]
    assert client.post(f"/api/inspections/{iid}/analyze/stream", headers=A).status_code == 400  # no photos yet
    assert client.post(f"/api/inspections/{iid}/analyze/stream", headers=B).status_code == 404  # other tenant
    _upload(iid)
    events = _stream_events(iid)
    assert "perception_failed" in [e["type"] for e in events]
    assert events[-1]["type"] == "done" and events[-1]["result"]["decision"] == "PENDING_REVIEW"


def test_negative_count_is_invalid_reading_not_a_crash():
    obs = [o for o in CLEAN if o["check_type"] != "carton"] + [_obs("carton", -2)]
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert checks["carton_check"]["reason_code"] == "NOT_OBSERVED" and decision == "UNCERTAIN"  # ignored, not a vote


def test_health_reports_perception_mode(monkeypatch):
    _set_env(monkeypatch, AI_API_KEY=None, OPENAI_API_KEY=None)
    assert client.get("/api/health").json()["perception"]["mode"] == "not_configured"
    _set_env(monkeypatch, AI_API_KEY="sk-x")
    assert client.get("/api/health").json()["perception"]["mode"] == "live"


# --- weighted consensus + second look ------------------------------------------------------------


def _viewed_service(views):
    inspection = Inspection(
        inspection_id="INS-V", organization_id="org-a", po=PurchaseOrder(**PO),
        images=[ReceivingImage(image_id=f"IMG-{i}", inspection_id="INS-V", filename="x.png", stored_filename="x.png",
                               image_path="x", image_type=v) for i, v in enumerate(views, start=1)],
    )
    return VisionService(inspection)


def _run_views(views, images_payload):
    service = _viewed_service(views)
    result = service._build_result(service._validate_payload(VisionAnalysisResponse.model_validate({"images": images_payload})))
    return result["decision"], {c["check_name"]: c for c in result["checks"]}


def test_consensus_clear_label_outweighs_blurry_offangle_misread():
    rest = [o for o in CLEAN if o["check_type"] != "sku"]
    decision, checks = _run_views(["label", "pallet"], [
        {"image_id": "IMG-1", "visibility": "clear", "observations": [_obs("sku", "BLUE-BOTTLE-001", 0.95)] + rest},
        {"image_id": "IMG-2", "visibility": "blurred", "observations": [_obs("sku", "BLUE-B0TTLE-00I", 0.65)]},
    ])
    assert checks["sku_check"]["status"] == "PASS" and decision == "PASS"
    consensus = checks["sku_check"]["measurements"]["consensus"]
    assert consensus["share"] >= 0.7 and len(consensus["votes"]) == 2  # the losing read is kept as evidence


def test_consensus_comparable_clear_photos_that_conflict_stay_uncertain():
    _, checks = _run_views(["label", "label"], [
        {"image_id": "IMG-1", "visibility": "clear", "observations": [_obs("sku", "BLUE-BOTTLE-001")]},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("sku", "RED-BOTTLE-001")]},
    ])
    assert checks["sku_check"]["status"] == "UNCERTAIN" and checks["sku_check"]["reason_code"] == "VIEWS_DISAGREE"


def test_damage_stays_strict_under_consensus():
    _, checks = _run_views(["carton", "carton", "carton"], [
        {"image_id": "IMG-1", "visibility": "clear", "observations": [_obs("damage", "none")]},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("damage", "none")]},
        {"image_id": "IMG-3", "visibility": "clear", "observations": [_obs("damage", ["crushing"], 0.8)]},
    ])
    assert checks["damage_check"]["status"] == "FAIL"  # one reliable sighting of damage is enough


def _sequenced_openai(monkeypatch, replies):
    _fake_openai(monkeypatch, reply=None)
    queue_ = list(replies)

    def create(self, **kwargs):
        _FakeResponses.calls.append(kwargs)
        reply = queue_.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return types.SimpleNamespace(status="completed", model="gpt-test-2026", output_text=json.dumps(reply))
    monkeypatch.setattr(_FakeResponses, "create", create)


def _disputed_first_pass(ids):
    rest = [o for o in CLEAN if o["check_type"] != "sku"]
    return {"images": [
        {"image_id": ids[0], "visibility": "clear", "shows_whole_shipment": True, "observations": [_obs("sku", "BLUE-BOTTLE-001")] + rest},
        {"image_id": ids[1], "visibility": "clear", "shows_whole_shipment": False, "observations": [_obs("sku", "BLUE-BOTTLE-007")]},
    ]}


def test_second_look_settles_a_disputed_check(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid, n=2, view="label")
    second = {"images": [
        {"image_id": ids[1], "visibility": "clear", "shows_whole_shipment": False,
         "observations": [_obs("sku", "BLUE-BOTTLE-001", 0.97), _obs("variant", "Red")]},  # off-target read is ignored
    ]}
    _sequenced_openai(monkeypatch, [_disputed_first_pass(ids), second])
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert len(_FakeResponses.calls) == 2
    prompt = _FakeResponses.calls[1]["input"][0]["content"][0]["text"]
    assert "SECOND LOOK" in prompt and "sku" in prompt and "BLUE-BOTTLE-001" not in prompt  # still blind to the PO
    checks = {c["check_name"]: c for c in body["checks"]}
    assert checks["sku_check"]["status"] == "PASS" and checks["variant_check"]["status"] == "PASS"
    assert body["second_look"]["checks"] == ["sku"] and body["second_look"]["settled"] == ["sku"]
    assert body["decision"] == "PASS"


def test_second_look_can_be_disabled_and_failure_keeps_first_pass(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid, n=2, view="label")
    _sequenced_openai(monkeypatch, [_disputed_first_pass(ids)])
    _set_env(monkeypatch, AI_SECOND_LOOK="false")
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert len(_FakeResponses.calls) == 1 and body["second_look"] is None and body["decision"] == "UNCERTAIN"

    _set_env(monkeypatch, AI_SECOND_LOOK="true")
    _sequenced_openai(monkeypatch, [_disputed_first_pass(ids), TimeoutError("slow")])
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert len(_FakeResponses.calls) == 2
    assert body["decision"] == "UNCERTAIN" and body["failure_reason"] is None  # not PENDING_REVIEW: first pass stands


def test_clean_first_pass_makes_exactly_one_call(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid)
    _sequenced_openai(monkeypatch, [{"images": [{"image_id": ids[0], "visibility": "clear", "shows_whole_shipment": True, "observations": CLEAN}]}])
    assert client.post(f"/api/inspections/{iid}/analyze", headers=A).json()["decision"] == "PASS"
    assert len(_FakeResponses.calls) == 1


# --- reviewer probes (consensus safety) --------------------------------------------------------


def test_clear_label_dissent_cannot_be_outvoted_into_pass():
    # Reviewer probe: three identical unit-view reads used to outvote one clear label read of a different SKU.
    rest = [o for o in CLEAN if o["check_type"] != "sku"]
    _, checks = _run_views(["label", "unit"], [
        {"image_id": "IMG-1", "visibility": "clear", "observations": [_obs("sku", "WRONG-9", 0.95)] + rest},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("sku", "BLUE-BOTTLE-001", 0.9)] * 3},
    ])
    assert checks["sku_check"]["status"] == "UNCERTAIN"
    assert checks["sku_check"]["measurements"]["consensus"]["strong_dissent"] is True
    _, checks = _run_views(["label", "unit", "unit", "carton"], [
        {"image_id": "IMG-1", "visibility": "clear", "observations": [_obs("sku", "WRONG-9", 0.95)]},
        *[{"image_id": f"IMG-{i}", "visibility": "clear", "observations": [_obs("sku", "BLUE-BOTTLE-001", 0.95)]} for i in (2, 3, 4)],
    ])
    assert checks["sku_check"]["status"] == "UNCERTAIN"  # many photos never overrule one clear dissenting label


def test_negative_counts_never_derive_a_quantity():
    obs = [o for o in CLEAN if o["check_type"] not in ("carton", "units_per_carton", "quantity")]
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs + [_obs("carton", -2), _obs("units_per_carton", -12)]}])
    assert checks["quantity_check"]["status"] == "UNCERTAIN" and checks["quantity_check"]["observed_value"] is None


def test_weak_reread_does_not_supersede_and_superseded_reads_stay_in_evidence(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid, n=2, view="label")
    weak = {"images": [{"image_id": ids[1], "visibility": "clear", "observations": [_obs("sku", "BLUE-BOTTLE-001", 0.2)]}]}
    _sequenced_openai(monkeypatch, [_disputed_first_pass(ids), weak])
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "UNCERTAIN" and body["second_look"]["superseded"] == 0

    strong = {"images": [{"image_id": ids[1], "visibility": "clear", "observations": [_obs("sku", "BLUE-BOTTLE-001", 0.97)]}]}
    _sequenced_openai(monkeypatch, [_disputed_first_pass(ids), strong])
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    superseded = [e for e in body["evidence"] if e["check_type"] == "sku:superseded"]
    assert len(superseded) == 1 and superseded[0]["observation"] == "BLUE-BOTTLE-007"
    assert body["record"]["checks"]  # sealed with the full evidence trail
    sku = next(c for c in body["checks"] if c["check_name"] == "sku_check")
    assert sku["status"] == "PASS" and sku["confidence"] == 0.97


def test_failed_second_look_is_reported(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid, n=2, view="label")
    _sequenced_openai(monkeypatch, [_disputed_first_pass(ids), TimeoutError("slow")])
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["second_look"]["failed"] == "TimeoutError" and body["second_look"]["checks"] == ["sku"]


def test_disagreeing_check_reports_zero_confidence():
    _, checks = _run_views(["label", "label"], [
        {"image_id": "IMG-1", "visibility": "clear", "observations": [_obs("sku", "BLUE-BOTTLE-001")]},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("sku", "RED-BOTTLE-001")]},
    ])
    assert checks["sku_check"]["confidence"] == 0.0
