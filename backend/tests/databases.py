"""The database each test runs against.

By default every test gets its own SQLite file. Set EYEREF_TEST_DATABASE_URL to run the same tests
against a server instead (CI does this with PostgreSQL); each test then starts from an empty schema.
"""

import os

from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

SERVER_URL = os.environ.get("EYEREF_TEST_DATABASE_URL")


def fresh_database(tmp_path) -> str:
    if not SERVER_URL:
        return f"sqlite:///{tmp_path / 'eyeref.db'}"
    engine = create_engine(SERVER_URL, poolclass=NullPool)
    try:
        with engine.begin() as conn:
            # Apps from earlier tests keep pooled connections open; drop them so the schema can go.
            # Only this role's own clients: autovacuum workers belong to a superuser and may not be stopped.
            conn.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                              "WHERE datname = current_database() AND pid <> pg_backend_pid() "
                              "AND usename = current_user AND backend_type = 'client backend'"))
            conn.execute(text("DROP SCHEMA public CASCADE"))
            conn.execute(text("CREATE SCHEMA public"))
    finally:
        engine.dispose()
    return SERVER_URL
