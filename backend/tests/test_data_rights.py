"""A participant's rights over their data (docs/DATASET.md#consent-and-retention): a copy of everything stored
about them, withdrawing consent to store eye images, leaving the study, and eye images deleted once too old. A record
of an earlier visit, uploaded late or at the same moment, undoes none of them."""

import base64
import hashlib
import json
import threading
import time
from datetime import UTC, datetime, timedelta

import pytest
from cryptography.fernet import Fernet
from databases import SERVER_URL, fresh_database
from eyeref.api import main as api
from eyeref.api.images import RETENTION_ENV, RetentionConfigError, retention_days_from_env
from eyeref.api.main import create_app
from eyeref.db import models as m
from eyeref.simulation.cohort import SessionConfig, make_subject, run_simulated_assessment
from eyeref.storage import LocalStorage
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from test_assessments import _png, _record, _send, _stored_images, _trail


@pytest.fixture(scope="module")
def simulated():
    subj = make_subject("SIM-RIGHTS", "adult_18_39")
    rep, recs, _ = run_simulated_assessment(
        subj, session_cfg=SessionConfig(device_rotations_deg=[0, 90], frames_per_meridian=2))
    frames = [r.model_dump(mode="json", exclude={"features": {"profile_perpendicular"}}) for r in recs]
    return frames, rep.model_dump(mode="json")


@pytest.fixture()
def url(tmp_path):
    return fresh_database(tmp_path)


@pytest.fixture()
def client(url, tmp_path):
    return TestClient(create_app(url, data_dir=str(tmp_path)), raise_server_exceptions=False)


def _update(url, model, where, **values):
    """Changes rows directly, as time passing would."""
    engine = create_engine(url)
    try:
        with engine.begin() as conn:
            conn.execute(model.__table__.update().where(where).values(**values))
    finally:
        engine.dispose()


def _stored_days_ago(url, session_id, days):
    _update(url, m.Capture, (m.Capture.session_id == session_id) & m.Capture.image_key.is_not(None),
            image_stored_at=datetime.now(UTC) - timedelta(days=days))


def _dated(record, day):
    """The visit photographed on `day`."""
    for j, c in enumerate(record["captures"]):
        c["metadata"]["timestamp"] = f"{day}T10:{j // 60:02d}:{j % 60:02d}Z"
    return record


def _subject(client, sid):
    return next(x for x in client.get("/api/subjects").json() if x["id"] == sid)


def _captures(record):
    return [c for v in record["visits"] for c in v["captures"]]


def _shown(record):
    return sorted(base64.b64decode(c["image"].split(",", 1)[1]) for c in _captures(record) if c.get("image"))


def _export(client):
    return client.get("/api/dataset/export", params={"fmt": "json", "include_simulated": True}).json()


def test_withdrawing_image_consent_deletes_the_images_and_keeps_everything_else(client, simulated, tmp_path):
    first = _send(client, _record(simulated, ref="visit-1", images=2), [_png(1), _png(2)]).json()
    _send(client, _record(simulated, ref="visit-2", images=1), [_png(3)])
    _send(client, _record(simulated, ref="other", code="SITE1-0008", images=1), [_png(4)])
    sid, rows = first["subject_id"], _export(client)

    r = client.delete(f"/api/subjects/{sid}/images")
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["subject_id"], out["images_deleted"]) == (sid, 3)
    assert _stored_images(tmp_path) == [_png(4)]  # only the other participant's
    subject = _subject(client, sid)
    assert subject["consent_image_storage"] is False
    assert subject["images_withdrawn_at"] == out["images_withdrawn_at"]
    assert _export(client) == rows  # every capture, reference and result is kept
    record = client.get(f"/api/subjects/{sid}").json()
    assert len(_captures(record)) == 2 * len(simulated[0])
    assert not any(c["image_stored"] for c in _captures(record))
    assert ("subject.images_withdraw", {"images_deleted": 3}) in _trail(client)

    again = client.delete(f"/api/subjects/{sid}/images")
    assert again.status_code == 200 and again.json()["images_deleted"] == 0
    # the phone sending a record it already sent stores none of its images again
    resent = _send(client, _record(simulated, ref="visit-1", images=2), [_png(1), _png(2)])
    assert resent.status_code == 200 and resent.json()["already_uploaded"] is True
    assert resent.json()["images_stored"] == 0
    assert _stored_images(tmp_path) == [_png(4)]
    assert client.delete("/api/subjects/nobody/images").status_code == 404


