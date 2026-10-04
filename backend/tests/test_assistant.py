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
