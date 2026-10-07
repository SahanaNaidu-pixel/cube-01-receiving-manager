import base64
import json
import sys
import types

import pytest

from backend.tests.test_backend import (  # noqa: F401  (_fresh_settings is an autouse fixture)
    A, CLEAN, _create_inspection, _fresh_settings, _set_env, _upload, client,
)
from backend.app.core.config import GEMINI_BASE_URL, GEMINI_DEFAULT_MODEL, OLLAMA_BASE_URL, OLLAMA_DEFAULT_MODEL, get_settings


class _FakeChat:
    calls, init, content, finish_reason, error = [], {}, "", "stop", None

    def __init__(self, **kwargs):
        _FakeChat.init = kwargs
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        _FakeChat.calls.append(kwargs)
        if _FakeChat.error:
            raise _FakeChat.error
        message = types.SimpleNamespace(content=_FakeChat.content, refusal=None)
        return types.SimpleNamespace(model="gemini-test", choices=[types.SimpleNamespace(message=message, finish_reason=_FakeChat.finish_reason)])


def _gemini(monkeypatch, reply=None, content=None, finish_reason="stop", error=None):
    _FakeChat.calls, _FakeChat.finish_reason, _FakeChat.error = [], finish_reason, error
    _FakeChat.content = content if content is not None else json.dumps(reply or {"images": []})
    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=_FakeChat))
    _set_env(monkeypatch, AI_PROVIDER="gemini", GEMINI_API_KEY="AIza-test", DEMO_MODE="false",
             AI_API_KEY=None, OPENAI_API_KEY=None, AI_MODEL="gpt-4o-mini")


def _analyzed(monkeypatch, n=1, **kwargs):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid, n=n)
    if "reply" not in kwargs and "content" not in kwargs:
        kwargs["reply"] = {"images": [{"image_id": ids[0], "visibility": "clear", "observations": CLEAN}]}
    _gemini(monkeypatch, **kwargs)
    return ids, client.post(f"/api/inspections/{iid}/analyze", headers=A).json()


def test_gemini_preset_settings(monkeypatch):
    _set_env(monkeypatch, AI_PROVIDER="gemini", GEMINI_API_KEY="AIza-x", AI_MODEL="gpt-4o-mini", GEMINI_MODEL=None)
    s = get_settings()
    assert (s.ai_provider, s.ai_api_style, s.api_key, s.openai_base_url) == ("gemini", "chat", "AIza-x", GEMINI_BASE_URL)
    assert s.ai_model == GEMINI_DEFAULT_MODEL  # AI_MODEL is the OpenAI setting and is ignored for Gemini
    _set_env(monkeypatch, AI_PROVIDER=None)
    assert (get_settings().ai_provider, get_settings().ai_api_style) == ("openai", "responses")


def test_gemini_chat_request_is_blind_strict_and_decides(monkeypatch):
    ids, body = _analyzed(monkeypatch)
    assert body["decision"] == "PASS" and body["record"]["checks"][0]["model_version"] == "gemini-test"
    assert _FakeChat.init["base_url"] == GEMINI_BASE_URL and _FakeChat.init["api_key"] == "AIza-test"
    call = _FakeChat.calls[0]
    assert call["model"] == GEMINI_DEFAULT_MODEL
    assert call["response_format"]["type"] == "json_schema" and call["response_format"]["json_schema"]["strict"] is True
    parts = call["messages"][0]["content"]
    assert any(p["type"] == "image_url" and p["image_url"]["url"].startswith("data:image/") for p in parts)
    texts = " ".join(p.get("text", "") for p in parts)
    assert ids[0] in texts and "BLUE-BOTTLE-001" not in texts  # blind read


