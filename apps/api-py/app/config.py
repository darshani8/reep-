"""Application settings, read from the environment / apps/api-py/.env.

Field names map to env vars case-insensitively (database_url <- DATABASE_URL).
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Pin the env file to THIS app's directory. A bare ".env" resolves against the
# process CWD, which — run from the repo root — is the Next.js/Prisma .env, whose
# `postgresql://…?schema=public` URL selects psycopg2 (not installed) and carries
# a Prisma-only query param. This app reads its own file or nothing.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore")

    database_url: str = "postgresql+psycopg://reep:reep_dev_password@localhost:5433/reep_py"
    # Shared with the Next.js app so sessions verify on both sides during cutover.
    auth_secret: str = "reep-dev-secret-change-me-in-production-0123456789abcdef"
    web_origin: str = "http://localhost:4200"
    env: str = "dev"

    # Universal LLM adapter (see app/ai/llm.py). Same names as the Next.js app,
    # so one set of keys drives both stacks. Any OpenAI-compatible provider.
    llm_base_url: str = ""
    llm_model: str = ""
    llm_api_key: str = ""
    llm_timeout_ms: int = 300000
    # A string (not bool) so a blank value is valid and safely means "off",
    # matching the Next.js gate where only the exact string "true" enables it.
    llm_allow_remote_student_data: str = ""

    # Per-provider keys for universal auto-select (app/ai/llm.py). Paste any one;
    # the adapter picks the first present. The explicit LLM_* trio above wins
    # over these when fully set.
    groq_api_key: str = ""
    mistral_api_key: str = ""
    openrouter_api_key: str = ""
    cohere_api_key: str = ""
    gemini_api_key: str = ""
    # Sakana Fugu — OpenAI-compatible meta-router (https://api.sakana.ai/v1).
    sakana_api_key: str = ""

    # Knowledge-Base embedder (app/ai/embeddings.py). OPTIONAL: leave the base URL
    # blank and retrieval falls back to Postgres full-text — no embeddings needed.
    # The KB is public policy text (no student PII), so it may be sent to any
    # OpenAI-compatible /embeddings endpoint. When set, POSTs to
    # {embedding_base_url}/embeddings with embedding_model.
    embedding_base_url: str = ""
    embedding_model: str = ""
    embedding_api_key: str = ""

    # LiveKit (voice assistant) — a free LiveKit Cloud project. The /api/voice
    # endpoints return 503 until all three are set.
    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    # Optional shared secret the voice worker presents on POST /api/voice/heartbeat.
    # Blank -> the heartbeat is open (dev). Set it in prod to authenticate the worker.
    voice_worker_secret: str = ""
    # Maintenance banner surfaced by GET /api/voice/status when non-empty (voice is
    # forced unavailable while set — e.g. during an incident).
    voice_maintenance_message: str = ""

    @property
    def gemini_key_present(self) -> bool:
        """A Gemini/Google key from either the config field or the raw env."""
        import os

        return bool(
            self.gemini_api_key.strip()
            or os.getenv("GEMINI_API_KEY", "").strip()
            or os.getenv("GOOGLE_API_KEY", "").strip()
        )

    @property
    def voice_model_key_present(self) -> bool:
        """Whether the key the VOICE WORKER actually needs is configured.

        Voice runs as a cascade (silero VAD -> Groq Whisper -> Groq Llama ->
        TTS), so GROQ_API_KEY is what makes it work. This deliberately does NOT
        check the Gemini key: that was the old native speech-to-speech path, and
        gating on it would report voice "not configured" on a machine where it
        runs perfectly — or, worse, report it ready on one where it cannot."""
        import os

        return bool(self.groq_api_key.strip() or os.getenv("GROQ_API_KEY", "").strip())

    @property
    def livekit_ready(self) -> bool:
        return bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret)

    # Where uploaded files are stored on disk (only metadata lives in the DB).
    # Empty -> apps/api-py/var/uploads (gitignored). Object storage in production.
    upload_dir: str = ""

    @property
    def is_prod(self) -> bool:
        return self.env.lower() == "prod"

    @property
    def uploads_path(self) -> Path:
        """Resolved directory for the file store (created on first use)."""
        if self.upload_dir.strip():
            return Path(self.upload_dir)
        return Path(__file__).resolve().parent.parent / "var" / "uploads"

    @property
    def allow_remote_student_data(self) -> bool:
        return self.llm_allow_remote_student_data.strip().lower() == "true"

    # Query params that belong to Prisma and mean nothing to libpq. Only these
    # are stripped — see sqlalchemy_url.
    _PRISMA_ONLY_PARAMS = frozenset({"schema", "connection_limit", "pgbouncer"})

    @property
    def sqlalchemy_url(self) -> str:
        """Normalise the DB URL for SQLAlchemy + psycopg 3.

        Forces the `+psycopg` driver (so a plain `postgresql://` does not fall
        back to psycopg2) and drops the Prisma-only query params left over from
        the old stack.

        It drops ONLY those. This used to end `return url.split("?", 1)[0]`,
        discarding the entire query string — which silently threw away
        `sslmode`. Every managed Postgres (Neon, RDS, Supabase, Cloud SQL) hands
        you `...?sslmode=require`, so the connection fell back to libpq's default
        `prefer`: TLS opportunistic, server certificate never verified, nothing
        logged and nothing failed. An operator who set sslmode=require in the
        secret had every reason to believe it applied while student records
        crossed the network on an unauthenticated channel.
        """
        url = self.database_url
        if url.startswith("postgresql://"):
            url = "postgresql+psycopg://" + url[len("postgresql://") :]

        base, sep, query = url.partition("?")
        if not sep:
            return base

        kept = [
            pair
            for pair in query.split("&")
            if pair and pair.split("=", 1)[0] not in self._PRISMA_ONLY_PARAMS
        ]
        return f"{base}?{'&'.join(kept)}" if kept else base


settings = Settings()
