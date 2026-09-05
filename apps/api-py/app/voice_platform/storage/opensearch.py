"""Amazon OpenSearch Serverless: searchable candidate session logs and
question vectors.

Signed with SigV4 from the standard AWS chain using botocore (already a
dependency through boto3) over httpx (already pinned) — so this adds no
package to requirements.txt and keeps the api-imports CI job green. The
service name is `aoss` for Serverless collections; a provisioned domain would
be `es`, which the constructor accepts.

`NullIndex` is what a deployment without PLATFORM_OPENSEARCH_ENDPOINT gets:
every call returns False or an empty list, and the call session's
`opensearch_synced` flag stays False, which is how the API tells the truth
about it.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlparse

import httpx

from ...config import settings

log = logging.getLogger("app.voice_platform.storage.opensearch")

SESSION_LOG_MAPPING: dict[str, Any] = {
    "mappings": {
        "properties": {
            "session_id": {"type": "keyword"},
            "degree_level": {"type": "keyword"},
            "user_id": {"type": "keyword"},
            "candidate_id": {"type": "keyword"},
            "specialization": {"type": "keyword"},
            "status": {"type": "keyword"},
            "close_code": {"type": "integer"},
            "close_reason": {"type": "text"},
            "started_at": {"type": "date"},
            "ended_at": {"type": "date"},
            "duration_ms": {"type": "integer"},
            "turns": {"type": "integer"},
            "transcript": {"type": "text"},
            "recording_s3_key": {"type": "keyword"},
        }
    }
}


def question_vector_mapping(dimension: int) -> dict[str, Any]:
    return {
        "settings": {"index": {"knn": True}},
        "mappings": {
            "properties": {
                "question_id": {"type": "keyword"},
                "degree_level": {"type": "keyword"},
                "specialization": {"type": "keyword"},
                "phase": {"type": "keyword"},
                "text": {"type": "text"},
                "embedding": {
                    "type": "knn_vector",
                    "dimension": int(dimension),
                    "method": {"name": "hnsw", "engine": "faiss", "space_type": "cosinesimil"},
                },
            }
        },
    }


class NullIndex:
    """No endpoint configured. Honest no-ops."""

    enabled = False

    def ensure_index(self, name: str, body: dict[str, Any]) -> bool:
        return False

    def index(self, name: str, doc_id: str, doc: dict[str, Any]) -> bool:
        return False

    def search(self, name: str, query: dict[str, Any], *, size: int = 20) -> list[dict[str, Any]]:
        return []

    def knn(self, name: str, vector: list[float], *, k: int = 5, field: str = "embedding") -> list[dict[str, Any]]:
        return []


class OpenSearchIndex:
    enabled = True

    def __init__(
        self,
        endpoint: str,
        region: str,
        *,
        service: str = "aoss",
        credentials: Any = None,
        http: httpx.Client | None = None,
        timeout_s: float = 10.0,
    ) -> None:
        parsed = urlparse(endpoint if "://" in endpoint else f"https://{endpoint}")
        if not parsed.netloc:
            raise ValueError(f"not an OpenSearch endpoint: {endpoint!r}")
        self._base = f"{parsed.scheme}://{parsed.netloc}"
        self._host = parsed.netloc
        self._region = region
        self._service = service
        self._credentials = credentials
        self._http = http or httpx.Client(timeout=timeout_s)

    def _creds(self) -> Any:
        if self._credentials is None:
            import boto3

            self._credentials = boto3.Session().get_credentials()
        if self._credentials is None:
            raise RuntimeError("no AWS credentials resolved for OpenSearch signing")
        return self._credentials

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> httpx.Response:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        data = json.dumps(body).encode() if body is not None else b""
        url = f"{self._base}{path}"
        request = AWSRequest(
            method=method,
            url=url,
            data=data,
            headers={"Content-Type": "application/json", "host": self._host},
        )
        SigV4Auth(self._creds().get_frozen_credentials(), self._service, self._region).add_auth(request)
        headers = {k: v for k, v in request.headers.items()}
        return self._http.request(method, url, content=data, headers=headers)

    def ensure_index(self, name: str, body: dict[str, Any]) -> bool:
        try:
            response = self._request("PUT", f"/{name}", body)
        except Exception as exc:  # noqa: BLE001 - a projection never fails the call
            log.error("OpenSearch create index %s failed: %s", name, exc)
            return False
        if response.status_code in (200, 201):
            return True
        if response.status_code == 400 and "resource_already_exists" in response.text:
            return True
        log.error("OpenSearch create index %s -> HTTP %d: %s", name, response.status_code, response.text[:300])
        return False

    def index(self, name: str, doc_id: str, doc: dict[str, Any]) -> bool:
        try:
            response = self._request("PUT", f"/{name}/_doc/{doc_id}", doc)
        except Exception as exc:  # noqa: BLE001
            log.error("OpenSearch index into %s failed: %s", name, exc)
            return False
        if response.status_code in (200, 201):
            return True
        log.error("OpenSearch index into %s -> HTTP %d: %s", name, response.status_code, response.text[:300])
        return False

    def search(self, name: str, query: dict[str, Any], *, size: int = 20) -> list[dict[str, Any]]:
        try:
            response = self._request("POST", f"/{name}/_search", {"size": int(size), "query": query})
        except Exception as exc:  # noqa: BLE001
            log.error("OpenSearch search on %s failed: %s", name, exc)
            return []
        if response.status_code != 200:
            log.error("OpenSearch search on %s -> HTTP %d", name, response.status_code)
            return []
        hits = response.json().get("hits", {}).get("hits", [])
        return [dict(h.get("_source", {}), _score=h.get("_score")) for h in hits]

    def knn(self, name: str, vector: list[float], *, k: int = 5, field: str = "embedding") -> list[dict[str, Any]]:
        return self.search(name, {"knn": {field: {"vector": vector, "k": int(k)}}}, size=k)


def search_index(http: httpx.Client | None = None) -> OpenSearchIndex | NullIndex:
    """The configured index, or the honest no-op."""
    endpoint = settings.platform_opensearch_endpoint.strip()
    if not endpoint:
        return NullIndex()
    region = settings.platform_region
    if not region:
        log.error(
            "PLATFORM_OPENSEARCH_ENDPOINT is set but no AWS region resolves "
            "(PLATFORM_AWS_REGION / AWS_REGION); session logs will not be indexed."
        )
        return NullIndex()
    try:
        return OpenSearchIndex(endpoint, region, http=http)
    except Exception as exc:  # noqa: BLE001
        log.error("OpenSearch client could not be built: %s", exc)
        return NullIndex()


def index_session_log(store: OpenSearchIndex | NullIndex, doc: dict[str, Any]) -> bool:
    """One searchable document per closed call."""
    name = settings.platform_opensearch_sessions_index
    if not store.enabled:
        return False
    store.ensure_index(name, SESSION_LOG_MAPPING)
    return store.index(name, str(doc["session_id"]), doc)


def index_question_vector(
    store: OpenSearchIndex | NullIndex,
    *,
    question_id: str,
    text: str,
    meta: dict[str, Any],
    vector: list[float] | None = None,
) -> bool:
    """Embed `text` (through the KB's own embedder, app/ai/embeddings.py) and
    store it as a knn_vector alongside its metadata. No embedder configured ⇒
    False, honestly: the catalogue still works, only vector search does not.

    The question bank is the placement office's own text, not a student's
    record, so rule 1's egress gate does not apply — the same reasoning the
    Knowledge Base uses for embedding approved policy text.
    """
    if not store.enabled:
        return False
    if vector is None:
        from ...ai.embeddings import embed

        vectors = embed([text])
        if not vectors:
            return False
        vector = vectors[0]
    name = settings.platform_opensearch_questions_index
    store.ensure_index(name, question_vector_mapping(len(vector)))
    doc = dict(meta, question_id=question_id, text=text, embedding=vector)
    return store.index(name, question_id, doc)