def test_gemini_fenced_json_is_accepted(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    ids = _upload(iid)
    reply = {"images": [{"image_id": ids[0], "visibility": "clear", "observations": CLEAN}]}
    _gemini(monkeypatch, content=f"```json\n{json.dumps(reply)}\n```")
    assert client.post(f"/api/inspections/{iid}/analyze", headers=A).json()["decision"] == "PASS"


def test_gemini_truncated_reply_fails_open(monkeypatch):
    _, body = _analyzed(monkeypatch, finish_reason="length")
    assert body["decision"] == "PENDING_REVIEW" and "finish_reason=length" in body["failure_reason"]


@pytest.mark.parametrize("name, expected", [
    ("AuthenticationError", "AuthenticationError: invalid Gemini API key"),
    ("RateLimitError", "RateLimitError: Gemini rate limit or quota exceeded; retry later"),
])
def test_gemini_errors_name_the_provider_without_the_key(monkeypatch, name, expected):
    _, body = _analyzed(monkeypatch, error=type(name, (Exception,), {})("API key not valid: AIza-test"))
    assert body["decision"] == "PENDING_REVIEW" and body["failure_reason"] == expected
    assert "AIza-test" not in json.dumps(body)


def test_gemini_missing_key_and_health(monkeypatch):
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    _set_env(monkeypatch, AI_PROVIDER="gemini", GEMINI_API_KEY=None, AI_API_KEY=None, DEMO_MODE="false")
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PENDING_REVIEW" and "GEMINI_API_KEY" in body["failure_reason"]
    health = client.get("/api/health").json()
    assert (health["provider"], health["model"], health["ai_configured"]) == ("gemini", GEMINI_DEFAULT_MODEL, False)


# --- Ollama (local, no key) ---------------------------------------------------------------------


def _ollama(monkeypatch, reply=None, error=None):
    _FakeChat.calls, _FakeChat.finish_reason, _FakeChat.error = [], "stop", error
    _FakeChat.content = json.dumps(reply or {"images": []})
    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=_FakeChat))
    _set_env(monkeypatch, AI_PROVIDER="ollama", DEMO_MODE="false", AI_TIMEOUT_S="45",
             AI_API_KEY=None, OPENAI_API_KEY=None, GEMINI_API_KEY=None, OLLAMA_MODEL=None)


def test_ollama_needs_no_key_and_is_tuned_for_local_cpu(monkeypatch):
    _ollama(monkeypatch)
    s = get_settings()
    assert (s.ai_provider, s.ai_api_style, s.openai_base_url) == ("ollama", "chat", OLLAMA_BASE_URL)
    assert s.ai_model == OLLAMA_DEFAULT_MODEL and s.api_key  # placeholder key; Ollama ignores it
    assert (s.ai_timeout_s, s.ai_max_retries, s.ai_image_max_edge) == (300, 0, 1024)  # AI_TIMEOUT_S=45 is for cloud APIs
    assert client.get("/api/health").json()["ai_configured"] is True


def test_ollama_gets_small_images_and_decides(monkeypatch):
    from io import BytesIO
    from PIL import Image
    iid = _create_inspection()["inspection_id"]
    out = BytesIO()
    Image.new("RGB", (3000, 2000), (180, 150, 120)).save(out, "JPEG")
    image_id = client.post(f"/api/inspections/{iid}/images", files=[("files", ("big.jpg", out.getvalue(), "image/jpeg"))],
                           data={"image_type": "pallet"}, headers=A).json()["images"][0]["image_id"]
    _ollama(monkeypatch, reply={"images": [{"image_id": image_id, "visibility": "clear", "observations": CLEAN}]})
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PASS"
    assert _FakeChat.init["max_retries"] == 0 and _FakeChat.init["timeout"] == 300
    url = next(p["image_url"]["url"] for p in _FakeChat.calls[0]["messages"][0]["content"] if p["type"] == "image_url")
    sent = Image.open(BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert max(sent.size) == 1024


@pytest.mark.parametrize("name, expected", [
    ("APIConnectionError", "APIConnectionError: could not reach Ollama on this computer; is the Ollama app running?"),
    ("NotFoundError", f"NotFoundError: model '{OLLAMA_DEFAULT_MODEL}' is not downloaded; run: ollama pull {OLLAMA_DEFAULT_MODEL}"),
])
def test_ollama_errors_say_what_to_do(monkeypatch, name, expected):
    iid = _create_inspection()["inspection_id"]
    _upload(iid)
    _ollama(monkeypatch, error=type(name, (Exception,), {})("boom"))
    body = client.post(f"/api/inspections/{iid}/analyze", headers=A).json()
    assert body["decision"] == "PENDING_REVIEW" and body["failure_reason"] == expected
