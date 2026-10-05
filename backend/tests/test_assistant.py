import httpx
from eyeref.api.main import create_app
from eyeref.assistant.guard import REDACTED, allowed_values, guard_text
from eyeref.assistant.maira import MairaClient, MairaConfig, explain_report, report_summary
from eyeref.inference.fusion import AssessmentReport, EyeResult, Provenance
from fastapi.testclient import TestClient


def _report():
    eyes = {
        "OD": EyeResult(eye="OD", output_level="quantitative", message="ok", se_d=-2.5, se_ci95=(-3.2, -1.8),
                        refractive_class="myopia", confidence=0.93),
        "OS": EyeResult(eye="OS", output_level="screening", message="screening only", refractive_class="myopia", confidence=0.85),
    }
    return AssessmentReport(simulated=True, eyes=eyes, interpretation="SIMULATED DATA. myopic pattern",
                            provenance=Provenance(model_name="m", model_version="1", estimator_kind="physics",
                                                  calibration_version="c", device_profile="d", extractor_version="x"))


def test_guard_redacts_invented_values():
    allowed = allowed_values([-2.5, -3.2, -1.8, 93])
    text, n = guard_text("Your SE is -2.50 D. You probably need SPH -2.75 and CYL -0.75 at axis 170°.", allowed)
    assert "-2.50 D" in text
    assert "-2.75" not in text and "-0.75" not in text and "170" not in text
    assert n >= 3 and REDACTED in text


def test_guard_neutralises_prescription_claims():
    text, n = guard_text("Your prescription is likely mild.", set())
    assert "prescription is" not in text.lower() and n == 1


def test_summary_contains_no_identifiers_and_only_report_numbers():
    s, allowed = report_summary(_report())
    assert "SIMULATED" in s and "-2.50" in s
    assert -2.5 in allowed and 93 in allowed


def _mock(answer: str, seen: list):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"status": "success", "detail": {"response": answer}})
    return httpx.MockTransport(handler)


def test_explain_report_uses_headers_and_guards():
    seen: list = []
    client = MairaClient(MairaConfig("k", "p", "https://example.test"), transport=_mock("SPH -4.00 D is my guess.", seen))
    ans = explain_report(_report(), None, client)
    req = seen[0]
    assert req.url.path == "/v1/maira/ask"
    assert req.headers["api-key"] == "k" and req.headers["project-key"] == "p"
    assert b"image" not in req.content.lower().replace(b"image quality", b"")
    assert "-4.00" not in ans.text and ans.redactions >= 1


def test_api_requires_config_and_consent(tmp_path, monkeypatch):
    monkeypatch.delenv("MAIRA_API_KEY", raising=False)
    c = TestClient(create_app("sqlite://", data_dir=str(tmp_path)))
    body = {"report": _report().model_dump(mode="json"), "consent_third_party": True}
    assert c.post("/api/assistant/explain", json=body).status_code == 503
    monkeypatch.setenv("MAIRA_API_KEY", "k")
    monkeypatch.setenv("MAIRA_PROJECT_KEY", "p")
    seen: list = []
    c = TestClient(create_app("sqlite://", data_dir=str(tmp_path),
                              assistant_client_factory=lambda cfg: MairaClient(cfg, transport=_mock("Screening only.", seen))))
    assert c.post("/api/assistant/explain", json={**body, "consent_third_party": False}).status_code == 403
    r = c.post("/api/assistant/explain", json=body)
    assert r.status_code == 200 and r.json()["text"] == "Screening only." and "Not a medical opinion" in r.json()["label"]


