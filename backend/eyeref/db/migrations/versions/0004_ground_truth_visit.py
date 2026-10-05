"""Reference refractions belong to the visit they were measured at.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # SQLite cannot add a foreign key to a table, so it rebuilds this one. No table refers to
    # ground_truth, and migrating() switches foreign keys off meanwhile, so no row goes with it.
    with op.batch_alter_table("ground_truth") as batch:
        batch.add_column(sa.Column("session_id", sa.String(length=32), nullable=True))
        batch.create_index(op.f("ix_ground_truth_session_id"), ["session_id"], unique=False)
        batch.create_foreign_key(op.f("fk_ground_truth_session_id_capture_sessions"), "capture_sessions",
                                 ["session_id"], ["id"], ondelete="CASCADE")
    # A reference recorded before now belongs to its subject's visit when there is only one. With several,
    # nothing says which, so it stays unlinked and is no longer paired with any of them.
    op.execute(
        "UPDATE ground_truth SET session_id = "
        "(SELECT s.id FROM capture_sessions s WHERE s.subject_id = ground_truth.subject_id) "
        "WHERE (SELECT count(*) FROM capture_sessions s WHERE s.subject_id = ground_truth.subject_id) = 1"
    )


def downgrade() -> None:
    with op.batch_alter_table("ground_truth") as batch:
        batch.drop_constraint(op.f("fk_ground_truth_session_id_capture_sessions"), type_="foreignkey")
        batch.drop_index(op.f("ix_ground_truth_session_id"))
        batch.drop_column("session_id")