def test_a_visit_from_before_the_withdrawal_cannot_store_images_or_give_the_consent_back(client, simulated, url,
                                                                                         tmp_path):
    sid = _send(client, _dated(_record(simulated, ref="visit-1", images=1), "2026-09-01"), [_png(1)]).json()["subject_id"]
    assert client.delete(f"/api/subjects/{sid}/images").status_code == 200
    # as if the participant withdrew on 20 September, while a phone that was offline still held an earlier visit
    _update(url, m.Subject, m.Subject.id == sid, images_withdrawn_at=datetime(2026, 9, 20, 12, tzinfo=UTC))
    trail = _trail(client)

    earlier = _dated(_record(simulated, ref="visit-2", images=1), "2026-09-08")
    r = _send(client, earlier, [_png(2)])
    assert r.status_code == 403
    assert "withdrew consent to store eye images on 2026-09-20, after this visit" in r.json()["detail"]
    assert _stored_images(tmp_path) == [] and _trail(client) == trail  # nothing stored, nothing changed

    earlier["captures"][0]["image"] = None  # sent again without its image, the rest of the visit is kept
    r = _send(client, earlier)
    assert r.status_code == 201, r.text
    earlier_visit = r.json()["session_id"]
    assert r.json()["images_stored"] == 0
    assert _subject(client, sid)["consent_image_storage"] is False  # the consent it carries was withdrawn since
    assert "subject.consent" not in [a for a, _ in _trail(client)]

    # at a visit after the withdrawal, the participant may consent again
    later = _send(client, _dated(_record(simulated, ref="visit-3", images=1), "2026-09-29"), [_png(3)]).json()
    assert later["images_stored"] == 1
    assert _subject(client, sid)["consent_image_storage"] is True
    assert ("subject.consent", {"consent_image_storage": True, "consent_version": "v1"}) in _trail(client)

    # which covers that visit's images, and never the earlier visit's
    meta = json.dumps(earlier["captures"][0]["metadata"])
    image = {"image": ("c.png", _png(4), "image/png")}
    r = client.post(f"/api/sessions/{earlier_visit}/captures", data={"metadata": meta}, files=image)
    assert r.status_code == 403 and "on 2026-09-20" in r.json()["detail"]
    r = client.post(f"/api/sessions/{later['session_id']}/captures", data={"metadata": meta}, files=image)
    assert r.status_code == 200 and r.json()["image_stored"] is True
    added = next(c for c in _captures(client.get(f"/api/subjects/{sid}").json()) if c["id"] == r.json()["id"])
    assert added["image_stored_at"] is not None
    assert _stored_images(tmp_path) == sorted([_png(3), _png(4)])


def test_a_record_from_before_a_participant_left_cannot_bring_them_back(client, simulated, url):
    sid = _send(client, _dated(_record(simulated, ref="visit-1"), "2026-09-01")).json()["subject_id"]
    assert client.delete(f"/api/subjects/{sid}").status_code == 200
    # as if they left on 20 September, while a phone that was offline still held an earlier visit
    _update(url, m.DeletedSubject, m.DeletedSubject.deleted_at.is_not(None),
            deleted_at=datetime(2026, 9, 20, 12, tzinfo=UTC))
    trail = _trail(client)

    for ref, day in (("visit-1", "2026-09-01"), ("visit-2", "2026-09-08")):  # sent again, or sent late
        r = _send(client, _dated(_record(simulated, ref=ref), day))
        assert r.status_code == 403
        assert "left the study on 2026-09-20, after this visit, so its record cannot be stored" in r.json()["detail"]
    assert _trail(client) == trail  # nothing stored, nothing recorded
    assert client.get("/api/subjects").json() == []

    # enrolled again at a later visit, they are a new subject, until they leave again
    again = _send(client, _dated(_record(simulated, ref="visit-3"), "2026-09-29"))
    assert again.status_code == 201 and again.json()["subject_created"] is True
    assert client.delete(f"/api/subjects/{again.json()['subject_id']}").status_code == 200
    r = _send(client, _dated(_record(simulated, ref="visit-3"), "2026-09-29"))
    assert r.status_code == 403 and "left the study on 2026-09-20" not in r.json()["detail"]

    engine = create_engine(url)
    try:
        with engine.connect() as conn:  # remembered by a hash of the code alone
            kept = conn.execute(select(m.DeletedSubject.code_sha256)).scalars().all()
    finally:
        engine.dispose()
    assert kept == [hashlib.sha256(b"eyeref-subject-code:SITE1-0007").hexdigest()]


