"""Real-photo failure modes found in the agent audit, plus streaming / chat-completions / probe paths.

Each case is phrased the way a real vision model answers, not the way the scripted demo does.
"""

import json
import types

import pytest

from backend.tests.test_backend import (  # noqa: F401  (fixture is autouse via import)
    A, CLEAN, PO, _create_inspection, _fake_openai, _FakeOpenAI, _FakeResponses, _fresh_settings, _obs, _run, _set_env,
    _upload, client,
)
from backend.app.core.decision_engine import (
    classify_damage,
    evaluate_component_check,
    evaluate_damage_check,
    evaluate_sku_check,
    evaluate_variant_check,
)
from backend.app.services import vision


def _clean_without(*kinds, extra=()):
    return [o for o in CLEAN if o["check_type"] not in kinds] + list(extra)


# --- damage wording -------------------------------------------------------------------------------


@pytest.mark.parametrize("reading", ["No damage visible", ["no visible damage"], "undamaged", "intact", "not damaged", [], "none"])
def test_no_damage_wordings_pass(reading):
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear",
                              "observations": _clean_without("damage", extra=[_obs("damage", reading)])}])
    assert checks["damage_check"]["status"] == "PASS", checks["damage_check"]
    assert decision == "PASS"


@pytest.mark.parametrize("reading,code", [
    (["crushed corner"], "DAMAGE_VISIBLE"), ("water damage", "DAMAGE_VISIBLE"), (["torn", "wet"], "DAMAGE_VISIBLE"),
    ("not visible", "LOW_VISIBILITY"), (["scuffed"], "MINOR_MARKS"), ("sticker residue", "UNRECOGNIZED_READING"),
])
def test_damage_wordings_are_classified(reading, code):
    result = evaluate_damage_check(reading)
    assert result["reason_code"] == code
    assert result["status"] == ("FAIL" if code == "DAMAGE_VISIBLE" else "UNCERTAIN")


def test_no_damage_negations_with_damage_words():
    assert classify_damage("no water damage") == "none"
    assert classify_damage("no crushing or tears") == "none"
    assert classify_damage("cannot see") == "unseen"


def test_null_damage_on_a_close_up_does_not_hold_the_run():
    # Clear pallet photo says no damage; the label close-up cannot judge damage (null, low confidence).
    decision, checks = _run([
        {"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN},
        {"image_id": "IMG-2", "visibility": "clear", "shows_whole_shipment": False,
         "observations": [_obs("damage", None, 0.3), _obs("sku", "BLUE-BOTTLE-001", 0.9)]},
    ])
    assert checks["damage_check"]["status"] == "PASS" and decision == "PASS"


def test_weak_damage_sighting_is_not_dropped():
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "blurred",
                              "observations": _clean_without("damage", extra=[_obs("damage", ["crushed"], 0.45)])}])
    assert checks["damage_check"]["status"] == "UNCERTAIN" and decision == "UNCERTAIN"


# --- SKU ------------------------------------------------------------------------------------------


@pytest.mark.parametrize("read", ["SKU: BLUE-BOTTLE-001", "Item # BLUE-BOTTLE-001", "sku blue bottle 001", "P/N BLUE-BOTTLE-001"])
def test_sku_label_prefixes_pass(read):
    assert evaluate_sku_check("BLUE-BOTTLE-001", read)["status"] == "PASS"


def test_barcode_digits_are_not_a_sku_mismatch():
    result = evaluate_sku_check("BLUE-BOTTLE-001", "012345678905")
    assert result["status"] == "UNCERTAIN" and result["reason_code"] == "IDENTIFIER_TYPE"


def test_real_sku_mismatch_still_fails():
    assert evaluate_sku_check("BLUE-BOTTLE-001", "RED-BOTTLE-001")["status"] == "FAIL"


