"""companions and permission-scoped memory

Revision ID: c7f4a1b2d903
Revises: d6a4e7f91b22
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql


revision: str = "c7f4a1b2d903"
down_revision: Union[str, None] = "d6a4e7f91b22"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "companions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("role_key", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("system_prompt", sa.Text(), nullable=True),
        sa.Column("capabilities", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False),
        sa.Column("allowed_roles", postgresql.JSONB(astext_type=sa.Text()), server_default='["STUDENT", "MENTOR", "DIRECTOR", "ADMIN"]', nullable=False),
        sa.Column("status", sa.Enum("ACTIVE", "INACTIVE", name="companion_status"), server_default="ACTIVE", nullable=False),
        sa.Column("created_by_user_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug", name="uq_companion_slug"),
    )
    op.create_index("ix_companion_status", "companions", ["status"], unique=False)

    op.create_table(
        "companion_memories",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("companion_id", sa.String(), nullable=True),
        sa.Column("scope", sa.Enum("PRIVATE", "SHARED", name="memory_scope"), nullable=False),
        sa.Column("status", sa.Enum("DRAFT", "APPROVED", "ARCHIVED", name="memory_status"), server_default="DRAFT", nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("owner_user_id", sa.String(), nullable=True),
        sa.Column("created_by_user_id", sa.String(), nullable=True),
        sa.Column("approved_by_user_id", sa.String(), nullable=True),
        sa.Column("metadata_json", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False),
        sa.Column("embedding", Vector(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["companion_id"], ["companions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["approved_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint(
            "(scope = 'PRIVATE' AND companion_id IS NOT NULL AND owner_user_id IS NOT NULL) OR "
            "(scope = 'SHARED' AND companion_id IS NULL AND owner_user_id IS NULL)",
            name="ck_companion_memory_scope_ownership",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_companion_memory_lookup", "companion_memories", ["companion_id", "scope", "status", "created_at"], unique=False)
    op.create_index("ix_companion_memory_owner", "companion_memories", ["owner_user_id", "companion_id", "status"], unique=False)
    op.execute(
        "CREATE INDEX ix_companion_memory_fts "
        "ON companion_memories USING gin (to_tsvector('english', content))"
    )


def downgrade() -> None:
    op.drop_index("ix_companion_memory_fts", table_name="companion_memories")
    op.drop_index("ix_companion_memory_owner", table_name="companion_memories")
    op.drop_index("ix_companion_memory_lookup", table_name="companion_memories")
    op.drop_table("companion_memories")
    op.drop_index("ix_companion_status", table_name="companions")
    op.drop_table("companions")
    op.execute("DROP TYPE IF EXISTS memory_status")
    op.execute("DROP TYPE IF EXISTS memory_scope")
    op.execute("DROP TYPE IF EXISTS companion_status")