@pytest.mark.parametrize("via", ["record", "capture"])
@pytest.mark.parametrize("how", ["withdraw", "delete the subject"])
def test_images_stored_while_the_participant_withdraws_are_deleted_too(url, tmp_path, simulated, monkeypatch, how,
                                                                       via):
    app = create_app(url, data_dir=str(tmp_path))
    client = TestClient(app)
    first = _send(client, _dated(_record(simulated, ref="visit-1", images=1), "2026-09-01"), [_png(1)]).json()
    sid = first["subject_id"]
    put, answers = LocalStorage.put, []

    def withdraw():
        path = f"/api/subjects/{sid}/images" if how == "withdraw" else f"/api/subjects/{sid}"
        answers.append(TestClient(app).delete(path))

    def put_while_withdrawing(self, key, data):
        if not hasattr(put_while_withdrawing, "withdrawal"):  # as the next visit's first image is stored
            put_while_withdrawing.withdrawal = threading.Thread(target=withdraw)
            put_while_withdrawing.withdrawal.start()
            put_while_withdrawing.withdrawal.join(timeout=1)  # it waits for this upload instead of missing it
        put(self, key, data)

    monkeypatch.setattr(LocalStorage, "put", put_while_withdrawing)
    if via == "record":
        r = _send(client, _dated(_record(simulated, ref="visit-2", images=2), "2026-09-08"), [_png(2), _png(3)])
        assert r.status_code == 201, r.text
    else:
        meta = json.dumps(_record(simulated)["captures"][0]["metadata"])
        r = client.post(f"/api/sessions/{first['session_id']}/captures", data={"metadata": meta},
                        files={"image": ("c.png", _png(2), "image/png")})
        assert r.status_code == 200, r.text
    put_while_withdrawing.withdrawal.join(timeout=30)
    [answer] = answers
    assert answer.status_code == 200 and answer.json()["images_deleted"] == (3 if via == "record" else 2), answer.text
    assert _stored_images(tmp_path) == []  # none left on disk, whatever order they finished in
    if how == "withdraw":
        assert not any(c["image_stored"] for c in _captures(client.get(f"/api/subjects/{sid}").json()))
    else:
        assert client.get("/api/subjects").json() == []


@pytest.mark.parametrize("via", ["record", "capture"])
def test_an_image_arriving_while_the_participant_withdraws_is_refused(url, tmp_path, simulated, monkeypatch, via):
    app = create_app(url, data_dir=str(tmp_path))
    client = TestClient(app)
    first = _send(client, _dated(_record(simulated, ref="visit-1", images=1), "2026-09-01"), [_png(1)]).json()
    delete, answers = LocalStorage.delete, []

    def upload():
        phone = TestClient(app)
        if via == "record":
            answers.append(_send(phone, _dated(_record(simulated, ref="visit-2", images=1), "2026-09-08"), [_png(2)]))
        else:
            meta = json.dumps(_record(simulated)["captures"][0]["metadata"])
            answers.append(phone.post(f"/api/sessions/{first['session_id']}/captures", data={"metadata": meta},
                                      files={"image": ("c.png", _png(2), "image/png")}))

    def delete_while_uploading(self, key):
        if not hasattr(delete_while_uploading, "upload"):  # as the withdrawal deletes the images
            delete_while_uploading.upload = threading.Thread(target=upload)
            delete_while_uploading.upload.start()
            delete_while_uploading.upload.join(timeout=1)  # it waits for the withdrawal, then sees it
        delete(self, key)

    monkeypatch.setattr(LocalStorage, "delete", delete_while_uploading)
    assert client.delete(f"/api/subjects/{first['subject_id']}/images").status_code == 200
    delete_while_uploading.upload.join(timeout=30)
    [answer] = answers
    assert answer.status_code == 403, answer.text
    assert "withdrew consent to store eye images" in answer.json()["detail"]
    assert _stored_images(tmp_path) == []


