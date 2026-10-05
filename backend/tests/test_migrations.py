import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from databases import SERVER_URL, fresh_database
from eyeref.db import models as m
from eyeref.db.__main__ import main
from eyeref.db.session import (
    BASELINE_REVISION,
    NewerSchemaError,
    alembic_config,
    connect,
    current_revision,
    downgrade,
    make_engine,
    migrating,
    upgrade,
)
from sqlalchemy import String, inspect, text

HEAD = ScriptDirectory.from_config(alembic_config()).get_current_head()
BACKEND = Path(__file__).resolve().parents[1]


def test_migrations_build_exactly_what_the_models_describe(tmp_path):
    # A model change without a migration fails here. Write one with
    # `alembic revision --autogenerate -m "..."` from backend/, then review it.
    engine = make_engine(fresh_database(tmp_path))
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), m.Base.metadata)
    assert diff == []
    assert current_revision(engine) == HEAD


def test_a_database_from_before_migrations_is_adopted_with_its_data(tmp_path):
    url = fresh_database(tmp_path)
    old = connect(url)
    upgrade(old, BASELINE_REVISION)  # the schema earlier versions made with create_all...
    with old.begin() as conn:
        conn.execute(text("DROP TABLE alembic_version"))  # ...which recorded no version
        conn.execute(
            m.Subject.__table__.insert().values(
                id="s1", code="SITE1-0001", age_group="adult_18_39", consent_research=True,
                consent_image_storage=False, simulated=False, created_at=datetime.now(UTC),
            )
        )
    old.dispose()

    engine = make_engine(url)
    assert current_revision(engine) == HEAD
    with engine.connect() as conn:
        assert conn.execute(text("select code from subjects")).scalar_one() == "SITE1-0001"


def test_upgrading_an_up_to_date_database_changes_nothing(tmp_path):
    engine = make_engine(fresh_database(tmp_path))
    before = sorted(inspect(engine).get_table_names())
    upgrade(engine)
    assert sorted(inspect(engine).get_table_names()) == before
    assert current_revision(engine) == HEAD


def test_every_migration_can_be_undone_and_applied_again(tmp_path):
    engine = make_engine(fresh_database(tmp_path))
    downgrade(engine, "base")
    assert inspect(engine).get_table_names() == ["alembic_version"]
    upgrade(engine)
    assert current_revision(engine) == HEAD


def _insert(conn, model, /, **values):  # positional, since devices have a "model" column
    conn.execute(model.__table__.insert().values(**values))


def _subject(conn, sid: str) -> None:
    _insert(conn, m.Subject, id=sid, code=f"SITE1-{sid}", age_group="adult_18_39", consent_research=True,
            consent_image_storage=False, simulated=False, created_at=datetime.now(UTC))


def _visit(conn, sid: str, ses: str, **session) -> None:
    _insert(conn, m.CaptureSession, id=ses, subject_id=sid, device_id="d1", protocol_version="guided-1",
            cycloplegia=False, simulated=False, started_at=datetime.now(UTC), **session)


def _reference(conn, gid: str, sid: str, **visit) -> None:
    _insert(conn, m.GroundTruth, id=gid, subject_id=sid, eye="OD", method="autorefractor", sphere=-1.0, cylinder=0.0,
            spherical_equivalent=-1.0, measured_at=datetime.now(UTC), **visit)


def _device(conn) -> None:
    _insert(conn, m.Device, id="d1", manufacturer="lab", model="phone", camera="rear", profile={},
            calibration_version="v1", created_at=datetime.now(UTC))


def _seed_research_data(engine, **session):
    """One subject with a session, a capture and a reference measured at that session, as plain inserts."""
    with engine.begin() as conn:
        _subject(conn, "s1")
        _device(conn)
        _visit(conn, "s1", "ses1", **session)
        _insert(conn, m.Capture, id="c1", session_id="ses1", eye="OD", frame_index=0, timestamp=datetime.now(UTC),
                illumination="flash", metadata_json={}, image_encrypted=False)
        _reference(conn, "g1", "s1", session_id="ses1")