def test_prefixed_and_plain_label_reads_agree():
    _, checks = _run([
        {"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("sku", "SKU: BLUE-BOTTLE-001")]},
    ])
    assert checks["sku_check"]["status"] == "PASS"


# --- variant --------------------------------------------------------------------------------------


@pytest.mark.parametrize("read,status", [
    ("blue bottle", "PASS"), ("BLUE.", "PASS"), ("Blue / 500ml", "PASS"), ("Navy Blue", "UNCERTAIN"), ("Red", "FAIL"),
])
def test_variant_wording(read, status):
    assert evaluate_variant_check("Blue", read, "Blue Bottle")["status"] == status


def test_variant_wordings_vote_together_across_photos():
    # Found in the live run: label said "Blue", opened unit said "blue bottle". Same variant, must not split the vote.
    decision, checks = _run([
        {"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN},
        {"image_id": "IMG-2", "visibility": "clear", "observations": [_obs("variant", "blue bottle", 0.86)]},
    ])
    assert checks["variant_check"]["status"] == "PASS" and decision == "PASS"
    assert checks["variant_check"]["confidence"] > 0


def test_grey_gray_synonym():
    assert evaluate_variant_check("Gray", "grey")["status"] == "PASS"


# --- components -----------------------------------------------------------------------------------


@pytest.mark.parametrize("seen", [["caps", "labels"], ["bottle cap", "label"], ["Cap", "Label"]])
def test_component_naming_variants_pass(seen):
    assert evaluate_component_check(["cap", "label"], seen)["status"] == "PASS"


@pytest.mark.parametrize("reading", ["missing cap", "no cap", "cap missing", "missing: cap ", "missing:caps"])
def test_missing_component_wordings_fail(reading):
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear",
                              "observations": _clean_without("components", extra=[_obs("components", ["label", reading])])}])
    assert checks["component_check"]["status"] == "FAIL", checks["component_check"]
    assert decision == "EXCEPTION"


# --- counts and types -----------------------------------------------------------------------------


def test_count_strings_are_coerced():
    obs = _clean_without("carton", "units_per_carton", "quantity",
                         extra=[_obs("carton", "2"), _obs("units_per_carton", "12 units"), _obs("quantity", 24.0)])
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert checks["carton_check"]["status"] == "PASS" and checks["units_per_carton_check"]["status"] == "PASS"
    assert decision == "PASS"


def test_uncorroborated_partial_unit_count_is_not_a_short_shipment():
    # Closed cartons: the model counted the 12 units it could see on top; cartons/units-per-carton not read.
    obs = _clean_without("carton", "units_per_carton", "quantity", extra=[_obs("quantity", 12)])
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert checks["quantity_check"]["status"] == "UNCERTAIN"
    assert checks["quantity_check"]["reason_code"] == "UNCORROBORATED_COUNT"


def test_corroborated_short_shipment_still_fails():
    obs = _clean_without("units_per_carton", "quantity", extra=[_obs("units_per_carton", 11), _obs("quantity", 22)])
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert checks["quantity_check"]["status"] == "FAIL" and decision == "EXCEPTION"


def test_numeric_sku_reading_is_text():
    _, checks = _run([{"image_id": "IMG-1", "visibility": "clear",
                       "observations": _clean_without("sku", extra=[_obs("sku", 12345678)])}])
    assert checks["sku_check"]["reason_code"] == "IDENTIFIER_TYPE"


# --- tolerant output parsing ----------------------------------------------------------------------


def test_empty_description_and_out_of_range_confidence_do_not_lose_the_run():
    obs = [dict(o, description="") for o in CLEAN]
    obs[0]["confidence"] = 1.3
    decision, _ = _run([{"image_id": "IMG-1", "visibility": "clear", "observations": obs}])
    assert decision == "PASS"


def test_image_id_case_and_prefix_are_matched():
    decision, _ = _run([{"image_id": "image_id=img-1", "visibility": "clear", "observations": CLEAN}])
    assert decision == "PASS"


def test_one_unknown_photo_is_ignored_with_a_warning():
    from backend.tests.test_backend import _service
    service = _service()
    payload = vision.VisionAnalysisResponse.model_validate({"images": [
        {"image_id": "IMG-1", "visibility": "clear", "observations": CLEAN},
        {"image_id": "IMG-NOPE", "visibility": "clear", "observations": CLEAN},
    ]})
    result = service._build_result(service._validate_payload(payload))
    assert result["decision"] == "PASS" and service.warnings


def test_second_look_keeps_a_photo_the_first_pass_skipped():
    first = vision.VisionAnalysisResponse.model_validate({"images": [{"image_id": "IMG-1", "observations": []}]})
    again = vision.VisionAnalysisResponse.model_validate({"images": [
        {"image_id": "IMG-2", "observations": [_obs("sku", "BLUE-BOTTLE-001", 0.9)]}]})
    merged, _ = vision._merge(first, again, ["sku"])
    assert [r.image_id for r in merged.images] == ["IMG-1", "IMG-2"]


def test_prompt_is_blind_but_carries_the_component_checklist():
    prompt = vision.build_prompt(["cap", "label"])
    assert "cap, label" in prompt and "BLUE-BOTTLE-001" not in prompt


# --- streaming (Responses API) --------------------------------------------------------------------


def _stream_events(reply: dict, chunk=17):
    text = json.dumps(reply)
    for i in range(0, len(text), chunk):
        yield types.SimpleNamespace(type="response.output_text.delta", delta=text[i:i + chunk])
    final = types.SimpleNamespace(status="completed", model="gpt-stream-test", output_text=text, output=[],
                                  usage=types.SimpleNamespace(input_tokens=1234, output_tokens=321))
    yield types.SimpleNamespace(type="response.completed", response=final)


