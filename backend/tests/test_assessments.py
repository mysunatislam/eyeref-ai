"""POST /api/assessments: one record from the web app, stored all or nothing, safe to send again."""

import copy
import json

import cv2
import numpy as np
import pytest
from databases import fresh_database
from eyeref.api.main import create_app
from eyeref.db import models as m
from eyeref.simulation.cohort import SessionConfig, make_subject, run_simulated_assessment
from eyeref.storage import LocalStorage
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

GT = [{"eye": "OD", "method": "autorefractor", "sphere": -2.0, "cylinder": -0.5, "axis": 180},
      {"eye": "OS", "method": "autorefractor", "sphere": -1.75, "cylinder": 0, "axis": None}]
CUSTOM_PHONE = {"id": "custom-lab1", "manufacturer": "lab", "model": "Phone A", "camera": "rear", "hfov_deg": 68,
                "flash_offset_mm": [0, -8.5], "aperture_diameter_mm": 2.6, "calibration_version": "lab-2026-10-01"}


@pytest.fixture(scope="module")
def simulated():
    subj = make_subject("SIM-UPLOAD", "adult_18_39")
    rep, recs, _ = run_simulated_assessment(
        subj, session_cfg=SessionConfig(device_rotations_deg=[0, 90], frames_per_meridian=2))
    frames = [r.model_dump(mode="json", exclude={"features": {"profile_perpendicular"}}) for r in recs]
    return frames, rep.model_dump(mode="json")


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app(fresh_database(tmp_path), data_dir=str(tmp_path)))


def _png(value: int) -> bytes:
    ok, buf = cv2.imencode(".png", np.full((8, 8, 3), value, np.uint8))
    assert ok
    return buf.tobytes()


def _record(simulated, ref="rec-1", code="SITE1-0007", images=0, image_consent=None):
    frames, report = simulated
    captures = [{"metadata": f["metadata"], "features": f["features"], "quality": f["quality"],
                 "image": i if i < images else None} for i, f in enumerate(frames)]
    return copy.deepcopy({
        "client_ref": ref,
        "subject": {"code": code, "age_group": "adult_18_39", "consent_research": True, "consent_version": "v1",
                    "consent_image_storage": images > 0 if image_consent is None else image_consent},
        "ground_truth": GT,
        "session": {"device_id": "simulated-phone", "protocol_version": "guided-1", "simulated": True},
        "captures": captures,
        "report": report,
    })


def _send(client, record, images=()):
    files = [("images", (f"c{i}.png", data, "image/png")) for i, data in enumerate(images)]
    return client.post("/api/assessments", data={"record": json.dumps(record)}, files=files or None)


def _stored_images(tmp_path):
    return sorted(p.read_bytes() for p in (tmp_path / "objects").rglob("*.png"))


def _trail(client):
    return [(e["action"], e["details"]) for e in client.get("/api/audit").json()["events"][::-1]]


def test_a_record_is_stored_in_one_request(client, simulated, tmp_path):
    images = [_png(v) for v in (10, 20, 30)]
    r = _send(client, _record(simulated, images=3), images)
    assert r.status_code == 201, r.text
    out = r.json()
    n = len(simulated[0])
    assert out["already_uploaded"] is False and out["subject_created"] is True
    assert (out["captures"], out["images_stored"], len(out["prediction_ids"])) == (n, 3, 2)

    [subject] = client.get("/api/subjects").json()
    assert subject["id"] == out["subject_id"] and subject["consent_image_storage"] is True
    rows = client.get("/api/dataset/export", params={"fmt": "json", "include_simulated": True}).json()
    assert len(rows) == n and {r["session_id"] for r in rows} == {out["session_id"]}
    assert {r["eye"]: r["gt_autorefractor_se"] for r in rows} == {"OD": -2.25, "OS": -1.75}
    assert _stored_images(tmp_path) == sorted(images)
    assert _trail(client)[:2] == [
        ("subject.create", {"consent_research": True, "consent_image_storage": True, "consent_version": "v1"}),
        ("assessment.upload", {"session_id": out["session_id"], "ground_truths": 2, "captures": n,
                               "images_stored": 3, "prediction_ids": out["prediction_ids"]}),
    ]


def test_sending_the_same_record_again_stores_nothing_twice(client, simulated, tmp_path):
    record, images = _record(simulated, images=2), [_png(1), _png(2)]
    first = _send(client, record, images).json()
    trail = _trail(client)

    again = _send(client, record, images)
    assert again.status_code == 200
    assert again.json() == {**first, "already_uploaded": True, "subject_created": False}
    assert len(client.get("/api/dataset/export", params={"include_simulated": True, "fmt": "json"}).json()) == len(
        simulated[0])
    assert len(_stored_images(tmp_path)) == 2
    assert _trail(client)[: len(trail)] == trail and len(_trail(client)) == len(trail) + 1  # only the export


