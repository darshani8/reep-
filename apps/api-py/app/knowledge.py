"""Retrieval over the REEP Knowledge Base — the grounded assistant's "explain the
rules" layer.

`search()` returns approved policy/FAQ/guidance chunks that match a query. It is
the ONLY read path the assistant should use to ground an answer, and it can only
ever surface APPROVED documents whose audience admits the caller — never a live
student fact, which lives in a wholly separate table.

Retrieval strategy (works today, no embeddings required):
  PRIMARY  Postgres full-text: rank by ts_rank over to_tsvector('english',
           chunk_text) vs plainto_tsquery('english', query). Backed by the GIN
           index created in the migration. Falls back to ILIKE when the query
           produces no ts matches (e.g. a single rare token).
  BLEND    When chunk embeddings exist AND an embedder is configured, cosine
           similarity is computed in Python over the small full-text candidate
           set and blended into the score to re-rank. The KB is small and
           curated, so in-Python cosine is perfectly adequate.

Returns [] when nothing approved matches — the caller then shows
"no approved answer" rather than inventing one.

NOTE (production scale path): for a large KB, switch retrieval to pgvector —
use the `pgvector/pgvector:pg17` docker image, `CREATE EXTENSION vector`, convert
`KnowledgeChunk.embedding` to a `vector` column, and `ORDER BY embedding <=>
:query_vec LIMIT k`. Not done here to avoid recreating the live DB container; the
in-Python cosine blend below gives the same ranking for a small curated set.
"""

from __future__ import annotations

import math

from sqlalchemy import String, bindparam, func, or_, select
from sqlalchemy.orm import Session

from .ai.embeddings import embed, embedder_configured
from .models.knowledge import KnowledgeChunk, KnowledgeDocument, KnowledgeStatus

# How many full-text candidates to pull before an optional cosine re-rank.
_CANDIDATE_POOL = 24
# Weight given to the embedding-cosine signal when blending (rest is full-text).
_COSINE_WEIGHT = 0.5


def _audience_filter(audience: str):
    return KnowledgeDocument.audience.in_([audience, "all"])


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def search(
    db: Session,
    query: str,
    audience: str = "student",
    limit: int = 5,
) -> list[dict]:
    """Return up to `limit` approved KB chunks matching `query`.

    Each result: {chunk_text, document_title, source_type, source_url, anchor,
    score}. Only APPROVED documents whose audience is `audience` or 'all' are
    considered. Returns [] when nothing matches.
    """
    q = (query or "").strip()
    if not q:
        return []

    ts_vector = func.to_tsvector("english", KnowledgeChunk.chunk_text)
    ts_query = func.plainto_tsquery("english", bindparam("q", value=q, type_=String))
    rank = func.ts_rank(ts_vector, ts_query).label("rank")

    base_where = (
        KnowledgeDocument.status == KnowledgeStatus.APPROVED,
        _audience_filter(audience),
    )

    # PRIMARY: full-text. ts_query.op("@@") is the text-search match operator.
    stmt = (
        select(
            KnowledgeChunk.id,
            KnowledgeChunk.chunk_text,
            KnowledgeChunk.anchor,
            KnowledgeChunk.embedding,
            KnowledgeDocument.title,
            KnowledgeDocument.source_type,
            KnowledgeDocument.source_url,
            rank,
        )
        .join(KnowledgeDocument, KnowledgeChunk.document_id == KnowledgeDocument.id)
        .where(*base_where)
        .where(ts_vector.op("@@")(ts_query))
        .order_by(rank.desc())
        .limit(_CANDIDATE_POOL)
    )
    # Normalise every candidate to a dict so the primary (Row) and fallback
    # (Row without a rank column) paths score identically.
    def _to_candidate(row, ft_rank: float) -> dict:
        return {
            "chunk_text": row.chunk_text,
            "anchor": row.anchor,
            "embedding": row.embedding,
            "title": row.title,
            "source_type": row.source_type,
            "source_url": row.source_url,
            "rank": ft_rank,
        }

    candidates: list[dict] = [_to_candidate(r, float(r.rank)) for r in db.execute(stmt).all()]

    used_fulltext = True
    if not candidates:
        # FALLBACK: ILIKE over the raw tokens when ts produced nothing.
        used_fulltext = False
        tokens = [t for t in q.split() if len(t) > 1] or [q]
        ilike_clauses = [KnowledgeChunk.chunk_text.ilike(f"%{tok}%") for tok in tokens]
        fallback = (
            select(
                KnowledgeChunk.chunk_text,
                KnowledgeChunk.anchor,
                KnowledgeChunk.embedding,
                KnowledgeDocument.title,
                KnowledgeDocument.source_type,
                KnowledgeDocument.source_url,
            )
            .join(KnowledgeDocument, KnowledgeChunk.document_id == KnowledgeDocument.id)
            .where(*base_where)
            .where(or_(*ilike_clauses))
            .limit(_CANDIDATE_POOL)
        )
        candidates = [_to_candidate(r, 0.0) for r in db.execute(fallback).all()]

    if not candidates:
        return []

    # Optional cosine blend when embeddings exist and an embedder is available.
    query_vec: list[float] | None = None
    if embedder_configured() and any(c["embedding"] for c in candidates):
        vecs = embed([q])
        if vecs:
            query_vec = vecs[0]

    scored: list[dict] = []
    max_rank = max((c["rank"] for c in candidates), default=0.0) or 1.0
    for c in candidates:
        # Normalise full-text rank into 0..1 for a stable blend.
        ft = (c["rank"] / max_rank) if used_fulltext else 0.0
        score = ft
        if query_vec is not None and c["embedding"]:
            cos = _cosine(query_vec, list(c["embedding"]))
            score = (1 - _COSINE_WEIGHT) * ft + _COSINE_WEIGHT * cos
        scored.append(
            {
                "chunk_text": c["chunk_text"],
                "document_title": c["title"],
                "source_type": c["source_type"],
                "source_url": c["source_url"],
                "anchor": c["anchor"],
                "score": round(float(score), 6),
            }
        )

    scored.sort(key=lambda d: d["score"], reverse=True)
    return scored[:limit]
