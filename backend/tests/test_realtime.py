import base64
import hashlib
import io
import json
from functools import lru_cache

import pytest
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

from backend.tests.test_backend import (  # noqa: F401  (_fresh_settings is an autouse fixture)
    A, CLEAN, _create_inspection, _fake_openai, _FakeResponses, _fresh_settings, _obs, _set_env, client,
)
from backend.app.services import barcodes, image_quality

zxingcpp = pytest.importorskip("zxingcpp")
STEPS = ["validate", "quality", "barcode", "perception", "rules", "seal"]


@lru_cache
def _label() -> Image.Image:
    """Carton label: large SKU text and a CODE128 barcode of the SKU on kraft board."""
    img = Image.new("RGB", (1200, 900), (196, 160, 120))
    draw = ImageDraw.Draw(img)
    draw.rectangle((100, 80, 1100, 820), fill=(232, 232, 228))
    draw.text((150, 120), "SKU: BLUE-BOTTLE-001", fill=(20, 20, 20), font=ImageFont.load_default(size=72))
    code = zxingcpp.create_barcode("BLUE-BOTTLE-001", zxingcpp.BarcodeFormat.Code128)
    img.paste(Image.fromarray(code.to_image(scale=4)).convert("RGB"), (150, 380))
    return img


def _png(img) -> bytes:
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def _sharp():
    return _png(_label())


def _blurred():
    return _png(_label().filter(ImageFilter.GaussianBlur(8)))


def _dark():
    return _png(ImageEnhance.Brightness(_label()).enhance(0.15))


def _upload_bytes(iid, name, content, view="label"):
    mime = "image/jpeg" if name.endswith(".jpg") else "image/png"
    r = client.post(f"/api/inspections/{iid}/images", files=[("files", (name, content, mime))], data={"image_type": view}, headers=A)
    assert r.status_code == 200, r.text
    return r.json()["images"][0]


def _events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if not line.startswith(":"))
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_quality_flags_blur_darkness_and_size():
    assert image_quality.assess(_sharp())["ok"] is True
    assert "blurry" in image_quality.assess(_blurred())["issues"]
    assert image_quality.assess(_dark())["issues"] == ["too_dark"]
    assert image_quality.assess(_png(_label().resize((400, 300))))["issues"] == ["too_small"]
    assert image_quality.assess(b"not an image")["issues"] == ["unreadable"]


def test_barcode_is_decoded():
    assert barcodes.available()
    assert barcodes.decode(_sharp()) == [{"format": "CODE128", "text": "BLUE-BOTTLE-001"}]
    assert barcodes.decode(b"garbage") == []


def test_upload_response_includes_quality_and_never_rejects():
    iid = _create_inspection()["inspection_id"]
    image = _upload_bytes(iid, "dark.png", _dark())
    assert image["quality"]["issues"] == ["too_dark"] and image["quality"]["width"] == 1200
    assert image["sha256_digest"] == hashlib.sha256(_dark()).hexdigest()


def test_barcode_matching_po_sku_passes_sku_check_in_live_mode(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    image_id = _upload_bytes(iid, "label.png", _sharp())["image_id"]
    no_sku = [o for o in CLEAN if o["check_type"] != "sku"]
    _fake_openai(monkeypatch, reply={"images": [{"image_id": image_id, "visibility": "clear", "shows_whole_shipment": True,
                                                 "observations": no_sku}]})
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    sku = next(c for c in body["checks"] if c["check_name"] == "sku_check")
    assert sku["status"] == "PASS" and sku["confidence"] == 1.0
    assert sku["measurements"]["barcodes"] == [{"image_id": image_id, "format": "CODE128", "text": "BLUE-BOTTLE-001", "matches_po_sku": True}]
    ev = next(e for e in body["evidence"] if e["evidence_id"] in sku["evidence_ids"])
    assert ev["description"] == "Barcode CODE128 decoded deterministically" and ev["observation"] == "BLUE-BOTTLE-001"
    assert body["decision"] == "PASS" and body["barcodes"][0]["matches_po_sku"] is True

    # OCR disagreeing with the barcode stays conservative.
    _fake_openai(monkeypatch, reply={"images": [{"image_id": image_id, "visibility": "clear", "observations": no_sku + [_obs("sku", "RED-BOTTLE-002")]}]})
    sku = next(c for c in client.post(f"/api/inspections/{iid}/analyze", headers=A).json()["checks"] if c["check_name"] == "sku_check")
    assert sku["status"] == "UNCERTAIN" and sku["reason_code"] == "VIEWS_DISAGREE"


def test_demo_barcode_is_recorded_but_scenario_still_decides(monkeypatch):
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None)
    iid = _create_inspection()["inspection_id"]
    _upload_bytes(iid, "label.png", _sharp())
    body = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "barcode_glare"}, headers=A).json()
    sku = next(c for c in body["checks"] if c["check_name"] == "sku_check")
    assert body["decision"] == "UNCERTAIN" and sku["status"] == "UNCERTAIN"
    assert sku["measurements"]["barcodes"][0]["text"] == "BLUE-BOTTLE-001"


