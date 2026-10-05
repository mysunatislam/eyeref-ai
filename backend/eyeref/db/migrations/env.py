"""Alembic environment for the research API's database.

The API applies migrations itself when it starts (eyeref.db.session.upgrade), passing its own
connection. The alembic command line (see backend/alembic.ini) connects to EYEREF_DATABASE_URL.
"""

from logging.config import fileConfig

from alembic import context
from eyeref.db.models import Base
from eyeref.db.session import connect, migrating
from sqlalchemy import text

if context.config.config_file_name is not None:  # the alembic command line
    fileConfig(context.config.config_file_name)

# Held for the whole migration on PostgreSQL, so replicas that start together migrate one at a time.
_PG_LOCK_ID = 0x45594552  # "EYER"


def _run(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=Base.metadata,
        render_as_batch=True,  # SQLite can only change a column by rebuilding its table
        compare_type=True,
    )
    with context.begin_transaction():
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": _PG_LOCK_ID})
        context.run_migrations()


def run_online() -> None:
    connection = context.config.attributes.get("connection")
    if connection is not None:
        _run(connection)
        return
    engine = connect()
    try:
        with migrating(engine) as connection:
            _run(connection)
    finally:
        engine.dispose()


if context.is_offline_mode():
    raise SystemExit("Offline (SQL script) migrations are not supported; run them against a database.")
run_online()
