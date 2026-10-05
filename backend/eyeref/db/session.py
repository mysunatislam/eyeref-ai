from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.engine import Engine
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


def upgrade(engine: Engine, revision: str = "head") -> None:
    """Applies any pending migrations, in one transaction where the database allows it."""
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        tables = set(inspect(conn).get_table_names())
        if "alembic_version" not in tables and "subjects" in tables:
            command.stamp(cfg, BASELINE_REVISION)
        command.upgrade(cfg, revision)


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
