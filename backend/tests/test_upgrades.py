import json
import os
import threading
from pathlib import Path

import pytest

from backend.tests.test_backend import (  # noqa: F401  (_fresh_settings is an autouse fixture)
    A, A_APPROVER, CLEAN, PO, _create_inspection, _fake_openai, _FakeResponses, _fresh_settings, _obs, _png_bytes,
    _run, _set_env, _upload, client,
)
from backend.app.api import inspections as api
from backend.app.core import config
from backend.app.core.decision_engine import evaluate_component_check, evaluate_damage_check, evaluate_sku_check
from backend.app.core.config import get_settings
from backend.app.database.repository import InspectionRepository
from backend.app.services import evidence_record
from backend.app.services.vision import RESPONSE_SCHEMA, VisionAnalysisResponse
from backend.tests.test_backend import _service


def _demo(monkeypatch):
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None)


# 1. concurrency


def test_parallel_uploads_and_analyses_do_not_lose_updates(monkeypatch):
    _demo(monkeypatch)
    iid = _create_inspection()["inspection_id"]
    errors = []

    def upload():
        r = client.post(f"/api/inspections/{iid}/images", files=[("files", ("p.png", _png_bytes(), "image/png"))], headers=A)
        r.status_code == 200 or errors.append(r.text)

    threads = [threading.Thread(target=upload) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors
    assert len(client.get(f"/api/inspections/{iid}", headers=A).json()["images"]) == 8

    scenarios = ["correct_shipment", "short_shipment"] * 3
    threads = [threading.Thread(target=lambda s=s: client.post(f"/api/inspections/{iid}/analyze", params={"scenario": s}, headers=A))
               for s in scenarios]
    [t.start() for t in threads]
    [t.join() for t in threads]
    body = client.get(f"/api/inspections/{iid}", headers=A).json()
    qty = next(c for c in body["checks"] if c["check_name"] == "quantity_check")["status"]
    assert body["final_decision"] == ("PASS" if qty == "PASS" else "EXCEPTION")
    assert body["record"]["outcome"]["verdict"] == body["final_decision"]
    assert client.get(f"/api/inspections/{iid}/verify", headers=A).json()["integrity_verified"] is True


# 2. upload atomicity


def test_one_bad_file_saves_nothing_and_failed_save_cleans_up(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    files = [("files", ("ok.png", _png_bytes(), "image/png")), ("files", ("bad.png", b"nope", "image/png"))]
    assert client.post(f"/api/inspections/{iid}/images", files=files, headers=A).status_code == 400
    folder = api.storage.inspection_root(iid)
    assert list(folder.iterdir()) == []

    real_save, calls = api.storage.save, []

    def flaky(*args):
        calls.append(1)
        if len(calls) == 2:
            raise OSError("disk full")
        return real_save(*args)

    monkeypatch.setattr(api.storage, "save", flaky)
    two = [("files", (f"{i}.png", _png_bytes(), "image/png")) for i in range(2)]
    with pytest.raises(OSError):
        client.post(f"/api/inspections/{iid}/images", files=two, headers=A)
    assert list(folder.iterdir()) == []
    assert client.get(f"/api/inspections/{iid}", headers=A).json()["images"] == []


# 3. analyze needs images in demo mode; scenario names normalised


def test_demo_analyze_without_images_is_400_and_scenario_is_normalised(monkeypatch):
    _demo(monkeypatch)
    iid = _create_inspection()["inspection_id"]
    assert client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "correct_shipment"}, headers=A).status_code == 400
    _upload(iid)
    r = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": " Short Shipment "}, headers=A)
    assert r.status_code == 200 and r.json()["decision"] == "EXCEPTION"
    assert client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "nope"}, headers=A).status_code == 400


# 4. .env loading