def _seq(responses: list, seen: list):
    it = iter(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        nxt = next(it)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt
    return httpx.MockTransport(handler)


def _ok(text="Screening only."):
    return httpx.Response(200, json={"detail": {"response": text}})


def test_config_repr_never_shows_keys():
    cfg = MairaConfig("secret-api-key", "secret-project", "https://example.test")
    assert "secret" not in repr(cfg)


def test_encrypted_key_is_decrypted_in_memory(monkeypatch):
    from cryptography.fernet import Fernet
    fk = Fernet.generate_key()
    monkeypatch.setenv("MAIRA_API_KEY", Fernet(fk).encrypt(b"plain-key").decode())
    monkeypatch.setenv("MAIRA_PROJECT_KEY", "p")
    monkeypatch.setenv("MAIRA_KEY_DECRYPTION_KEY", fk.decode())
    assert MairaConfig.from_env().api_key == "plain-key"


def test_bad_decryption_key_is_a_config_error_not_a_crash(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    monkeypatch.setenv("MAIRA_API_KEY", Fernet(Fernet.generate_key()).encrypt(b"x").decode())
    monkeypatch.setenv("MAIRA_PROJECT_KEY", "p")
    monkeypatch.setenv("MAIRA_KEY_DECRYPTION_KEY", Fernet.generate_key().decode())
    c = TestClient(create_app("sqlite://", data_dir=str(tmp_path)))
    assert c.get("/api/assistant/status").json()["configured"] is False
    body = {"report": _report().model_dump(mode="json"), "consent_third_party": True}
    r = c.post("/api/assistant/explain", json=body)
    assert r.status_code == 503 and "gAAAA" not in r.text


def test_encrypted_looking_key_without_decryption_key_is_sent_as_issued(monkeypatch):
    monkeypatch.setenv("MAIRA_API_KEY", "gAAAAAissued")
    monkeypatch.setenv("MAIRA_PROJECT_KEY", "p")
    monkeypatch.delenv("MAIRA_KEY_DECRYPTION_KEY", raising=False)
    assert MairaConfig.from_env().api_key == "gAAAAAissued"


def test_http_base_url_is_refused(monkeypatch):
    import pytest
    from eyeref.assistant.maira import AssistantConfigError
    monkeypatch.setenv("MAIRA_API_KEY", "k")
    monkeypatch.setenv("MAIRA_PROJECT_KEY", "p")
    monkeypatch.setenv("MAIRA_BASE_URL", "http://insecure.test")
    with pytest.raises(AssistantConfigError):
        MairaConfig.from_env()


def test_retries_transient_failures_then_succeeds():
    seen: list = []
    sleeps: list = []
    t = _seq([httpx.ConnectError("boom"), httpx.Response(503), _ok()], seen)
    client = MairaClient(MairaConfig("k", "p", "https://example.test", max_retries=2), transport=t, sleep=sleeps.append)
    assert explain_report(_report(), None, client).text == "Screening only."
    assert len(seen) == 3 and sleeps == [0.5, 1.0]


def test_gives_up_after_max_retries():
    import pytest
    seen: list = []
    t = _seq([httpx.Response(500)] * 3, seen)
    client = MairaClient(MairaConfig("k", "p", "https://example.test", max_retries=2), transport=t, sleep=lambda s: None)
    with pytest.raises(httpx.HTTPStatusError):
        client.ask("q")
    assert len(seen) == 3


def test_auth_failure_is_not_retried_and_hides_key(tmp_path, monkeypatch):
    monkeypatch.setenv("MAIRA_API_KEY", "super-secret-key")
    monkeypatch.setenv("MAIRA_PROJECT_KEY", "p")
    seen: list = []
    c = TestClient(create_app("sqlite://", data_dir=str(tmp_path),
                              assistant_client_factory=lambda cfg: MairaClient(
                                  cfg, transport=_seq([httpx.Response(401)] * 3, seen), sleep=lambda s: None)))
    body = {"report": _report().model_dump(mode="json"), "consent_third_party": True}
    r = c.post("/api/assistant/explain", json=body)
    assert r.status_code == 502 and "credentials" in r.text and "super-secret" not in r.text
    assert len(seen) == 1


def test_non_json_reply_is_a_clean_502(tmp_path, monkeypatch):
    monkeypatch.setenv("MAIRA_API_KEY", "k")
    monkeypatch.setenv("MAIRA_PROJECT_KEY", "p")
    c = TestClient(create_app("sqlite://", data_dir=str(tmp_path),
                              assistant_client_factory=lambda cfg: MairaClient(
                                  cfg, transport=_seq([httpx.Response(200, text="<html>")], []))))
    body = {"report": _report().model_dump(mode="json"), "consent_third_party": True}
    assert c.post("/api/assistant/explain", json=body).status_code == 502


def test_long_question_is_capped_and_still_guarded():
    seen: list = []
    client = MairaClient(MairaConfig("k", "p", "https://example.test"),
                         transport=_seq([_ok("Try CYL -1.25 axis 90.")], seen))
    ans = explain_report(_report(), "why? " * 400, client)
    assert len(seen[0].content) < 4000
    assert "-1.25" not in ans.text and ans.redactions >= 1
