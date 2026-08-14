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

    # LiveKit (voice assistant) — a free LiveKit Cloud project. The /api/voice
    # endpoints return 503 until all three are set.
    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""

    @property
    def is_prod(self) -> bool:
        return self.env.lower() == "prod"

    @property
    def allow_remote_student_data(self) -> bool:
        return self.llm_allow_remote_student_data.strip().lower() == "true"

    @property
    def sqlalchemy_url(self) -> str:
        """Normalise the DB URL for SQLAlchemy + psycopg 3: force the `+psycopg`
        driver (so a plain `postgresql://` doesn't fall back to psycopg2) and
        drop Prisma-only query params like `?schema=public`."""
        url = self.database_url
        if url.startswith("postgresql://"):
            url = "postgresql+psycopg://" + url[len("postgresql://") :]
        return url.split("?", 1)[0]


settings = Settings()