@pytest.mark.parametrize("encrypted", [False, True], ids=["plain", "encrypted"])
def test_a_participants_record_holds_everything_stored_about_them(url, tmp_path, simulated, monkeypatch, encrypted):
    if encrypted:
        monkeypatch.setenv("EYEREF_STORAGE_KEY", Fernet.generate_key().decode())
    client = TestClient(create_app(url, data_dir=str(tmp_path)))
    images = [_png(10), _png(20)]
    out = _send(client, _record(simulated, images=2), images).json()
    _send(client, _record(simulated, ref="other", code="SITE1-0008", images=1), [_png(30)])
    sid = out["subject_id"]
    later = {"eye": "OD", "method": "subjective", "sphere": -2.25, "cylinder": -0.5, "axis": 175}
    assert client.post(f"/api/subjects/{sid}/ground-truth", json=later).status_code == 200

    r = client.get(f"/api/subjects/{sid}")
    assert r.status_code == 200, r.text
    record = r.json()
    assert record["subject"]["code"] == "SITE1-0007" and record["subject"]["consent_image_storage"] is True
    [visit] = record["visits"]
    assert visit["id"] == out["session_id"] and visit["device_id"] == "simulated-phone"
    assert sorted((g["eye"], g["method"], g["sphere"]) for g in visit["references"]) == [
        ("OD", "autorefractor", -2.0), ("OS", "autorefractor", -1.75)]
    assert sorted(p["id"] for p in visit["results"]) == sorted(out["prediction_ids"])
    assert len(visit["captures"]) == out["captures"]
    assert sum(c["image_stored"] for c in visit["captures"]) == 2
    stored_at = [c["image_stored_at"] and datetime.fromisoformat(c["image_stored_at"]) for c in visit["captures"]]
    assert all((at is not None) == c["image_stored"] for at, c in zip(stored_at, visit["captures"], strict=True))
    assert all(datetime.now(UTC) - at < timedelta(minutes=5) for at in stored_at if at)  # the expiry counts from it
    assert all(c["image_encrypted"] is encrypted for c in visit["captures"] if c["image_stored"])
    assert not any("image_key" in c or "image" in c for c in visit["captures"])  # no images unless asked
    assert [(g["method"], g["session_id"]) for g in record["references_without_visit"]] == [("subjective", None)]
    assert datetime.fromisoformat(record["subject"]["created_at"]).utcoffset() == timedelta(0)  # times in UTC

    with_images = client.get(f"/api/subjects/{sid}", params={"include_images": True}).json()
    assert _shown(with_images) == sorted(images)  # decrypted, as they were sent
    assert (sorted(_stored_images(tmp_path)) == sorted(images + [_png(30)])) is not encrypted
    reads = [d for a, d in _trail(client) if a == "subject.read"]
    assert reads == [{"visits": 1, "images": 0}, {"visits": 1, "images": 2}]
    assert client.get("/api/subjects/nobody").status_code == 404