def test_model_gets_upright_jpeg_at_most_2048px_and_quality_tag(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    big = Image.new("RGB", (3000, 2000), (200, 180, 150))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotated 90 degrees: upright image is 2000 x 3000
    out = io.BytesIO()
    big.save(out, "JPEG", exif=exif)
    image = _upload_bytes(iid, "big.jpg", out.getvalue(), view="pallet")
    assert (image["quality"]["width"], image["quality"]["height"]) == (2000, 3000)
    _fake_openai(monkeypatch, reply={"images": [{"image_id": image["image_id"], "visibility": "clear", "observations": CLEAN}]})
    client.post(f"/api/inspections/{iid}/analyze", headers=A)
    content = _FakeResponses.calls[0]["input"][0]["content"]
    url = next(p["image_url"] for p in content if p["type"] == "input_image")
    assert url.startswith("data:image/jpeg;base64,")
    sent = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert sent.format == "JPEG" and sent.size == (1365, 2048)
    tag = next(p["text"] for p in content if p["type"] == "input_text" and image["image_id"] in p["text"])
    assert tag == f"image_id={image['image_id']} view=pallet quality_issues=blurry"  # flat test image has no edges
    stored = client.get(f"/api/inspections/{iid}/images/{image['image_id']}", headers=A).content
    assert hashlib.sha256(stored).hexdigest() == image["sha256_digest"] == hashlib.sha256(out.getvalue()).hexdigest()


def test_stream_emits_ordered_steps_and_the_analyze_result(monkeypatch):
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None)
    iid = _create_inspection()["inspection_id"]
    _upload_bytes(iid, "label.png", _sharp())
    r = client.post(f"/api/inspections/{iid}/analyze/stream", params={"scenario": "correct_shipment"}, headers=A)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["cache-control"] == "no-cache" and r.headers["x-accel-buffering"] == "no"
    events = _events(r.text)
    steps = [e for kind, e in events if kind == "step"]
    order = [s["step"] for s in steps]
    assert [k for i, k in enumerate(order) if k not in order[:i]] == STEPS
    for name in STEPS:
        assert [s["status"] for s in steps if s["step"] == name] == ["running", "done"], name
    assert all(set(s) == {"step", "status", "message", "data"} for s in steps)
    assert "BLUE-BOTTLE-001" in next(s["message"] for s in steps if s["step"] == "barcode" and s["status"] == "done")
    kind, result = events[-1]
    assert kind == "result" and result["decision"] == "PASS"
    plain = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "correct_shipment"}, headers=A).json()
    assert set(result) == set(plain) and result["record"]["version"] == plain["record"]["version"] - 1
    assert client.get(f"/api/inspections/{iid}/verify", headers=A).json()["integrity_verified"] is True


def test_stream_fails_open_and_validates_before_streaming(monkeypatch):
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None)
    iid = _create_inspection()["inspection_id"]
    url = f"/api/inspections/{iid}/analyze/stream"
    assert client.post(url, headers=A).status_code == 400
    assert client.post("/api/inspections/INS-NOPE/analyze/stream", headers=A).status_code == 404
    _upload_bytes(iid, "label.png", _sharp())
    bad = client.post(url, params={"scenario": "nope"}, headers=A)
    assert bad.status_code == 400 and "Unknown demo scenario" in bad.json()["detail"]
    events = _events(client.post(url, params={"scenario": "perception_failure"}, headers=A).text)
    statuses = {(e["step"], e["status"]) for kind, e in events if kind == "step"}
    assert ("perception", "error") in statuses and ("rules", "done") in statuses and ("seal", "done") in statuses
    kind, result = events[-1]
    assert kind == "result" and result["decision"] == "PENDING_REVIEW"
    assert result["recommendations"][0].startswith("Perception was unavailable")