def test_streamed_run_emits_live_reading_events(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid, n=2, view="pallet")
    reply = {"images": [
        {"image_id": ids[0], "visibility": "clear", "shows_whole_shipment": True, "observations": CLEAN},
        {"image_id": ids[1], "visibility": "clear", "shows_whole_shipment": True, "observations": [_obs("damage", "none")]},
    ]}
    _fake_openai(monkeypatch)
    monkeypatch.setattr(_FakeResponses, "create", lambda self, **kw: (_FakeResponses.calls.append(kw), _stream_events(reply))[1])
    response = client.post(f"/api/inspections/{iid}/analyze/stream", headers=A)
    events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    kinds = [e["type"] for e in events]
    assert _FakeResponses.calls[0]["stream"] is True
    reading = [e for e in events if e["type"] == "model_reading"]
    assert [e["image_id"] for e in reading] == ids and reading[0]["index"] == 1 and reading[0]["of"] == 2
    assert any(e["type"] == "model_observation" and e["check_type"] == "sku" for e in events)
    assert kinds.index("model_reading") < kinds.index("perception_done") < kinds.index("decision")
    done = events[-1]
    assert done["type"] == "done" and done["result"]["decision"] == "PASS"
    assert done["result"]["usage"] == {"input_tokens": 1234, "output_tokens": 321}


def test_stream_that_ends_without_a_response_holds_for_review(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    _fake_openai(monkeypatch)
    monkeypatch.setattr(_FakeResponses, "create", lambda self, **kw: iter([types.SimpleNamespace(type="response.output_text.delta", delta="{")]))
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PENDING_REVIEW" and "without a final response" in body["failure_reason"]


# --- Chat Completions path (OpenAI-compatible servers) --------------------------------------------


class _FakeCompletions:
    calls = []
    reply = None

    def create(self, **kwargs):
        _FakeCompletions.calls.append(kwargs)
        text = json.dumps(_FakeCompletions.reply)
        if kwargs.get("stream"):
            def chunks():
                for i in range(0, len(text), 25):
                    yield types.SimpleNamespace(model="local-vlm", usage=None, choices=[
                        types.SimpleNamespace(delta=types.SimpleNamespace(content=text[i:i + 25], refusal=None), finish_reason=None)])
                yield types.SimpleNamespace(model="local-vlm", usage=types.SimpleNamespace(prompt_tokens=50, completion_tokens=9),
                                            choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content=None, refusal=None),
                                                                           finish_reason="stop")])
            return chunks()
        message = types.SimpleNamespace(content="```json\n" + text + "\n```", refusal=None)
        return types.SimpleNamespace(model="local-vlm", usage=None, choices=[types.SimpleNamespace(message=message, finish_reason="stop")])


class _FakeChatOpenAI(_FakeOpenAI):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.chat = types.SimpleNamespace(completions=_FakeCompletions())


@pytest.mark.parametrize("stream", ["true", "false"])
def test_custom_base_url_uses_chat_completions(monkeypatch, stream):
    import sys
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid, view="pallet")
    _fake_openai(monkeypatch)
    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=_FakeChatOpenAI))
    _set_env(monkeypatch, OPENAI_BASE_URL="http://localhost:11434/v1", AI_STREAM=stream)
    _FakeCompletions.calls = []
    _FakeCompletions.reply = {"images": [{"image_id": ids[0], "visibility": "clear", "shows_whole_shipment": True, "observations": CLEAN}]}
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PASS", body.get("failure_reason")
    kwargs = _FakeCompletions.calls[0]
    schema = kwargs["response_format"]["json_schema"]["schema"]
    assert "minimum" not in json.dumps(schema)  # loose schema for compatible servers
    assert kwargs["messages"][0]["content"][2]["type"] == "image_url"
    assert body["record"]["checks"][0]["model_version"] == "local-vlm"


# --- provider probe -------------------------------------------------------------------------------


def test_health_probe_reports_missing_key(monkeypatch):
    _set_env(monkeypatch, AI_API_KEY=None, OPENAI_API_KEY=None)
    body = client.get("/api/health?probe=true").json()
    assert body["perception"]["probe"] == "not_configured"


def test_health_probe_classifies_a_rejected_key(monkeypatch):
    import sys

    class AuthenticationError(Exception):
        pass

    class _Models:
        def retrieve(self, model):
            raise AuthenticationError("bad key")

    class _OpenAI:
        def __init__(self, **kwargs):
            self.models = _Models()

    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=_OpenAI))
    _set_env(monkeypatch, AI_API_KEY="sk-probe-test-rejected")
    vision._probe_cache.clear()
    body = client.get("/api/health?probe=true&force=true").json()
    assert body["perception"]["probe"] == "key_rejected"
    vision._probe_cache.clear()


