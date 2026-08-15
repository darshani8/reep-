"""Pluggable text embedder for the Knowledge Base.

The KB stores PUBLIC policy text, so embedding it and even sending it to a remote
embedding endpoint is fine — there is no student PII here (that is the whole point
of keeping knowledge separate from student facts). This module is therefore
DELIBERATELY simple and has NO hard dependency on any embedding provider:

    embed(texts) -> list[list[float]] | None

Returns None when no embedder is configured; every caller then falls back to
Postgres full-text retrieval, so the KB works with zero embedding setup. When
`embedding_base_url` + `embedding_model` are configured, it POSTs to the
OpenAI-compatible `{base}/embeddings` endpoint.
"""

from __future__ import annotations

import logging

import httpx

from ..config import settings

log = logging.getLogger(__name__)


def embedder_configured() -> bool:
    """True when an embedding provider is set (base URL + model)."""
    return bool(settings.embedding_base_url.strip() and settings.embedding_model.strip())


def embed(texts: list[str]) -> list[list[float]] | None:
    """Embed a batch of texts via an OpenAI-compatible /embeddings endpoint.

    Returns a list of float vectors aligned with `texts`, or None when no
    embedder is configured (the caller then uses full-text retrieval). Any
    provider/network error is logged and swallowed as None — the KB must never
    hard-fail just because an optional embedder is down.
    """
    if not texts or not embedder_configured():
        return None

    base = settings.embedding_base_url.strip().rstrip("/")
    model = settings.embedding_model.strip()
    key = settings.embedding_api_key.strip()

    headers = {"content-type": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"

    try:
        resp = httpx.post(
            f"{base}/embeddings",
            json={"model": model, "input": texts},
            headers=headers,
            timeout=max(1.0, settings.llm_timeout_ms / 1000),
        )
        resp.raise_for_status()
        data = resp.json()["data"]
        # OpenAI returns rows possibly out of order; sort by index to realign.
        rows = sorted(data, key=lambda r: r.get("index", 0))
        return [r["embedding"] for r in rows]
    except Exception:
        log.exception("embedding call failed (base=%s model=%s)", base, model)
        return None


def reembed_all(db) -> int:
    """Populate KnowledgeChunk.embedding for every chunk when a provider exists.

    No-op (returns 0) when no embedder is configured. Batches the chunk texts,
    calls embed(), and writes the vectors back. Safe to re-run — it simply
    overwrites with fresh vectors.
    """
    from sqlalchemy import select

    from ..models.knowledge import KnowledgeChunk

    if not embedder_configured():
        return 0

    chunks = db.scalars(select(KnowledgeChunk)).all()
    if not chunks:
        return 0

    updated = 0
    BATCH = 64
    for i in range(0, len(chunks), BATCH):
        batch = chunks[i : i + BATCH]
        vectors = embed([c.chunk_text for c in batch])
        if vectors is None or len(vectors) != len(batch):
            log.warning("reembed_all: embedder returned no/mismatched vectors, stopping")
            break
        for chunk, vec in zip(batch, vectors):
            chunk.embedding = vec
            updated += 1
        db.commit()
    return updated