def test_dotenv_is_loaded_without_overriding_real_env(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text("UPLOAD_MAX_IMAGES=7\nMAX_IMAGE_SIZE_MB=3\n")
    monkeypatch.setattr(config, "ENV_FILE", env)
    monkeypatch.delenv("RECEIVING_DISABLE_DOTENV")
    monkeypatch.delenv("UPLOAD_MAX_IMAGES", raising=False)
    monkeypatch.setenv("MAX_IMAGE_SIZE_MB", "5")
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.upload_max_images == 7 and settings.max_image_size_mb == 5
    finally:
        os.environ.pop("UPLOAD_MAX_IMAGES", None)


# 5. RECEIVING_API_KEYS validation


@pytest.mark.parametrize("raw", ["{not json", json.dumps({"k": {"operator_id": "x"}}), "[1]"])
def test_malformed_api_keys_give_generic_503_and_log_the_reason(monkeypatch, raw, caplog):
    _set_env(monkeypatch, RECEIVING_API_KEYS=raw)
    with caplog.at_level("ERROR", logger=api.log.name):
        r = client.get("/api/inspections", headers=A)
    assert r.status_code == 503 and r.json()["detail"] == api.KEYS_MISCONFIGURED  # no parse error or position
    assert "RECEIVING_API_KEYS is malformed:" in caplog.text


def test_invalid_role_is_treated_as_operator(monkeypatch):
    _set_env(monkeypatch, RECEIVING_API_KEYS=json.dumps({"k": {"organization_id": "org-a", "operator_id": "x", "role": "god"}}))
    assert api.require_principal("k")["role"] == "operator"


# 6. override reason is stripped first


def test_whitespace_override_reason_rejected(monkeypatch):
    _demo(monkeypatch)
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "damaged_carton"}, headers=A)
    assert client.post(f"/api/inspections/{iid}/override", json={"decision": "EXCEPTION", "reason": "   "}, headers=A).status_code == 422


# 7. components


def test_colon_component_is_present_and_conflicting_views_are_uncertain():
    obs = [o for o in CLEAN if o["check_type"] != "components"] + [_obs("components", ["cap:blue", "label"])]
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}], po={**PO, "expected_components": ["cap:blue", "label"]})
    assert checks["component_check"]["status"] == "PASS"
    result = evaluate_component_check(["cap"], ["cap"], ["cap"])
    assert result["status"] == "UNCERTAIN" and result["reason_code"] == "VIEWS_DISAGREE"


# 8. derived quantity


def test_derived_quantity_is_recorded_as_observed():
    obs = [o for o in CLEAN if o["check_type"] != "quantity"]
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    q = checks["quantity_check"]
    assert q["status"] == "PASS" and q["observed_value"] == 24 and q["measurements"]["derived"] is True


# 9 / 10. variant n/a, SKU normalisation