def test_a_returning_subject_gets_another_session(client, simulated):
    first = _send(client, _record(simulated, ref="visit-1")).json()
    second = _send(client, _record(simulated, ref="visit-2", images=1), [_png(5)])
    assert second.status_code == 201, second.text
    second = second.json()
    assert second["subject_id"] == first["subject_id"] and second["subject_created"] is False
    assert second["session_id"] != first["session_id"]
    [subject] = client.get("/api/subjects").json()
    assert subject["consent_image_storage"] is True  # granted at the second visit
    actions = [a for a, _ in _trail(client)]
    assert actions[:4] == ["subject.create", "assessment.upload", "subject.consent", "assessment.upload"]


def test_each_visit_is_paired_with_its_own_reference_and_dated_by_its_captures(client, simulated):
    visits = [_record(simulated, ref=f"visit-{i}") for i in (1, 2, 3)]
    visits[1]["ground_truth"] = [{"eye": "OD", "method": "autorefractor", "sphere": -3.0, "cylinder": 0}]
    visits[2]["ground_truth"] = []
    for week, rec in enumerate(visits):  # photographed a week apart, all uploaded today
        for j, c in enumerate(rec["captures"]):
            c["metadata"]["timestamp"] = f"2026-09-{1 + 7 * week:02d}T10:{j // 60:02d}:{j % 60:02d}Z"
    ids = [_send(client, rec).json()["session_id"] for rec in visits]

    rows = client.get("/api/dataset/export", params={"fmt": "json", "include_simulated": True}).json()
    assert {(r["session_id"], r["eye"]): r.get("gt_autorefractor_se") for r in rows} == {
        (ids[0], "OD"): -2.25, (ids[0], "OS"): -1.75,
        (ids[1], "OD"): -3.0, (ids[1], "OS"): None,  # none taken for that eye at this visit, and none borrowed
        (ids[2], "OD"): None, (ids[2], "OS"): None,
    }
    started = {r["session_id"]: r["session_started_at"] for r in rows}
    assert [started[i] for i in ids] == [f"2026-09-{d:02d}T10:00:00+00:00" for d in (1, 8, 15)]


def _break(record, how):
    if how == "no research consent":
        record["subject"]["consent_research"] = False
    elif how == "images without image consent":
        record["subject"]["consent_image_storage"] = False
    elif how == "an image no capture names":
        record["captures"][1]["image"] = None
    elif how == "two captures naming one image":
        record["captures"][1]["image"] = 0
    elif how == "a real capture in a simulated session":
        record["captures"][3]["metadata"]["simulated"] = False
    elif how == "a real report in a simulated session":
        record["report"]["simulated"] = False
    elif how == "an unknown device":
        record["session"]["device_id"] = record["report"]["provenance"]["device_profile"] = "custom-unknown"
    elif how == "a device that is not the session's":
        record["device"] = CUSTOM_PHONE
    elif how == "a report from another device":
        record["report"]["provenance"]["device_profile"] = "generic-phone-rear"
    elif how == "a malformed capture":
        del record["captures"][0]["metadata"]["eye"]
    return record


@pytest.mark.parametrize("how, status", [
    ("no research consent", 403),
    ("images without image consent", 403),
    ("an image no capture names", 422),
    ("two captures naming one image", 422),
    ("a real capture in a simulated session", 422),
    ("a real report in a simulated session", 422),
    ("an unknown device", 404),
    ("a device that is not the session's", 422),
    ("a report from another device", 422),
    ("a malformed capture", 422),
    ("a JPEG crop", 415),
])
def test_nothing_is_stored_when_any_part_is_refused(client, simulated, tmp_path, how, status):
    images = [_png(1), _png(2)]
    if how == "a JPEG crop":
        ok, jpg = cv2.imencode(".jpg", np.zeros((8, 8, 3), np.uint8))
        images[1] = jpg.tobytes()
    r = _send(client, _break(_record(simulated, images=2), how), images)
    assert r.status_code == status, r.text
    assert client.get("/api/subjects").json() == []
    assert _stored_images(tmp_path) == []
    assert [a for a, _ in _trail(client)] == ["subject.list"]


