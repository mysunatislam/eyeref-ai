from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Session, sessionmaker

DEFAULT_URL = "sqlite:///./data/eyeref.db"
MIGRATIONS = Path(__file__).with_name("migrations")
# The schema as it stood when migrations were introduced. A database created before then (by
# SQLAlchemy's create_all) has exactly this schema, so it is adopted at this revision.
BASELINE_REVISION = "0001"


def database_url(url: str | None = None) -> str:
    return url or os.environ.get("EYEREF_DATABASE_URL", DEFAULT_URL)


def connect(url: str | None = None) -> Engine:
    """An engine for the database, without touching its schema."""
    url = database_url(url)
    if url.startswith("sqlite:///") and not url.endswith(":memory:"):
        os.makedirs(os.path.dirname(url.replace("sqlite:///", "")) or ".", exist_ok=True)
    kwargs = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {}
    if url == "sqlite://" or url.endswith(":memory:"):
        from sqlalchemy.pool import StaticPool

        kwargs["poolclass"] = StaticPool
    eng = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        @event.listens_for(eng, "connect")
        def _fk_on(dbapi_conn, _):  # pragma: no cover - driver hook
            dbapi_conn.execute("PRAGMA foreign_keys=ON")
    return eng


def alembic_config() -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS))
    return cfg


@contextmanager
def migrating(engine: Engine) -> Iterator[Connection]:
    """A connection to run migrations on, in one transaction where the database allows it.

    SQLite changes a table by rebuilding it. With foreign keys enforced, dropping the old copy would
    delete every row that refers to it (ON DELETE CASCADE): altering `subjects` would erase all
    sessions, captures and ground truth. So on SQLite, foreign keys are off while migrating and are
    checked once at the end instead.
    """
    with engine.connect() as conn:
        sqlite = conn.dialect.name == "sqlite"
        if sqlite:
            conn.exec_driver_sql("PRAGMA foreign_keys=OFF")  # ignored inside a transaction, so set first
            conn.commit()
        try:
            with conn.begin():
                yield conn
                if sqlite and (broken := conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall()):
                    raise RuntimeError(f"the migration left rows that refer to missing rows: {broken[:5]}")
        finally:
            if sqlite:
                conn.exec_driver_sql("PRAGMA foreign_keys=ON")
                conn.commit()


class NewerSchemaError(RuntimeError):
    """The database was migrated by a newer version of EyeRef than this one."""


def upgrade(engine: Engine, revision: str = "head") -> None:
    """Applies any pending migrations."""
    cfg = alembic_config()
    with migrating(engine) as conn:
        cfg.attributes["connection"] = conn
        script = ScriptDirectory.from_config(cfg)
        current = MigrationContext.configure(conn).get_current_revision()
        if current is not None and current not in {r.revision for r in script.walk_revisions()}:
            raise NewerSchemaError(
                f"The database is at schema revision {current}, written by a newer version of EyeRef. This "
                f"version knows revisions up to {script.get_current_head()}, so it will not touch the data. Run "
                "the newer version, or restore a backup made before the upgrade.")
        tables = set(inspect(conn).get_table_names())
        if "alembic_version" not in tables and "subjects" in tables:
            command.stamp(cfg, BASELINE_REVISION)
        command.upgrade(cfg, revision)


def downgrade(engine: Engine, revision: str) -> None:
    """Undoes migrations down to `revision` ("base" for none)."""
    cfg = alembic_config()
    with migrating(engine) as conn:
        cfg.attributes["connection"] = conn
        command.downgrade(cfg, revision)


def current_revision(engine: Engine) -> str | None:
    with engine.connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


def make_engine(url: str | None = None) -> Engine:
    """An engine for the database, with its schema brought up to date."""
    eng = connect(url)
    upgrade(eng)
    return eng


class Database:
    def __init__(self, url: str | None = None):
        self.engine = make_engine(url)
        self.SessionLocal = sessionmaker(bind=self.engine, expire_on_commit=False)

    def session(self) -> Iterator[Session]:
        s = self.SessionLocal()
        try:
            yield s
        finally:
            s.close()