def _research_rows(engine) -> list[int]:
    with engine.connect() as conn:
        return [conn.execute(text(f"select count(*) from {t}")).scalar_one()
                for t in ("subjects", "capture_sessions", "captures", "ground_truth")]


@pytest.mark.skipif((SERVER_URL or "sqlite").split(":")[0] != "sqlite", reason="others alter tables in place")
def test_rebuilding_a_table_while_migrating_keeps_the_rows_that_refer_to_it(tmp_path):
    # SQLite alters a table by copying it and dropping the original. With foreign keys enforced, the
    # drop would cascade to every session and capture of every subject.
    engine = make_engine(fresh_database(tmp_path))
    _seed_research_data(engine)
    with migrating(engine) as conn:
        ops = Operations(MigrationContext.configure(conn))
        with ops.batch_alter_table("subjects", recreate="always") as batch:
            batch.alter_column("site", type_=String(128))
    assert _research_rows(engine) == [1, 1, 1, 1]
    with engine.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1  # enforced again afterwards


def test_stepping_back_to_the_baseline_keeps_the_research_data(tmp_path):
    engine = make_engine(fresh_database(tmp_path))
    _seed_research_data(engine, client_ref="rec-1")
    downgrade(engine, BASELINE_REVISION)
    assert current_revision(engine) == BASELINE_REVISION
    assert _research_rows(engine) == [1, 1, 1, 1]
    upgrade(engine)
    assert current_revision(engine) == HEAD


def test_references_recorded_before_visits_were_linked_join_the_only_visit(tmp_path):
    url = fresh_database(tmp_path)
    old = connect(url)
    upgrade(old, "0003")
    with old.begin() as conn:
        _device(conn)
        _subject(conn, "one")  # one visit: its reference was measured there
        _visit(conn, "one", "one-v1")
        _reference(conn, "g-one", "one")
        _subject(conn, "two")  # two visits: nothing says which
        _visit(conn, "two", "two-v1")
        _visit(conn, "two", "two-v2")
        _reference(conn, "g-two", "two")
        _subject(conn, "none")  # no visit yet
        _reference(conn, "g-none", "none")
    old.dispose()

    engine = make_engine(url)
    with engine.connect() as conn:
        linked = dict(conn.execute(text("select id, session_id from ground_truth")).all())
    assert linked == {"g-one": "one-v1", "g-two": None, "g-none": None}


def test_an_older_version_refuses_a_database_a_newer_one_migrated(tmp_path):
    url = fresh_database(tmp_path)
    engine = make_engine(url)
    with engine.begin() as conn:
        conn.execute(text("UPDATE alembic_version SET version_num = '9999'"))  # as a later release leaves it
    with pytest.raises(NewerSchemaError, match="revision 9999, written by a newer version"):
        make_engine(url)
    assert current_revision(engine) == "9999"


def test_the_command_line_migrates_the_configured_database(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("EYEREF_DATABASE_URL", fresh_database(tmp_path))
    assert main(["current"]) == 0
    assert capsys.readouterr().out.strip() == "no schema yet"
    assert main(["upgrade"]) == 0
    assert capsys.readouterr().out.strip() == HEAD
    assert main(["downgrade"]) == 2


@pytest.mark.skipif(not (SERVER_URL or "").startswith("postgresql"), reason="only a server is shared by replicas")
def test_replicas_starting_together_migrate_one_at_a_time(tmp_path):
    # Separate processes, as real replicas are: Alembic's context is global to a process.
    env = {**os.environ, "EYEREF_DATABASE_URL": fresh_database(tmp_path)}
    replicas = [
        subprocess.Popen([sys.executable, "-m", "eyeref.db", "upgrade"], cwd=BACKEND, env=env, text=True,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(4)
    ]
    results = [(*r.communicate(timeout=120), r.returncode) for r in replicas]
    assert [code for _, _, code in results] == [0] * len(replicas), [err for _, err, _ in results]
    assert {out.strip() for out, _, _ in results} == {HEAD}
