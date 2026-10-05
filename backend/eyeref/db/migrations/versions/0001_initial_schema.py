"""Initial schema: subjects, devices, capture sessions, captures, ground truth, predictions.

A database created before migrations existed has exactly this schema; the API adopts it at this
revision instead of creating the tables again.

Revision ID: 0001
Revises:
Create Date: 2026-10-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "devices",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("manufacturer", sa.String(length=64), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("camera", sa.String(length=32), nullable=False),
        sa.Column("os_version", sa.String(length=64), nullable=True),
        sa.Column("profile", sa.JSON(), nullable=False),
        sa.Column("calibration_version", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_devices")),
    )
    op.create_table(
        "subjects",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("age_group", sa.String(length=32), nullable=False),
        sa.Column("sex", sa.String(length=16), nullable=True),
        sa.Column("fitzpatrick_or_pigmentation", sa.String(length=16), nullable=True),
        sa.Column("iris_color", sa.String(length=32), nullable=True),
        sa.Column("wears_correction", sa.String(length=32), nullable=True),
        sa.Column("ocular_history", sa.JSON(), nullable=True),
        sa.Column("consent_research", sa.Boolean(), nullable=False),
        sa.Column("consent_image_storage", sa.Boolean(), nullable=False),
        sa.Column("consent_version", sa.String(length=32), nullable=True),
        sa.Column("site", sa.String(length=64), nullable=True),
        sa.Column("simulated", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_subjects")),
    )
    op.create_index(op.f("ix_subjects_code"), "subjects", ["code"], unique=True)
    op.create_table(
        "capture_sessions",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("subject_id", sa.String(length=32), nullable=False),
        sa.Column("device_id", sa.String(length=64), nullable=False),
        sa.Column("protocol_version", sa.String(length=32), nullable=False),
        sa.Column("operator", sa.String(length=64), nullable=True),
        sa.Column("ambient_lux", sa.Float(), nullable=True),
        sa.Column("room_condition", sa.String(length=64), nullable=True),
        sa.Column("cycloplegia", sa.Boolean(), nullable=False),
        sa.Column("condition_label", sa.String(length=64), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("simulated", sa.Boolean(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], name=op.f("fk_capture_sessions_device_id_devices")),
        sa.ForeignKeyConstraint(
            ["subject_id"], ["subjects.id"], name=op.f("fk_capture_sessions_subject_id_subjects"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_capture_sessions")),
    )
    op.create_index(op.f("ix_capture_sessions_subject_id"), "capture_sessions", ["subject_id"], unique=False)
    op.create_table(
        "ground_truth",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("subject_id", sa.String(length=32), nullable=False),
        sa.Column("eye", sa.String(length=2), nullable=False),
        sa.Column("method", sa.String(length=32), nullable=False),
        sa.Column("sphere", sa.Float(), nullable=False),
        sa.Column("cylinder", sa.Float(), nullable=False),
        sa.Column("axis", sa.Float(), nullable=True),
        sa.Column("spherical_equivalent", sa.Float(), nullable=False),
        sa.Column("vertex_distance_mm", sa.Float(), nullable=True),
        sa.Column("instrument", sa.String(length=128), nullable=True),
        sa.Column("examiner", sa.String(length=64), nullable=True),
        sa.Column("measured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(
            ["subject_id"], ["subjects.id"], name=op.f("fk_ground_truth_subject_id_subjects"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ground_truth")),
    )
    op.create_index(op.f("ix_ground_truth_subject_id"), "ground_truth", ["subject_id"], unique=False)
    op.create_table(
        "captures",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("session_id", sa.String(length=32), nullable=False),
        sa.Column("eye", sa.String(length=2), nullable=False),
        sa.Column("frame_index", sa.Integer(), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("working_distance_m", sa.Float(), nullable=True),
        sa.Column("meridian_deg", sa.Float(), nullable=True),
        sa.Column("illumination", sa.String(length=32), nullable=False),
        sa.Column("pupil_diameter_mm", sa.Float(), nullable=True),
        sa.Column("quality_score", sa.Float(), nullable=True),
        sa.Column("quality_grade", sa.String(length=16), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("features_json", sa.JSON(), nullable=True),
        sa.Column("quality_json", sa.JSON(), nullable=True),
        sa.Column("image_key", sa.String(length=256), nullable=True),
        sa.Column("image_encrypted", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["capture_sessions.id"],
            name=op.f("fk_captures_session_id_capture_sessions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_captures")),
    )
    op.create_index(op.f("ix_captures_session_id"), "captures", ["session_id"], unique=False)
    op.create_table(
        "predictions",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("session_id", sa.String(length=32), nullable=False),
        sa.Column("eye", sa.String(length=2), nullable=False),
        sa.Column("output_level", sa.String(length=16), nullable=False),
        sa.Column("se", sa.Float(), nullable=True),
        sa.Column("sphere", sa.Float(), nullable=True),
        sa.Column("cylinder", sa.Float(), nullable=True),
        sa.Column("axis", sa.Float(), nullable=True),
        sa.Column("m", sa.Float(), nullable=True),
        sa.Column("j0", sa.Float(), nullable=True),
        sa.Column("j45", sa.Float(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("se_ci_low", sa.Float(), nullable=True),
        sa.Column("se_ci_high", sa.Float(), nullable=True),
        sa.Column("refractive_class", sa.String(length=32), nullable=True),
        sa.Column("model_name", sa.String(length=64), nullable=False),
        sa.Column("model_version", sa.String(length=32), nullable=False),
        sa.Column("calibration_version", sa.String(length=64), nullable=False),
        sa.Column("device_profile", sa.String(length=64), nullable=False),
        sa.Column("extractor_version", sa.String(length=32), nullable=False),
        sa.Column("report_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["capture_sessions.id"],
            name=op.f("fk_predictions_session_id_capture_sessions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_predictions")),
    )
    op.create_index(op.f("ix_predictions_session_id"), "predictions", ["session_id"], unique=False)


def downgrade() -> None:
    for table in ("predictions", "captures", "ground_truth", "capture_sessions", "subjects", "devices"):
        op.drop_table(table)  # dropping a table drops its indexes
