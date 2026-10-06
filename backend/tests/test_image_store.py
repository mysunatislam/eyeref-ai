"""Looking after the stored eye images: encrypting those stored before a key was set, retiring an old key, and
checking that the database and the image files agree (docs/API.md#looking-after-stored-images)."""

import base64
import logging
import os
import sqlite3
import subprocess
import sys
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from databases import fresh_database
from eyeref.api.images import RETENTION_ENV, check_images, encrypt_images, main
from eyeref.api.main import create_app
from eyeref.db.session import Database, connect, upgrade
from eyeref.simulation.cohort import SessionConfig, make_subject, run_simulated_assessment
from eyeref.storage import LocalStorage
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from test_assessments import _png, _record, _send, _trail
from test_data_rights import _stored_days_ago

OLD_KEY, NEW_KEY = Fernet.generate_key().decode(), Fernet.generate_key().decode()
BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def simulated():
    subj = make_subject("SIM-STORE", "adult_18_39")
    rep, recs, _ = run_simulated_assessment(
        subj, session_cfg=SessionConfig(device_rotations_deg=[0, 90], frames_per_meridian=2))
    frames = [r.model_dump(mode="json", exclude={"features": {"profile_perpendicular"}}) for r in recs]
    return frames, rep.model_dump(mode="json")


@pytest.fixture()
def server(tmp_path, monkeypatch):
    """Starts a server on one database and image store, with the storage keys given, as the commands find them."""
    url = fresh_database(tmp_path)
    monkeypatch.setenv("EYEREF_DATABASE_URL", url)
    monkeypatch.setenv("EYEREF_DATA_DIR", str(tmp_path))

    def start(keys=""):
        monkeypatch.setenv("EYEREF_STORAGE_KEY", keys)
        return TestClient(create_app(url, data_dir=str(tmp_path)))

    return start


def _files(tmp_path):
    root = tmp_path / "objects"
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def _shown(client, sid):
    """The participant's images as their record shows them: each one's PNG, or why it cannot be read."""
    record = client.get(f"/api/subjects/{sid}", params={"include_images": True}).json()
    captures = [c for v in record["visits"] for c in v["captures"] if c["image_stored"]]
    return sorted(base64.b64decode(c["image"].split(",", 1)[1]) if c["image"] else c["image_unreadable"]
                  for c in captures)


def _run(work, tmp_path, *args):
    """Runs one of the commands' functions on the server's database and image store, as the commands do."""
    db = Database(os.environ["EYEREF_DATABASE_URL"])
    try:
        with Session(db.engine, expire_on_commit=False) as s:
            return work(s, LocalStorage(tmp_path / "objects"), *args)
    finally:
        db.engine.dispose()


def _encrypt_events(client):
    events = client.get("/api/audit", params={"action": "subject.images_encrypt"}).json()["events"]
    return sorted((e["subject_id"], e["actor"], e["details"]["images_encrypted"], e["details"]["images_reencrypted"])
                  for e in events)


def test_images_stored_before_a_key_was_set_are_encrypted_and_stay_readable(server, simulated, tmp_path, capsys,
                                                                            caplog):
    images = [_png(1), _png(2)]
    plain = server("")
    sid = _send(plain, _record(simulated, ref="a", images=2), images).json()["subject_id"]
    other = _send(plain, _record(simulated, ref="b", code="SITE1-0008", images=1), [_png(3)]).json()["subject_id"]
    assert sorted(_files(tmp_path).values()) == sorted([*images, _png(3)])

    with caplog.at_level(logging.WARNING, logger="eyeref.api.main"):
        server(OLD_KEY)
    assert "3 eye images were stored before EYEREF_STORAGE_KEY was set and are not encrypted" in caplog.text

    assert main(["encrypt"]) == 0
    assert capsys.readouterr().out == (
        "Encrypted 3 images stored without encryption, and re-encrypted 0 under an older key.\n")
    files = _files(tmp_path)
    assert len(files) == 3 and not set(files.values()) & {*images, _png(3)}  # only ciphertext left on disk
    client = server(OLD_KEY)
    assert _shown(client, sid) == sorted(images) and _shown(client, other) == [_png(3)]
    assert _encrypt_events(client) == sorted([(sid, "maintenance", 2, 0), (other, "maintenance", 1, 0)])

    trail = _trail(client)
    assert main(["encrypt"]) == 0  # again: nothing is left to do, so nothing changes
    assert capsys.readouterr().out == (
        "Encrypted 0 images stored without encryption, and re-encrypted 0 under an older key.\n")
    assert _files(tmp_path) == files and _trail(client) == trail
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="eyeref.api.main"):
        server(OLD_KEY)
    assert "stored before EYEREF_STORAGE_KEY was set" not in caplog.text


