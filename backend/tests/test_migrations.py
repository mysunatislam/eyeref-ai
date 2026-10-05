import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from databases import SERVER_URL, fresh_database
from eyeref.db import models as m
from eyeref.db.__main__ import main
from eyeref.db.session import BASELINE_REVISION, alembic_config, connect, current_revision, make_engine, upgrade
from sqlalchemy import inspect, text

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
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.downgrade(cfg, "base")
    assert inspect(engine).get_table_names() == ["alembic_version"]
    upgrade(engine)
    assert current_revision(engine) == HEAD


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
