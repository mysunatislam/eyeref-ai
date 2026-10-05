import json

import httpx
import pytest
from databases import fresh_database
from eyeref.api.main import create_app
from eyeref.assistant.core import SYSTEM_RULES, AssistantConfigError, AssistantUnavailable, explain_report
from eyeref.assistant.guard import guard_text
from eyeref.assistant.ollama import OllamaClient, OllamaConfig
from eyeref.assistant.provider import config_from_env
from fastapi.testclient import TestClient
from test_assistant import _report


def _ollama(answer: str, seen: list, models=("gemma3:4b",)):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": m} for m in models]})
        return httpx.Response(200, json={"message": {"role": "assistant", "content": answer}, "done": True})
    return httpx.MockTransport(handler)


def _app(tmp_path, transport):
    return TestClient(create_app(fresh_database(tmp_path), data_dir=str(tmp_path),
                                 assistant_client_factory=lambda cfg: OllamaClient(cfg, transport=transport,
                                                                                   sleep=lambda s: None)))


def _body(consent=False):
    return {"report": _report().model_dump(mode="json"), "consent_third_party": consent}


def test_default_provider_is_local_ollama(monkeypatch):
    for k in ("EYEREF_ASSISTANT", "OLLAMA_BASE_URL", "OLLAMA_MODEL"):
        monkeypatch.delenv(k, raising=False)
    cfg = config_from_env()
    assert isinstance(cfg, OllamaConfig) and cfg.is_local and cfg.model == "gemma3:4b"


def test_off_switch(monkeypatch, tmp_path):
    monkeypatch.setenv("EYEREF_ASSISTANT", "off")
    c = TestClient(create_app(fresh_database(tmp_path), data_dir=str(tmp_path)))
    assert c.get("/api/assistant/status").json()["configured"] is False
    assert c.post("/api/assistant/explain", json=_body()).status_code == 503


def test_remote_plain_http_ollama_is_refused(monkeypatch):
    monkeypatch.setenv("EYEREF_ASSISTANT", "ollama")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://gpu-box.example.com:11434")
    with pytest.raises(AssistantConfigError):
        config_from_env()


def test_local_model_needs_no_third_party_consent_and_sends_chat(monkeypatch, tmp_path):
    monkeypatch.delenv("EYEREF_ASSISTANT", raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    seen: list = []
    c = _app(tmp_path, _ollama("This is a screening estimate, not a prescription.", seen))
    st = c.get("/api/assistant/status").json()
    assert st["available"] and st["provider"] == "ollama" and st["third_party"] is False
    assert "on this computer" in st["label"]
    r = c.post("/api/assistant/explain", json=_body(consent=False))
    assert r.status_code == 200 and "screening estimate" in r.json()["text"]
    chat = json.loads(seen[-1].content)
    assert seen[-1].url.path == "/api/chat" and chat["stream"] is False
    assert chat["messages"][0] == {"role": "system", "content": SYSTEM_RULES}
    assert "image" not in chat["messages"][1]["content"].lower()


def test_remote_ollama_requires_consent(monkeypatch, tmp_path):
    monkeypatch.setenv("OLLAMA_BASE_URL", "https://llm.example.com")
    c = _app(tmp_path, _ollama("ok", []))
    assert c.get("/api/assistant/status").json()["third_party"] is True
    assert c.post("/api/assistant/explain", json=_body(consent=False)).status_code == 403
    assert c.post("/api/assistant/explain", json=_body(consent=True)).status_code == 200


def test_status_reports_missing_model(monkeypatch, tmp_path):
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    c = _app(tmp_path, _ollama("ok", [], models=("llama3:8b",)))
    st = c.get("/api/assistant/status").json()
    assert st["available"] is False and "ollama pull gemma3:4b" in st["reason"]


def test_ollama_not_running_is_503_with_hint(monkeypatch, tmp_path):
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)

    def down(request):
        raise httpx.ConnectError("refused")
    c = _app(tmp_path, httpx.MockTransport(down))
    assert c.get("/api/assistant/status").json()["available"] is False
    r = c.post("/api/assistant/explain", json=_body())
    assert r.status_code == 503 and "not running" in r.json()["detail"]


def test_missing_model_on_chat_is_unavailable():
    t = httpx.MockTransport(lambda req: httpx.Response(404, json={"error": "model not found"}))
    with pytest.raises(AssistantUnavailable):
        explain_report(_report(), None, OllamaClient(OllamaConfig(), transport=t))


@pytest.mark.parametrize("reply", [
    "Your sphere is -3.25 and cylinder -0.75 at 180°.",
    "I estimate about -2.75 in the right eye.",
    "Roughly minus 3 for the left eye.",
    "Your prescription is probably SPH -2.00 CYL -0.50 AXIS 90.",
    "SE -4.00 D, so glasses of -4.00 should work.",
])
def test_guard_catches_small_model_prescription_leaks(reply):
    seen: list = []
    ans = explain_report(_report(), None, OllamaClient(OllamaConfig(), transport=_ollama(reply, seen)))
    for bad in ("-3.25", "-0.75", "180", "-2.75", "minus 3", "-2.00", "-0.50", "AXIS 90", "-4.00"):
        assert bad not in ans.text, (reply, ans.text)
    assert ans.redactions >= 1


def test_guard_keeps_report_values_and_ordinary_numbers():
    text, n = guard_text("Your SE is -2.50 D (interval -3.20 to -1.80 D). Confidence 93%. See a doctor within 2 weeks.",
                         {2.5, -2.5, -3.2, 3.2, -1.8, 1.8, 93})
    assert n == 0 and "-2.50 D" in text and "2 weeks" in text and "93%" in text