def test_an_old_key_can_be_retired_once_its_images_are_encrypted_again(server, simulated, tmp_path, capsys):
    images = [_png(1), _png(2)]
    sid = _send(server(OLD_KEY), _record(simulated, images=2), images).json()["subject_id"]
    client = server(f"{NEW_KEY},{OLD_KEY}")  # the new key goes first, and the old one still reads
    assert main(["check"]) == 0
    assert capsys.readouterr().out == ("2 images recorded; 0 problems.\n2 images are encrypted with a key other "
                                       "than the first; run encrypt before removing that key.\n")

    assert main(["encrypt"]) == 0
    assert capsys.readouterr().out == (
        "Encrypted 0 images stored without encryption, and re-encrypted 2 under an older key.\n")
    assert _encrypt_events(client) == [(sid, "maintenance", 0, 2)]
    assert main(["check"]) == 0
    assert capsys.readouterr().out == "2 images recorded; 0 problems.\n"
    assert _shown(server(NEW_KEY), sid) == sorted(images)  # the old key is no longer needed


def test_encrypting_needs_a_key(server, simulated, tmp_path, capsys):
    _send(server(""), _record(simulated, images=1), [_png(1)])
    assert main(["encrypt"]) == 2
    assert capsys.readouterr().err == (
        "EYEREF_STORAGE_KEY is not set, so there is no key to encrypt the images with\n")
    assert list(_files(tmp_path).values()) == [_png(1)]


@pytest.mark.parametrize("stop", ["writing the second image", "recording the new files"])
def test_encrypting_stopped_part_way_leaves_every_image_readable_and_carries_on(server, simulated, tmp_path,
                                                                               monkeypatch, stop):
    images = [_png(1), _png(2), _png(3)]
    sid = _send(server(""), _record(simulated, images=3), images).json()["subject_id"]
    client = server(OLD_KEY)
    put, commit, writes = LocalStorage.put, Session.commit, []

    def failing_put(self, key, data):
        writes.append(key)
        if len(writes) == 2:
            raise OSError("the disk filled up")
        put(self, key, data)

    def failing_commit(self):
        raise OSError("the database went away")

    if stop == "writing the second image":
        monkeypatch.setattr(LocalStorage, "put", failing_put)
    else:
        monkeypatch.setattr(Session, "commit", failing_commit)
    with pytest.raises(OSError):
        _run(encrypt_images, tmp_path)
    monkeypatch.setattr(LocalStorage, "put", put)
    monkeypatch.setattr(Session, "commit", commit)
    assert _shown(client, sid) == sorted(images)  # still recorded unencrypted, and readable
    written = {"writing the second image": 1, "recording the new files": 3}[stop]
    assert len(_files(tmp_path)) == 3 + written  # encrypted copies no record names

    done = _run(encrypt_images, tmp_path)
    assert (done.encrypted, done.reencrypted, done.missing, done.unreadable, done.left_behind) == (3, 0, [], [], [])
    assert _shown(client, sid) == sorted(images)
    soon = _run(check_images, tmp_path, datetime.now(UTC), True)
    assert (soon.orphans, soon.deleted, soon.problems) == ([], [], 0)  # they could still be an upload's
    later = _run(check_images, tmp_path, datetime.now(UTC) + timedelta(hours=2), True)
    assert (len(later.deleted), later.problems) == (written, 0)  # an hour on, they go
    assert len(_files(tmp_path)) == 3