# --- cross-check regressions: wording that must NEVER pass ------------------------------------------


@pytest.mark.parametrize("reading", ["cap missing.", "Cap - missing!", "cap (missing)", "cap: none", "cap absent from bottle",
                                     "empty cap slot", "without cap"])
def test_absent_component_wordings_never_count_as_present(reading):
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear",
                              "observations": _clean_without("components", extra=[_obs("components", ["label", reading])])}])
    assert checks["component_check"]["status"] == "FAIL", (reading, checks["component_check"])


def test_unseen_and_defective_components_are_not_present():
    assert evaluate_component_check(["cap"], [], []) ["status"] == "UNCERTAIN"
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear",
                              "observations": _clean_without("components", extra=[_obs("components", ["label", "cap not visible"])])}])
    assert checks["component_check"]["status"] == "UNCERTAIN"
    decision, checks = _run([{"image_id": "IMG-1", "visibility": "clear",
                              "observations": _clean_without("components", extra=[_obs("components", ["broken cap", "label"])])}],
                            po={**PO, "expected_components": ["cap", "label"]})
    assert checks["component_check"]["status"] == "UNCERTAIN" and checks["component_check"]["reason_code"] == "COMPONENT_DEFECT"


@pytest.mark.parametrize("reading,status", [
    ("not intact", "FAIL"), ("no damage, one corner crushed", "FAIL"), ("not damaged; torn corner", "FAIL"),
    ("no visible damage except dent", "FAIL"), ("not sealed", "FAIL"), ("no seal", "FAIL"), ("no tape", "FAIL"),
    ("not visible, possibly crushed", "UNCERTAIN"), ("possibly wet", "UNCERTAIN"), ("no labels on box", "UNCERTAIN"),
    ("sealed and intact", "PASS"), ("no signs of crushing or tears", "PASS"),
])
def test_mixed_and_negated_damage_clauses(reading, status):
    assert evaluate_damage_check(reading)["status"] == status, (reading, evaluate_damage_check(reading))


@pytest.mark.parametrize("po_variant,read", [
    ("Large", "X-Large"), ("Large", "Extra Large"), ("Medium", "Medium / Large"), ("Blue", "Sky Blue"),
    ("Blue", "Baby Blue"), ("Blue", "not blue"), ("500 ml", "500 ml x 2"), ("Mint", "Mint Chocolate"),
])
def test_different_variants_never_pass(po_variant, read):
    assert evaluate_variant_check(po_variant, read)["status"] == "UNCERTAIN", (po_variant, read)


@pytest.mark.parametrize("po_sku,read", [
    ("REF-100", "ART-100"), ("REF-100", "ITEM 100"), ("REF-100", "100"), ("ART-22", "ITEM 22"),
    ("PART-100", "MODEL 100"), ("REFILL-2", "ILL-2"), ("SKUA-1", "A-1"),
])
def test_sku_label_stripping_never_merges_different_skus(po_sku, read):
    assert evaluate_sku_check(po_sku, read)["status"] != "PASS", (po_sku, read)


@pytest.mark.parametrize("po_sku,read", [("REF-100", "SKU: REF-100"), ("REF-100", "REF-100"), ("REF-100", "ref 100"),
                                         ("ITEM-5", "Item # ITEM-5"), ("BLUE-BOTTLE-001", "SKU: SKU: BLUE-BOTTLE-001")])
def test_sku_with_label_prefixes_still_passes(po_sku, read):
    assert evaluate_sku_check(po_sku, read)["status"] == "PASS", (po_sku, read)


def test_image_id_copied_with_view_suffix_is_matched():
    decision, _ = _run([{"image_id": "IMG-1 view=pallet", "visibility": "clear", "observations": CLEAN}])
    assert decision == "PASS"


def test_malformed_fields_do_not_discard_the_run():
    obs = CLEAN + [{"check_type": "Damage", "observation": "none", "confidence": 0.9, "description": "x"},
                   {"check_type": "bogus", "observation": 1, "confidence": 0.9},
                   {"check_type": "carton", "observation": True, "confidence": 0.99},
                   {"check_type": "components", "observation": ["cap", None, {"x": 1}], "confidence": 0.9},
                   {"check_type": "sku"}]
    decision, checks = _run([{"image_id": "IMG-1", "visibility": None, "shows_whole_shipment": True, "observations": obs}])
    assert checks["carton_check"]["status"] == "PASS"  # True was not counted as "1 carton"
    assert decision in {"PASS", "UNCERTAIN"}


def test_json_with_trailing_fence_is_extracted():
    assert json.loads(vision._extract_json('{"images": []}\n```')) == {"images": []}
