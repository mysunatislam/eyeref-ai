"""The audit log: who changed or read research data, and when, kept even after a subject is deleted."""

import json

import cv2
import numpy as np
import pytest
from cryptography.fernet import Fernet
from databases import fresh_database
from eyeref.api.auth import AuthConfig, fingerprint
from eyeref.api.main import create_app
from eyeref.db import models as m
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session

TOKEN = "a" * 32
OTHER = "b" * 32


def _app(tmp_path, monkeypatch, tokens=(TOKEN,)):
    monkeypatch.setenv("EYEREF_STORAGE_KEY", Fernet.generate_key().decode())
    return create_app(fresh_database(tmp_path), data_dir=str(tmp_path), auth=AuthConfig(tokens))


def _as(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    c = TestClient(_app(tmp_path, monkeypatch))
    c.headers.update(_as(TOKEN))
    return c


def _png() -> bytes:
    ok, buf = cv2.imencode(".png", np.full((8, 8, 3), 90, np.uint8))
    assert ok
    return buf.tobytes()


def _subject(c, code="SITE1-0042", images=True):
    r = c.post("/api/subjects", json={"code": code, "consent_research": True, "consent_image_storage": images,
                                      "consent_version": "v2"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _session(c, subject_id):
    return c.post("/api/sessions", json={"subject_id": subject_id, "device_id": "generic-phone-rear"}).json()["id"]


def _capture(c, session_id, image=None):
    files = {"image": ("e.png", image, "image/png")} if image else None
    return c.post(f"/api/sessions/{session_id}/captures", files=files,
                  data={"metadata": json.dumps({"eye": "OD", "working_distance_m": 1.0})})


def _trail(c, **params):
    r = c.get("/api/audit", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_every_change_and_read_is_recorded_once_with_who_did_it(client):
    assert client.post("/api/devices", json={"id": "lab-phone", "calibration_version": "lab-2026-10"}).status_code == 200
    sid = _subject(client)
    gt = client.post(f"/api/subjects/{sid}/ground-truth",
                     json={"eye": "OD", "method": "autorefractor", "sphere": -3.25, "cylinder": -0.5, "axis": 90}).json()
    ses = _session(client, sid)
    with_image = _capture(client, ses, _png()).json()
    without = _capture(client, ses).json()
    report = client.post("/api/simulate", json={"frames_per_meridian": 2, "meridians": [0, 90]}).json()["report"]
    predicted = client.post(f"/api/sessions/{ses}/predictions", json=report).json()
    assert client.get("/api/subjects").status_code == 200
    assert client.get("/api/dataset/export").status_code == 200
    assert client.delete(f"/api/subjects/{sid}").status_code == 200

    events = _trail(client)["events"][::-1]  # oldest first
    assert [e["action"] for e in events] == [
        "device.save", "subject.create", "ground_truth.add", "session.create", "capture.add", "capture.add",
        "prediction.add", "subject.list", "dataset.export", "subject.delete",
    ]
    assert {e["actor"] for e in events} == {fingerprint(TOKEN)}
    assert [e["subject_id"] for e in events] == [None, sid, sid, sid, sid, sid, sid, None, None, sid]
    assert [e["id"] for e in events] == sorted(e["id"] for e in events)
    assert all(e["at"].endswith("+00:00") for e in events)
    details = [e["details"] for e in events]
    assert details[0] == {"device_id": "lab-phone", "calibration_version": "lab-2026-10"}
    assert details[1] == {"consent_research": True, "consent_image_storage": True, "consent_version": "v2"}
    assert details[2] == {"ground_truth_id": gt["id"], "session_id": None, "eye": "OD", "method": "autorefractor"}
    assert details[3] == {"session_id": ses, "device_id": "generic-phone-rear", "simulated": False}
    assert details[4] == {"session_id": ses, "capture_id": with_image["id"], "eye": "OD", "image_stored": True}
    assert details[5] == {"session_id": ses, "capture_id": without["id"], "eye": "OD", "image_stored": False}
    assert details[6] == {"session_id": ses, "prediction_ids": predicted["ids"]}
    assert details[7] == {"subjects": 1}
    assert details[8] == {"format": "csv", "include_simulated": False, "rows": 2, "subjects": 1}
    assert details[9] == {"images_deleted": 1}


def test_predictions_return_the_ids_they_were_stored_under(client):
    ses = _session(client, _subject(client))
    report = client.post("/api/simulate", json={"frames_per_meridian": 2, "meridians": [0, 90]}).json()["report"]
    ids = client.post(f"/api/sessions/{ses}/predictions", json=report).json()["ids"]
    assert len(ids) == len(report["eyes"]) == 2
    assert all(isinstance(i, str) and len(i) == 32 for i in ids)


def test_the_trail_outlives_the_subject_and_holds_no_personal_data(client):
    sid = _subject(client, code="SITE1-0042")
    client.post(f"/api/subjects/{sid}/ground-truth",
                json={"eye": "OS", "method": "subjective", "sphere": -3.25, "cylinder": 0, "examiner": "Dr Rahman",
                      "instrument": "Topcon KR-800", "raw": {"note": "patient wore glasses"}})
    assert client.delete(f"/api/subjects/{sid}").status_code == 200
    assert client.get("/api/subjects").json() == []

    trail = _trail(client, subject_id=sid)
    assert [e["action"] for e in trail["events"]] == ["subject.delete", "ground_truth.add", "subject.create"]
    text = json.dumps(_trail(client))
    for personal in ("SITE1-0042", "-3.25", "Dr Rahman", "Topcon", "glasses"):
        assert personal not in text


def test_the_actor_is_the_token_fingerprint_never_the_token(tmp_path, monkeypatch):
    c = TestClient(_app(tmp_path, monkeypatch, tokens=(TOKEN, OTHER)))
    assert c.get("/api/audit").status_code == 401
    _subject(TestClient(c.app, headers=_as(TOKEN)), code="A-1")
    _subject(TestClient(c.app, headers=_as(OTHER)), code="B-1")

    r = c.get("/api/audit", headers=_as(OTHER))
    actors = [e["actor"] for e in r.json()["events"]]
    assert actors == [fingerprint(OTHER), fingerprint(TOKEN)]
    assert fingerprint(TOKEN) != fingerprint(OTHER) and fingerprint(TOKEN).startswith("tok_")
    assert TOKEN not in r.text and OTHER not in r.text


def test_without_auth_the_actor_is_anonymous(tmp_path, monkeypatch):
    c = TestClient(_app(tmp_path, monkeypatch, tokens=()))
    _subject(c)
    assert [e["actor"] for e in _trail(c)["events"]] == ["anonymous"]


def test_a_refused_action_leaves_no_record(client):
    assert client.post("/api/subjects", json={"code": "X-1", "consent_research": False}).status_code == 403
    sid = _subject(client, code="X-1", images=False)
    assert client.post("/api/subjects", json={"code": "X-1", "consent_research": True}).status_code == 409
    assert client.post("/api/subjects/nope/ground-truth",
                       json={"eye": "OD", "method": "autorefractor", "sphere": 0, "cylinder": 0}).status_code == 404
    ses = _session(client, sid)
    assert _capture(client, ses, _png()).status_code == 403  # no image consent
    assert _capture(client, "nope").status_code == 404
    assert client.delete("/api/subjects/nope").status_code == 404
    assert [e["action"] for e in _trail(client)["events"]] == ["session.create", "subject.create"]


def test_an_export_is_not_sent_unless_its_record_is_saved(tmp_path, monkeypatch):
    c = TestClient(_app(tmp_path, monkeypatch), raise_server_exceptions=False, headers=_as(TOKEN))
    ses = _session(c, _subject(c))
    assert _capture(c, ses).status_code == 200

    def refuse_the_record(session, flush_context, instances):
        if any(isinstance(o, m.AuditEvent) and o.action == "dataset.export" for o in session.new):
            raise RuntimeError("the database refused the write")

    event.listen(Session, "before_flush", refuse_the_record)
    try:
        r = c.get("/api/dataset/export")
    finally:
        event.remove(Session, "before_flush", refuse_the_record)
    assert r.status_code == 500 and "SITE1-0042" not in r.text
    assert [e["action"] for e in _trail(c)["events"]][0] == "capture.add"


def test_the_trail_pages_back_in_time_and_filters(client):
    for i in range(5):
        _subject(client, code=f"P-{i}")
    client.get("/api/subjects")

    seen, before = [], None
    while True:
        page = _trail(client, limit=2, **({"before": before} if before else {}))
        assert len(page["events"]) <= 2
        seen += page["events"]
        before = page["next_before"]
        if before is None:
            break
    assert [e["id"] for e in seen] == sorted((e["id"] for e in seen), reverse=True)
    assert seen == _trail(client)["events"] and len(seen) == 6

    created = _trail(client, action="subject.create")["events"]
    assert len(created) == 5 and {e["action"] for e in created} == {"subject.create"}
    assert client.get("/api/audit", params={"limit": 0}).status_code == 422
    assert client.get("/api/audit", params={"limit": 1001}).status_code == 422