def test_check_lists_what_the_database_and_the_files_disagree_on(server, simulated, tmp_path, capsys):
    def send(keys, ref, images):
        before = set(_files(tmp_path))
        assert _send(server(keys), _record(simulated, ref=ref, images=len(images)), images).status_code == 201
        return sorted(set(_files(tmp_path)) - before)

    plain = send("", "a", [_png(1), _png(2)])  # stored before a key was set
    lost = send(Fernet.generate_key().decode(), "b", [_png(3)])  # under a key since lost
    current = send(OLD_KEY, "c", [_png(4), _png(5)])
    root = tmp_path / "objects"
    (root / plain[0]).unlink()
    (root / current[0]).write_bytes(Fernet(OLD_KEY.encode()).encrypt(b"not an image"))
    (root / "lost").mkdir()
    for name in ("old.png", "old.png.1a2b3c4d.tmp", "new.png"):
        (root / "lost" / name).write_bytes(b"left behind")
    hours_ago = (datetime.now(UTC) - timedelta(hours=2)).timestamp()
    for name in ("old.png", "old.png.1a2b3c4d.tmp"):
        os.utime(root / "lost" / name, (hours_ago, hours_ago))

    report = _run(check_images, tmp_path, datetime.now(UTC))
    assert report.images == 5
    assert report.missing == [plain[0]]
    assert sorted(report.unreadable) == sorted([
        (current[0], "it is not a PNG image"),
        (lost[0], "it was encrypted with a key that EYEREF_STORAGE_KEY does not list")])
    assert report.unencrypted == [plain[1]]
    assert report.older_key == []
    assert report.orphans == ["lost/old.png", "lost/old.png.1a2b3c4d.tmp"]  # the new file may be an upload's
    assert report.problems == 6

    problems = sorted([f"  {plain[0]}: the file is gone",
                       f"  {current[0]}: unreadable, because it is not a PNG image",
                       f"  {lost[0]}: unreadable, because it was encrypted with a key that EYEREF_STORAGE_KEY does "
                       "not list",
                       f"  {plain[1]}: stored without encryption; run encrypt"])
    assert main(["check"]) == 1
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "5 images recorded; 6 problems."
    assert sorted(out[1:]) == sorted([*problems, "  lost/old.png: no record names this file",
                                      "  lost/old.png.1a2b3c4d.tmp: no record names this file"])
    assert len(_files(tmp_path)) == 7  # checking alone changes nothing

    assert main(["check", "--delete-orphans"]) == 1
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "5 images recorded; 4 problems."
    assert sorted(out[1:-1]) == problems
    assert out[-1] == "Deleted 2 files no record names: lost/old.png, lost/old.png.1a2b3c4d.tmp"
    assert [p.name for p in (root / "lost").iterdir()] == ["new.png"]


def test_a_withdrawal_while_images_are_encrypted_leaves_none_behind(server, simulated, tmp_path, monkeypatch):
    sid = _send(server(""), _record(simulated, images=2), [_png(1), _png(2)]).json()["subject_id"]
    app = server(OLD_KEY).app
    put, answers = LocalStorage.put, []

    def withdraw():
        answers.append(TestClient(app).delete(f"/api/subjects/{sid}/images"))

    def put_while_withdrawing(self, key, data):
        if not hasattr(put_while_withdrawing, "withdrawal"):  # as the first image is written again
            put_while_withdrawing.withdrawal = threading.Thread(target=withdraw)
            put_while_withdrawing.withdrawal.start()
            put_while_withdrawing.withdrawal.join(timeout=1)  # it waits for the encryption instead of missing it
        put(self, key, data)

    monkeypatch.setattr(LocalStorage, "put", put_while_withdrawing)
    done = _run(encrypt_images, tmp_path)
    put_while_withdrawing.withdrawal.join(timeout=30)
    assert done.encrypted == 2
    [answer] = answers
    assert answer.status_code == 200 and answer.json()["images_deleted"] == 2, answer.text
    assert _files(tmp_path) == {}  # no image outlives the withdrawal, encrypted or not


def test_images_expiring_while_they_are_encrypted_are_deleted_all_the_same(server, simulated, tmp_path, monkeypatch):
    out = _send(server(""), _record(simulated, images=2), [_png(1), _png(2)]).json()
    _stored_days_ago(os.environ["EYEREF_DATABASE_URL"], out["session_id"], 31)
    monkeypatch.setenv(RETENTION_ENV, "30")
    app = server(OLD_KEY).app
    put = LocalStorage.put

    def expire():
        with TestClient(app):  # the server deletes what is past the limit before it serves
            pass

    def put_while_expiring(self, key, data):
        if not hasattr(put_while_expiring, "expiry"):  # as the first image is written again
            put_while_expiring.expiry = threading.Thread(target=expire)
            put_while_expiring.expiry.start()
            put_while_expiring.expiry.join(timeout=1)  # it waits for the encryption instead of missing it
        put(self, key, data)

    monkeypatch.setattr(LocalStorage, "put", put_while_expiring)
    done = _run(encrypt_images, tmp_path)
    put_while_expiring.expiry.join(timeout=30)
    assert done.encrypted == 2
    assert _files(tmp_path) == {}  # the encrypted copies went too
    expiries = TestClient(app).get("/api/audit", params={"action": "subject.images_expire"}).json()["events"]
    assert [e["details"]["images_deleted"] for e in expiries] == [2]