def test_variant_not_specified_and_sku_normalisation():
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN}], po={**PO, "variant": "N/A"})
    assert checks["variant_check"]["status"] == "NOT_REQUIRED"
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN}], po={**PO, "variant": "none"})
    assert checks["variant_check"]["status"] == "NOT_REQUIRED"
    assert evaluate_sku_check("n/a", "X")["status"] == "UNCERTAIN"
    assert evaluate_sku_check("BLUE-BOTTLE-001", "blue bottle 001")["status"] == "PASS"
    assert evaluate_sku_check("BLUE-BOTTLE-001", "BLUE.BOTTLE/001")["status"] == "PASS"
    assert evaluate_sku_check("BLUE-BOTTLE-001", "BLUE-BOTTLE-OO1")["status"] == "FAIL"  # no O/0 substitution
    decision, checks = _run([
        {"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("sku", "BLUE BOTTLE 001")]},
    ])
    assert checks["sku_check"]["status"] == "PASS"


# 11. partial views do not count as shipment totals


def test_close_up_counts_do_not_override_whole_shipment_counts():
    close_up = [_obs("carton", 1), _obs("quantity", 12), _obs("units_per_carton", 12)]
    decision, checks = _run([
        {"image_id": "IMG-1", "visibility": "clear", "shows_whole_shipment": True, "observations": CLEAN},
        {"image_id": "IMG-2", "visibility": "clear", "shows_whole_shipment": False, "observations": close_up},
    ])
    assert decision == "PASS", checks
    assert checks["carton_check"]["measurements"]["excluded_partial_view_readings"] == [{"image_id": "IMG-2", "observation": 1}]
    _, checks = _run([{"image_id": "IMG-2", "visibility": "clear", "shows_whole_shipment": False, "observations": close_up}])
    assert checks["carton_check"]["status"] == "UNCERTAIN"
    assert checks["units_per_carton_check"]["status"] == "PASS"
    image_schema = RESPONSE_SCHEMA["properties"]["images"]["items"]
    assert "shows_whole_shipment" in image_schema["required"]


# 12. vision API hardening


def test_live_call_shape_refusal_coverage_and_duplicates(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid, n=2)
    _fake_openai(monkeypatch, reply={"images": [{"image_id": ids[0], "visibility": "clear", "shows_whole_shipment": True, "observations": CLEAN}]})
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    images = [p for p in _FakeResponses.calls[0]["input"][0]["content"] if p["type"] == "input_image"]
    assert all(p["detail"] == "high" for p in images)
    conf = RESPONSE_SCHEMA["properties"]["images"]["items"]["properties"]["observations"]["items"]["properties"]["confidence"]
    assert conf["minimum"] == 0 and conf["maximum"] == 1
    assert all(c["measurements"]["images_not_reported"] == [ids[1]] for c in body["checks"])
    comp = next(e for e in body["evidence"] if e["check_type"] == "components")
    assert json.loads(comp["observation"]) == ["cap", "label"]

    _fake_openai(monkeypatch, reply={"images": [{"image_id": ids[0], "visibility": "clear", "observations": CLEAN}] * 2})
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PENDING_REVIEW" and "more than once" in body["failure_reason"]

    import types
    refusal = types.SimpleNamespace(status="completed", model="m", output_text="",
                                    output=[types.SimpleNamespace(content=[types.SimpleNamespace(type="refusal", refusal="no")])])
    monkeypatch.setattr(_FakeResponses, "create", lambda self, **kw: refusal)
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PENDING_REVIEW" and "Model refused: no" in body["failure_reason"]


def test_check_confidence_uses_reliable_readings_only():
    obs = [o for o in CLEAN if o["check_type"] != "sku"] + [_obs("sku", "X", confidence=0.5)]
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert checks["sku_check"]["confidence"] == 0.0


# 13. views


def test_capture_views_map_to_contract_enum():
    iid = _create_inspection()["inspection_id"]
    for given, stored in [("label", "label"), ("carton_exterior", "carton"), ("opened_unit", "unit"),
                          ("kit_components", "other"), ("receiving_photo", "other"), ("selfie", "other")]:
        r = client.post(f"/api/inspections/{iid}/images", files=[("files", ("p.png", _png_bytes(), "image/png"))],
                        data={"image_type": given}, headers=A)
        assert r.json()["images"][0]["image_type"] == stored, given


# 14. record contract


def test_record_contract_fields_and_override_hashes(monkeypatch):
    _demo(monkeypatch)
    iid = _create_inspection()["inspection_id"]
    image_id = _upload(iid)[0]
    record = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "damaged_carton"}, headers=A).json()["record"]
    assert record["schema_version"] == "receiving_record.v1" and record["status"] == "final"
    keys = {c["check_key"] for c in record["checks"]}
    assert keys == {"identity", "carton_count", "units_per_carton", "total_quantity", "variant", "carton_damage", "components"}
    damage = next(c for c in record["checks"] if c["check_key"] == "carton_damage")
    assert damage["image_ids"] == [image_id]
    assert record["outcome"]["hold_reasons"] == ["carton_damage:FAIL"]
    ov = client.post(f"/api/inspections/{iid}/override", json={"decision": "PASS", "reason": "cosmetic"}, headers=A_APPROVER).json()
    entry = ov["record"]["overrides"][-1]
    assert entry["prev_content_hash"] == record["content_hash"] and len(entry["new_content_hash"]) == 64
    assert ov["record"]["status"] == "final" and ov["record"]["stage"] == "overridden"
    assert client.get(f"/api/inspections/{iid}/verify", headers=A).json()["integrity_verified"] is True

    _demo(monkeypatch)
    pending = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "perception_failure"}, headers=A).json()["record"]
    assert pending["status"] == "pending" and pending["outcome"]["decision"] == "PENDING_REVIEW"