def test_a_failure_part_way_leaves_no_rows_and_no_images(tmp_path, simulated, monkeypatch):
    client = TestClient(create_app(fresh_database(tmp_path), data_dir=str(tmp_path)), raise_server_exceptions=False)
    put = LocalStorage.put
    calls = []

    def failing_put(self, key, data):
        calls.append(key)
        if len(calls) == 3:
            raise OSError("disk full")
        put(self, key, data)

    monkeypatch.setattr(LocalStorage, "put", failing_put)
    r = _send(client, _record(simulated, images=4), [_png(v) for v in range(4)])
    assert r.status_code == 500 and len(calls) == 3
    assert _stored_images(tmp_path) == []
    monkeypatch.setattr(LocalStorage, "put", put)

    def refuse_commit(session, flush_context, instances):
        if any(isinstance(o, m.AuditEvent) and o.action == "assessment.upload" for o in session.new):
            raise RuntimeError("the database went away")

    event.listen(Session, "before_flush", refuse_commit)
    try:
        r = _send(client, _record(simulated, images=4), [_png(v) for v in range(4)])
    finally:
        event.remove(Session, "before_flush", refuse_commit)
    assert r.status_code == 500
    assert _stored_images(tmp_path) == []
    assert client.get("/api/subjects").json() == []
    r = _send(client, _record(simulated, images=4), [_png(v) for v in range(4)])
    assert r.status_code == 201, r.text  # and the same record goes through once the fault is gone


def test_the_same_record_arriving_twice_at_once_is_stored_once(tmp_path, simulated):
    url = fresh_database(tmp_path)
    client = TestClient(create_app(url, data_dir=str(tmp_path)))
    other = create_engine(url)
    fired = []

    def the_other_request_wins(session, flush_context, instances):
        # Fires on the upload's first write, after it checked that the record was new: another request
        # stores the same record first, as two taps on a slow connection would.
        if fired or not any(isinstance(o, m.Subject) for o in session.new):
            return
        fired.append(True)
        with other.begin() as conn:
            conn.execute(text("INSERT INTO subjects (id, code, age_group, consent_research, consent_image_storage, "
                              "simulated, created_at) VALUES ('s-other', 'SITE1-0007', 'adult_18_39', true, false, "
                              "false, CURRENT_TIMESTAMP)"))
            conn.execute(text("INSERT INTO devices (id, manufacturer, model, camera, profile, calibration_version, "
                              "created_at) VALUES ('simulated-phone', 'simulation', 'sim', 'rear', '{}', "
                              "'sim-bench-1', CURRENT_TIMESTAMP)"))
            conn.execute(text("INSERT INTO capture_sessions (id, subject_id, device_id, protocol_version, cycloplegia, "
                              "simulated, started_at, client_ref) VALUES ('ses-other', 's-other', 'simulated-phone', "
                              "'guided-1', false, true, CURRENT_TIMESTAMP, 'rec-1')"))

    event.listen(Session, "before_flush", the_other_request_wins)
    try:
        r = _send(client, _record(simulated, images=1), [_png(9)])
    finally:
        event.remove(Session, "before_flush", the_other_request_wins)
        other.dispose()
    assert fired and r.status_code == 200, r.text
    assert r.json()["already_uploaded"] is True and r.json()["session_id"] == "ses-other"
    assert _stored_images(tmp_path) == []
    assert len(client.get("/api/subjects").json()) == 1


def test_a_record_from_a_custom_calibrated_phone_registers_its_profile(client, simulated, tmp_path):
    record = _record(simulated)
    record["session"]["device_id"], record["device"] = CUSTOM_PHONE["id"], CUSTOM_PHONE
    record["report"]["provenance"]["device_profile"] = CUSTOM_PHONE["id"]
    r = _send(client, record)
    assert r.status_code == 201, r.text
    devices = {d["id"]: d for d in client.get("/api/devices").json()}
    assert devices["custom-lab1"]["calibration_version"] == "lab-2026-10-01"
    assert (tmp_path / "device_profiles" / "custom-lab1.json").exists()
    assert ("device.save", {"device_id": "custom-lab1", "calibration_version": "lab-2026-10-01"}) in _trail(client)

    second = _record(simulated, ref="rec-2")
    second["session"]["device_id"] = second["report"]["provenance"]["device_profile"] = "custom-lab1"
    # known now, so the profile need not be sent again
    assert _send(client, second).status_code == 201


def test_bad_json_in_a_form_field_is_a_422_not_a_500(client):
    sub = client.post("/api/subjects", json={"code": "J-1", "consent_research": True}).json()
    ses = client.post("/api/sessions", json={"subject_id": sub["id"], "device_id": "generic-phone-rear"}).json()
    r = client.post(f"/api/sessions/{ses['id']}/captures", data={"metadata": "{not json"})
    assert r.status_code == 422 and r.json()["detail"][0]["loc"][:2] == ["body", "metadata"]
    r = client.post("/api/assessments", data={"record": json.dumps({"client_ref": "x"})})
    assert r.status_code == 422 and {e["loc"][2] for e in r.json()["detail"]} >= {"subject", "session", "captures"}