def test_the_commands_touch_only_the_servers_own_database_and_image_store(server, simulated, tmp_path, monkeypatch,
                                                                         capsys):
    """Pointed at the wrong database, check would take every image file for one no record names."""
    _send(server(OLD_KEY), _record(simulated, images=1), [_png(1)])
    files, url = _files(tmp_path), os.environ["EYEREF_DATABASE_URL"]
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    def refused(*argv):
        assert main(list(argv)) == 2
        return capsys.readouterr().err

    monkeypatch.delenv("EYEREF_DATA_DIR")  # ./data, which is not the server's
    assert refused("check", "--delete-orphans") == (
        "there is no image store at data/objects; set EYEREF_DATA_DIR to the server's\n")
    monkeypatch.setenv("EYEREF_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("EYEREF_DATABASE_URL")
    assert refused("check", "--delete-orphans") == (
        "there is no database at sqlite:///./data/eyeref.db; set EYEREF_DATABASE_URL to the server's\n")
    sqlite3.connect(elsewhere / "empty.db").close()
    monkeypatch.setenv("EYEREF_DATABASE_URL", f"sqlite:///{elsewhere / 'empty.db'}")
    assert refused("encrypt") == (
        f"the database at sqlite:///{elsewhere / 'empty.db'} has no EyeRef schema; set EYEREF_DATABASE_URL to the "
        "server's\n")
    older = connect(f"sqlite:///{elsewhere / 'older.db'}")
    upgrade(older, "0004")
    older.dispose()
    monkeypatch.setenv("EYEREF_DATABASE_URL", f"sqlite:///{elsewhere / 'older.db'}")
    assert refused("check") == (
        f"the database at sqlite:///{elsewhere / 'older.db'} is at schema revision 0004, and this version of EyeRef "
        "expects 0005; run this command from the same version as the server\n")
    assert sorted(p.name for p in elsewhere.iterdir()) == ["empty.db", "older.db"]  # nothing created or upgraded
    assert _files(tmp_path) == files

    monkeypatch.setenv("EYEREF_DATABASE_URL", url)
    monkeypatch.setenv("EYEREF_STORAGE_KEY", "not a key")
    assert "Fernet key must be 32 url-safe base64-encoded bytes" in refused("check")


def test_the_commands_run_from_the_command_line(server, simulated, tmp_path):
    _send(server(""), _record(simulated, images=1), [_png(1)])
    env = {**os.environ, "EYEREF_STORAGE_KEY": OLD_KEY}

    def run(*argv):
        return subprocess.run([sys.executable, "-m", "eyeref.api.images", *argv], cwd=BACKEND, env=env,
                              capture_output=True, text=True, timeout=120)

    check = run("check")
    assert (check.returncode, check.stdout) == (1, "1 image recorded; 1 problem.\n" + "".join(
        f"  {key}: stored without encryption; run encrypt\n" for key in _files(tmp_path))), check.stderr
    encrypt = run("encrypt")
    assert (encrypt.returncode, encrypt.stdout) == (
        0, "Encrypted 1 image stored without encryption, and re-encrypted 0 under an older key.\n"), encrypt.stderr
    check = run("check")
    assert (check.returncode, check.stdout) == (0, "1 image recorded; 0 problems.\n"), check.stderr


def test_an_image_is_written_whole_or_not_at_all(tmp_path, monkeypatch):
    storage = LocalStorage(tmp_path, key=OLD_KEY)
    storage.put("s/v/c.png", _png(1))
    real = type(tmp_path).write_bytes

    def half_written(self, data):
        real(self, data[: len(data) // 2])
        raise OSError("the disk filled up")

    monkeypatch.setattr(type(tmp_path), "write_bytes", half_written)
    with pytest.raises(OSError):
        storage.put("s/v/c.png", _png(2))
    monkeypatch.setattr(type(tmp_path), "write_bytes", real)
    assert storage.get("s/v/c.png") == _png(1)  # the image that was there is whole
    assert [k for k, _ in storage.objects()] == ["s/v/c.png"]  # and nothing is left beside it