def test_po_only_checks_use_rules_model_version(monkeypatch):
    _demo(monkeypatch)
    iid = _create_inspection(po={**PO, "expected_components": []})["inspection_id"]
    _upload(iid)
    record = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "correct_shipment"}, headers=A).json()["record"]
    assert next(c for c in record["checks"] if c["check_key"] == "components")["model_version"] == "rules"
    assert next(c for c in record["checks"] if c["check_key"] == "identity")["model_version"] == "demo"


# 15. ephemeral seal key


def test_ephemeral_seal_from_previous_process_is_reported_as_such(monkeypatch):
    _set_env(monkeypatch, RECEIVING_SEAL_KEY="")
    record = evidence_record.seal({"a": 1})
    assert record["seal_key_id"] == "ephemeral" and evidence_record.verify_seal(record) == []
    monkeypatch.setattr(evidence_record, "_EPHEMERAL_KEY", b"x" * 32)
    monkeypatch.setattr(evidence_record, "_EPHEMERAL_REF", "another-process")
    assert evidence_record.verify_seal(record) == [f"seal not verifiable: {evidence_record.EPHEMERAL_MESSAGE}"]


# 16. DATABASE_URL


@pytest.mark.parametrize("url", ["sqlite:///:memory:", ":memory:", "postgresql://u@h/db", "sqlite://"])
def test_unsupported_database_url_fails_fast(monkeypatch, url):
    _set_env(monkeypatch, DATABASE_URL=url)
    with pytest.raises(ValueError, match="DATABASE_URL"):
        InspectionRepository()


def test_relative_sqlite_path_resolves_against_repo_root(monkeypatch):
    from backend.app.database.repository import _db_path

    _set_env(monkeypatch, DATABASE_URL="sqlite:///./data/x-test.db")
    assert Path(_db_path()) == config.REPO_ROOT / "data" / "x-test.db"


# 17. upload minor, damage int


def test_octet_stream_and_no_extension_and_int_damage():
    iid = _create_inspection()["inspection_id"]
    url = f"/api/inspections/{iid}/images"
    assert client.post(url, files=[("files", ("p.png", _png_bytes(), "application/octet-stream"))], headers=A).status_code == 200
    r = client.post(url, files=[("files", ("photo", _png_bytes(), "image/png"))], headers=A)
    assert r.status_code == 400 and r.json()["detail"].startswith("File has no extension; allowed:")
    assert evaluate_damage_check(0)["status"] == "UNCERTAIN"
    obs = [o for o in CLEAN if o["check_type"] != "damage"] + [_obs("damage", 0)]
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert checks["damage_check"]["status"] == "UNCERTAIN"


# 18. CORS


def test_cors_is_header_auth_only():
    r = client.options("/api/inspections", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "DELETE"})
    assert r.status_code == 400
    r = client.options("/api/inspections", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
                                                    "Access-Control-Request-Headers": "x-api-key"})
    assert r.status_code == 200 and "access-control-allow-credentials" not in r.headers


def test_demo_payload_without_shows_whole_shipment_defaults_true():
    assert VisionAnalysisResponse.model_validate({"images": [{"image_id": "IMG-1"}]}).images[0].shows_whole_shipment is True
    assert _service().inspection.images


# GitHub scan follow-ups


