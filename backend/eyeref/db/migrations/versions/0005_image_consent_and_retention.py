"""A subject can withdraw consent to store eye images, images can expire, and a deleted subject stays deleted.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("subjects", sa.Column("images_withdrawn_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("captures", sa.Column("image_stored_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f("ix_captures_image_stored_at"), "captures", ["image_stored_at"], unique=False)
    # The server did not record when it stored an image before now. The photograph's own time is the
    # closest it has, and an image is never stored before it is taken, so nothing is kept for longer.
    captures = sa.table("captures", sa.column("timestamp"), sa.column("image_key"), sa.column("image_stored_at"))
    op.execute(captures.update().where(captures.c.image_key.is_not(None))
               .values(image_stored_at=captures.c.timestamp))
    op.create_table(
        "deleted_subjects",
        sa.Column("code_sha256", sa.String(length=64), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("code_sha256", name=op.f("pk_deleted_subjects")),
    )


def downgrade() -> None:
    op.drop_table("deleted_subjects")
    # Index first: SQLite drops a column in place only once nothing refers to it. Rebuilding the table
    # instead would delete every capture through the foreign keys' cascade.
    op.drop_index(op.f("ix_captures_image_stored_at"), table_name="captures")
    op.drop_column("captures", "image_stored_at")
    op.drop_column("subjects", "images_withdrawn_at")