def test_images_stay_readable_when_encryption_is_switched_on_or_its_key_changes(url, tmp_path, simulated,
                                                                                monkeypatch):
    plain, old, new = _png(1), _png(2), _png(3)
    old_key, new_key = Fernet.generate_key().decode(), Fernet.generate_key().decode()

    def server(keys):
        monkeypatch.setenv("EYEREF_STORAGE_KEY", keys)
        return TestClient(create_app(url, data_dir=str(tmp_path)))

    sid = _send(server(""), _record(simulated, ref="plain", images=1), [plain]).json()["subject_id"]
    _send(server(old_key), _record(simulated, ref="old", images=1), [old])  # encryption switched on
    _send(server(f"{new_key}, {old_key}"), _record(simulated, ref="new", images=1), [new])  # its key rotated

    def shown(keys):
        record = server(keys).get(f"/api/subjects/{sid}", params={"include_images": True}).json()
        return sorted(((c["image"] and base64.b64decode(c["image"].split(",", 1)[1]), c.get("image_unreadable"))
                       for c in _captures(record) if c["image_stored"]), key=repr)

    other_key = "it was encrypted with a key that EYEREF_STORAGE_KEY does not list"
    no_key = "it was stored encrypted, and EYEREF_STORAGE_KEY is not set"
    assert shown(f"{new_key},{old_key}") == sorted([(plain, None), (old, None), (new, None)], key=repr)
    assert shown(new_key) == sorted([(plain, None), (new, None), (None, other_key)], key=repr)
    assert shown("") == sorted([(plain, None), (None, no_key), (None, no_key)], key=repr)  # never ciphertext
    reads = [d["images"] for a, d in _trail(server("")) if a == "subject.read"]
    assert reads == [3, 2, 1]  # the images each read could include


def test_images_are_deleted_once_they_are_older_than_the_retention_limit(url, tmp_path, simulated, monkeypatch):
    app = create_app(url, data_dir=str(tmp_path), image_retention_days=30)
    client = TestClient(app)  # not started yet, so no pass has run
    old = _send(client, _record(simulated, ref="old", images=2), [_png(1), _png(2)]).json()
    new = _send(client, _record(simulated, ref="new", code="SITE1-0008", images=1), [_png(3)]).json()
    _stored_days_ago(url, old["session_id"], 31)
    _stored_days_ago(url, new["session_id"], 29)

    with TestClient(app):  # the server deletes what is past the limit before it serves
        assert _stored_images(tmp_path) == [_png(3)]
    record = client.get(f"/api/subjects/{old['subject_id']}").json()
    assert len(_captures(record)) == old["captures"] and not any(c["image_stored"] for c in _captures(record))
    assert record["subject"]["consent_image_storage"] is True  # expired, not withdrawn
    assert record["subject"]["images_withdrawn_at"] is None
    expiries = client.get("/api/audit", params={"action": "subject.images_expire"}).json()["events"]
    assert [(e["actor"], e["subject_id"], e["details"]) for e in expiries] == [
        ("retention", old["subject_id"], {"images_deleted": 2, "retention_days": 30})]

    # and again every hour while it runs
    monkeypatch.setattr(api, "EXPIRY_INTERVAL_S", 0.05)
    with TestClient(app) as running:
        _stored_days_ago(url, new["session_id"], 31)
        deadline = time.monotonic() + 10
        while len(expiries) < 2 and time.monotonic() < deadline:
            time.sleep(0.05)
            expiries = running.get("/api/audit", params={"action": "subject.images_expire"}).json()["events"]
        assert [e["subject_id"] for e in expiries] == [new["subject_id"], old["subject_id"]]
        assert _stored_images(tmp_path) == []


@pytest.mark.skipif(not (SERVER_URL or "").startswith("postgresql"), reason="only a server is shared by replicas")
def test_two_servers_expiring_images_at_once_delete_each_one_once(url, tmp_path, simulated):
    app = create_app(url, data_dir=str(tmp_path), image_retention_days=30)
    client = TestClient(app)
    first = _send(client, _record(simulated, ref="a", images=1), [_png(1)]).json()
    second = _send(client, _record(simulated, ref="b", code="SITE1-0008", images=1), [_png(2)]).json()
    for out in (first, second):
        _stored_days_ago(url, out["session_id"], 31)

    def start_and_stop():
        with TestClient(app):
            pass

    other = create_engine(url)
    try:
        with other.begin() as conn:  # the other server, part way through the first subject's images
            conn.execute(select(m.Capture.id).join(m.CaptureSession)
                         .where(m.CaptureSession.subject_id == first["subject_id"]).with_for_update(of=m.Capture))
            starting = threading.Thread(target=start_and_stop, daemon=True)
            starting.start()
            starting.join(timeout=30)
            assert not starting.is_alive(), "it waited for the other server instead of leaving it those images"
            assert _stored_images(tmp_path) == [_png(1)]
    finally:
        other.dispose()
    start_and_stop()  # the next pass deletes what the other server left
    expiries = client.get("/api/audit", params={"action": "subject.images_expire"}).json()["events"]
    assert [e["subject_id"] for e in expiries] == [first["subject_id"], second["subject_id"]]
    assert _stored_images(tmp_path) == []