def test_health_reports_readiness_without_the_key(monkeypatch):
    _set_env(monkeypatch, DEMO_MODE="false", AI_API_KEY=None, OPENAI_API_KEY=None)
    body = client.get("/api/health").json()
    assert body == {"status": "ok", "service": "receiving-manager", "mode": "live", "provider": "openai", "model": body["model"],
                    "ai_configured": False, "barcode_reader": True, "image_quality": True}
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY="sk-secret-value")
    body = client.get("/api/health").json()
    assert body["mode"] == "demo" and body["ai_configured"] is True and "sk-secret" not in json.dumps(body)


def test_recommendations_for_ambiguous_run(monkeypatch):
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None)
    iid = _create_inspection()["inspection_id"]
    _upload_bytes(iid, "blurry.png", _blurred(), view="carton")
    body = client.post(f"/api/inspections/{iid}/analyze", params={"scenario": "ambiguous"}, headers=A).json()
    recs = body["recommendations"]
    assert body["decision"] == "UNCERTAIN" and len(recs) == len(set(recs)) <= 6
    assert recs[0] == "Retake blurry.png: blurry"
    assert "No pallet photo uploaded: take a Pallet Overview photo showing every carton" in recs
    assert "Take a Pallet Overview photo showing every carton" not in recs  # de-duplicated with the missing view
    assert "Photograph the carton label that prints units per carton" in recs
    assert body["image_quality"][0]["issues"] == ["blurry"]
    assert client.get(f"/api/inspections/{iid}", headers=A).json()["recommendations"] == recs


@pytest.mark.parametrize("name, expected", [
    ("AuthenticationError", "AuthenticationError: invalid OpenAI API key"),
    ("RateLimitError", "RateLimitError: OpenAI rate limit or quota exceeded; retry later"),
    ("NotFoundError", "NotFoundError: model 'gpt-4o-mini' not found or not available to this API key"),
    ("APITimeoutError", "APITimeoutError: OpenAI request timed out after 45s"),
])
def test_openai_errors_map_to_clear_reasons_without_the_key(monkeypatch, name, expected):
    iid = _create_inspection()["inspection_id"]
    _upload_bytes(iid, "label.png", _sharp())
    _fake_openai(monkeypatch, error=type(name, (Exception,), {})("Incorrect API key provided: sk-test-abcdef123456"))
    _set_env(monkeypatch, AI_MODEL="gpt-4o-mini")
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PENDING_REVIEW" and body["failure_reason"] == expected
    assert "sk-test" not in json.dumps(body)


def test_demo_scenarios_keep_their_decisions_with_a_real_barcode_label(monkeypatch):
    _set_env(monkeypatch, DEMO_MODE="true", AI_API_KEY=None)
    iid = _create_inspection()["inspection_id"]
    _upload_bytes(iid, "label.png", _sharp())
    expected = {"correct_shipment": "PASS", "short_shipment": "EXCEPTION", "wrong_variant": "EXCEPTION",
                "damaged_carton": "EXCEPTION", "water_damage": "EXCEPTION", "missing_component": "EXCEPTION",
                "barcode_glare": "UNCERTAIN", "ambiguous": "UNCERTAIN", "perception_failure": "PENDING_REVIEW"}
    got = {s: client.post(f"/api/inspections/{iid}/analyze", params={"scenario": s}, headers=A).json()["decision"] for s in expected}
    assert got == expected


def test_missing_openai_sdk_fails_open_with_clear_reason(monkeypatch):
    import sys

    iid = _create_inspection()["inspection_id"]
    _upload_bytes(iid, "label.png", _sharp())
    _set_env(monkeypatch, AI_API_KEY="sk-test", DEMO_MODE="false")
    monkeypatch.setitem(sys.modules, "openai", None)  # import openai -> ImportError
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PENDING_REVIEW" and "openai SDK is not installed" in body["failure_reason"]
