"""Capture sessions remember which device record they came from, so a retried upload is not stored twice.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("capture_sessions", sa.Column("client_ref", sa.String(length=64), nullable=True))
    op.create_index(op.f("ix_capture_sessions_client_ref"), "capture_sessions", ["client_ref"], unique=True)


def downgrade() -> None:
    # Index first: SQLite drops a column in place only once nothing refers to it. Rebuilding the table
    # instead would delete every capture through the foreign keys' cascade.
    op.drop_index(op.f("ix_capture_sessions_client_ref"), table_name="capture_sessions")
    op.drop_column("capture_sessions", "client_ref")