def test_without_a_retention_limit_images_are_kept(url, tmp_path, simulated, monkeypatch):
    monkeypatch.delenv(RETENTION_ENV, raising=False)
    app = create_app(url, data_dir=str(tmp_path))
    out = _send(TestClient(app), _record(simulated, images=1), [_png(1)]).json()
    _stored_days_ago(url, out["session_id"], 3650)
    with TestClient(app):
        assert _stored_images(tmp_path) == [_png(1)]


@pytest.mark.parametrize("value, days", [("", None), ("30", 30), (" 365 ", 365)])
def test_the_retention_limit_is_a_number_of_days(monkeypatch, value, days):
    monkeypatch.setenv(RETENTION_ENV, value)
    assert retention_days_from_env() == days


@pytest.mark.parametrize("value", ["30d", "0", "-7", "1.5"])
def test_a_retention_limit_that_is_not_a_number_of_days_stops_the_server_starting(url, tmp_path, monkeypatch, value):
    monkeypatch.setenv(RETENTION_ENV, value)
    with pytest.raises(RetentionConfigError, match=f"{RETENTION_ENV} must be a whole number of days"):
        create_app(url, data_dir=str(tmp_path))
    monkeypatch.delenv(RETENTION_ENV)
    with pytest.raises(RetentionConfigError, match="1 day or more"):
        create_app(url, data_dir=str(tmp_path), image_retention_days=0)


@pytest.mark.parametrize("how", ["withdraw", "delete the subject", "expire"])
def test_an_image_that_could_not_be_deleted_stays_recorded_until_it_is(url, tmp_path, simulated, monkeypatch, how):
    app = create_app(url, data_dir=str(tmp_path), image_retention_days=30)
    client = TestClient(app, raise_server_exceptions=False)
    out = _send(client, _record(simulated, images=2), [_png(1), _png(2)]).json()
    sid = out["subject_id"]
    if how == "expire":
        _stored_days_ago(url, out["session_id"], 31)
    delete, calls = LocalStorage.delete, []

    def failing_delete(self, key):
        calls.append(key)
        if len(calls) == 2:
            raise OSError("the storage went away")
        delete(self, key)

    def attempt():
        if how == "expire":
            with TestClient(app):  # a pass that fails is logged, and the server still starts
                return None
        return client.delete(f"/api/subjects/{sid}/images" if how == "withdraw" else f"/api/subjects/{sid}")

    monkeypatch.setattr(LocalStorage, "delete", failing_delete)
    r = attempt()
    assert r is None or r.status_code == 500
    assert len(calls) == 2 and len(_stored_images(tmp_path)) == 1  # one went before the failure
    record = client.get(f"/api/subjects/{sid}", params={"include_images": True}).json()
    assert record["subject"]["consent_image_storage"] is True and record["subject"]["images_withdrawn_at"] is None
    shown = [(c["image"] is not None, c.get("image_unreadable")) for c in _captures(record) if c["image_stored"]]
    assert sorted(shown, key=repr) == [(False, "its file is gone: it is being deleted"), (True, None)]  # both recorded
    actions = {"subject.images_withdraw", "subject.delete", "subject.images_expire"}
    assert not [a for a, _ in _trail(client) if a in actions]

    monkeypatch.setattr(LocalStorage, "delete", delete)
    r = attempt()  # and the next attempt finishes
    assert r is None or (r.status_code == 200 and r.json()["images_deleted"] == 2)
    assert _stored_images(tmp_path) == []
    assert [d["images_deleted"] for a, d in _trail(client) if a in actions] == [2]