def test_public_example_keys_only_work_in_demo_mode(monkeypatch):
    keys = json.dumps({"change-me-operator-key": {"organization_id": "org", "operator_id": "op"}})
    _set_env(monkeypatch, RECEIVING_API_KEYS=keys, DEMO_MODE="false")
    r = client.get("/api/inspections", headers={"X-API-Key": "change-me-operator-key"})
    assert r.status_code == 503 and r.json()["detail"] == api.KEYS_MISCONFIGURED
    _set_env(monkeypatch, RECEIVING_API_KEYS=keys, DEMO_MODE="true")
    assert client.get("/api/inspections", headers={"X-API-Key": "change-me-operator-key"}).status_code == 200


def test_failure_reason_does_not_leak_urls():
    reason = api._public_failure_reason(RuntimeError("Connection error to https://internal.example/v1/responses?key=x"))
    assert reason == "RuntimeError: Connection error to <url>"


# Testing follow-ups


def test_image_count_is_checked_before_any_file_is_read(monkeypatch):
    _set_env(monkeypatch, UPLOAD_MAX_IMAGES="2")
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    real_validate, reads = api._validate_image_upload, []
    monkeypatch.setattr(api, "_validate_image_upload", lambda *a: reads.append(1) or real_validate(*a))
    files = [("files", (f"{i}.png", _png_bytes(), "image/png")) for i in range(2)]
    r = client.post(f"/api/inspections/{iid}/images", files=files, headers=A)
    assert r.status_code == 400 and "Maximum image count" in r.json()["detail"]
    assert reads == []


def test_upload_larger_than_any_valid_request_is_413_before_parsing(monkeypatch):
    _set_env(monkeypatch, UPLOAD_MAX_IMAGES="1", MAX_IMAGE_SIZE_MB="1")  # limit: 1 MB image + 1 MB overhead
    iid = _create_inspection()["inspection_id"]
    big = _png_bytes() + b"\x00" * (2 * 1024 * 1024 + 1)
    r = client.post(f"/api/inspections/{iid}/images", files=[("files", ("big.png", big, "image/png"))], headers=A)
    assert r.status_code == 413 and r.json()["detail"] == "Upload request is too large."
    _upload(iid)  # a normal upload still passes the middleware


@pytest.mark.parametrize("field,value", [
    ("expected_quantity", 1_000_001), ("units_per_carton", 1_000_001), ("expected_cartons", 1_000_001),
    ("sku", "S" * 201), ("product_name", "P" * 201), ("po_line", "1" * 201),
    ("expected_components", ["c"] * 51), ("expected_components", ["c" * 201]),
])
def test_po_fields_have_upper_bounds(field, value):
    r = client.post("/api/inspections", json={"po": {**PO, field: value}}, headers=A)
    assert r.status_code == 422


def test_po_at_the_bounds_is_accepted():
    _create_inspection({**PO, "expected_quantity": 1_000_000, "sku": "S" * 200, "expected_components": ["c" * 200] * 50})


def test_upload_filename_is_sanitized_before_storing_and_serving(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    names = ["../../evil.png", "..\\..\\win\\evil.png", "a;b'c.png", "/" + "x" * 300 + ".png"]
    files = [("files", (name, _png_bytes(), "image/png")) for name in names]
    images = client.post(f"/api/inspections/{iid}/images", files=files, headers=A).json()["images"]
    stored = [img["filename"] for img in images]
    assert stored[:3] == ["evil.png", "evil.png", "abc.png"]
    assert len(stored[3]) == api.MAX_FILENAME_LENGTH and stored[3].endswith(".png")
    r = client.get(f"/api/inspections/{iid}/images/{images[0]['image_id']}", headers=A)
    assert r.status_code == 200 and r.headers["content-disposition"] == 'attachment; filename="evil.png"'
    # httpx percent-encodes quotes and CR/LF in multipart names, so exercise those directly.
    assert api._safe_filename('a"b\r\n\x00c.png') == "abc.png"
    assert api._safe_filename("..", ".png") == "image.png" and api._safe_filename('\\"/', ".jpg") == "image.jpg"
