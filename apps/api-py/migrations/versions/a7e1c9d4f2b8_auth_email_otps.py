"""auth email otps

Revision ID: a7e1c9d4f2b8
Revises: d6a4e7f91b22
Create Date: 2026-09-02 06:30:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a7e1c9d4f2b8"
down_revision: Union[str, None] = "d6a4e7f91b22"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# One table, no enums — none of the AGENTS.md enum gotchas apply. Nothing on
# `users` changes: password_hash stays NOT NULL and the "google-only" sentinel
# keeps meaning "no usable local password".
def upgrade() -> None:
    op.create_table(
        "auth_email_otps",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("purpose", sa.String(length=16), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_auth_email_otps_user_created", "auth_email_otps", ["user_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_auth_email_otps_user_created", table_name="auth_email_otps")
    op.drop_table("auth_email_otps")
