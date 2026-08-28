"""Versioned Knowledge Base — namespaces, document versions, chunks, vectors.

The Phase 4 successor to the tables in `models/knowledge.py`, kept ALONGSIDE
them during the expand/contract window: this one versions documents and keys
every vector to a row in `embedding_models`, so an embedding-provider change is
blue/green rather than a destructive re-embed. Neither supersedes the other yet.

Split out of the former `models/redesign.py`. Table names are unchanged.
"""

import enum
import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base



def _uuid() -> str:
    return uuid.uuid4().hex

from .notebook import RecordStatus


class EmbeddingStatus(str, enum.Enum):
    PENDING = "PENDING"
    READY = "READY"
    STALE = "STALE"
    FAILED = "FAILED"

class KnowledgeNamespace(Base):
    __tablename__ = "redesign_knowledge_namespaces"
    __table_args__ = (UniqueConstraint("tenant_id", "slug", name="uq_redesign_knowledge_namespace"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    tenant_id: Mapped[str | None] = mapped_column(ForeignKey("redesign_tenants.id", ondelete="CASCADE"), nullable=True)
    slug: Mapped[str] = mapped_column(String(100), nullable=False)
    visibility: Mapped[str] = mapped_column(String(30), nullable=False, default="PUBLIC", server_default="PUBLIC")

class KnowledgeDocumentVersion(Base):
    __tablename__ = "redesign_knowledge_document_versions"
    __table_args__ = (UniqueConstraint("document_id", "version_no", name="uq_redesign_knowledge_document_version"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    document_id: Mapped[str] = mapped_column(String(100), nullable=False)
    namespace_id: Mapped[str] = mapped_column(ForeignKey("redesign_knowledge_namespaces.id", ondelete="CASCADE"), nullable=False)
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    source_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    canonical_text_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    parser_version: Mapped[str] = mapped_column(String(50), nullable=False, default="1", server_default="1")
    chunker_version: Mapped[str] = mapped_column(String(50), nullable=False, default="1", server_default="1")
    status: Mapped[RecordStatus] = mapped_column(Enum(RecordStatus, name="redesign_notebook_status"), nullable=False, default=RecordStatus.DRAFT, server_default="DRAFT")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

class KnowledgeChunkV2(Base):
    __tablename__ = "redesign_knowledge_chunks"
    __table_args__ = (
        UniqueConstraint("document_version_id", "ordinal", name="uq_redesign_knowledge_chunk_ordinal"),
        Index("ix_redesign_knowledge_chunk_version", "document_version_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    document_version_id: Mapped[str] = mapped_column(ForeignKey("redesign_knowledge_document_versions.id", ondelete="CASCADE"), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_text: Mapped[str] = mapped_column(Text, nullable=False)
    section_title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    anchor: Mapped[str | None] = mapped_column(String(200), nullable=True)
    text_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    metadata_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")

class EmbeddingModel(Base):
    __tablename__ = "redesign_embedding_models"
    __table_args__ = (UniqueConstraint("provider", "model_name", "dimension", name="uq_redesign_embedding_model"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    provider: Mapped[str] = mapped_column(String(80), nullable=False)
    model_name: Mapped[str] = mapped_column(String(160), nullable=False)
    dimension: Mapped[int] = mapped_column(Integer, nullable=False)
    distance_metric: Mapped[str] = mapped_column(String(30), nullable=False, default="cosine", server_default="cosine")
    threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    active: Mapped[bool] = mapped_column(nullable=False, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class KnowledgeChunkEmbedding(Base):
    __tablename__ = "redesign_knowledge_chunk_embeddings"
    __table_args__ = (
        UniqueConstraint("chunk_id", "embedding_model_id", name="uq_redesign_chunk_embedding_model"),
        Index("ix_redesign_embedding_status_model", "embedding_model_id", "status"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    chunk_id: Mapped[str] = mapped_column(ForeignKey("redesign_knowledge_chunks.id", ondelete="CASCADE"), nullable=False)
    embedding_model_id: Mapped[str] = mapped_column(ForeignKey("redesign_embedding_models.id", ondelete="RESTRICT"), nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024), nullable=True)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[EmbeddingStatus] = mapped_column(Enum(EmbeddingStatus, name="redesign_embedding_status"), nullable=False, default=EmbeddingStatus.PENDING, server_default="PENDING")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dimension: Mapped[int | None] = mapped_column(Integer, nullable=True)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lease_owner: Mapped[str | None] = mapped_column(String(120), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
