"""Universal LLM adapter — one interface, any provider.

Speaks the OpenAI-compatible /chat/completions protocol, so a single set of env
vars drives ANY provider — add a free key and point the base URL, no code change:

    LLM_BASE_URL   LLM_MODEL                    provider
    -----------------------------------------------------------------
    https://generativelanguage.googleapis.com/v1beta/openai  gemini-2.5-flash   Google Gemini (free)
    https://api.groq.com/openai/v1               llama-3.3-70b-versatile        Groq (free)
    https://openrouter.ai/api/v1                 <any>                          OpenRouter
    https://api.cerebras.ai/v1                   llama-3.3-70b                  Cerebras (free)
    http://127.0.0.1:11434/v1                    <ollama model>                 local Ollama / LM Studio

Carries the same student-data egress gate as the Next.js app: a remote model
must be explicitly allowed before it may receive student PII, because free tiers
train on submissions. The CrewAI agent layer (Phase 4) sits on top of this,
sharing the same env vars via LiteLLM.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

from ..config import settings

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}


class LLMNotConfigured(RuntimeError):
    pass


class StudentDataEgressRefused(RuntimeError):
    pass


@dataclass(frozen=True)
class LLMConfig:
    base_url: str
    model: str
    api_key: str
    timeout_s: float


def llm_config() -> LLMConfig | None:
    base = settings.llm_base_url.strip().rstrip("/")
    model = settings.llm_model.strip()
    if not base or not model:
        return None
    return LLMConfig(
        base_url=base,
        model=model,
        api_key=settings.llm_api_key.strip(),
        timeout_s=max(1.0, settings.llm_timeout_ms / 1000),
    )


def is_loopback(base_url: str) -> bool:
    return (urlparse(base_url).hostname or "").lower() in _LOOPBACK_HOSTS


def student_data_egress_allowed(base_url: str) -> bool:
    """Loopback is always fine; any off-machine model needs the explicit flag —
    identical policy to studentDataEgressAllowed() in the Next.js app."""
    if is_loopback(base_url):
        return True
    return settings.llm_allow_remote_student_data


def complete_chat(
    messages: list[dict],
    *,
    carries_student_data: bool = False,
    temperature: float = 0.2,
    json_mode: bool = False,
    max_tokens: int | None = None,
) -> str:
    """One blocking chat completion against the configured provider.

    Set carries_student_data=True for any prompt containing a student's record;
    it is refused before leaving the process unless the model is local or the
    remote egress flag is set.
    """
    cfg = llm_config()
    if cfg is None:
        raise LLMNotConfigured("Set LLM_BASE_URL and LLM_MODEL.")
    if carries_student_data and not student_data_egress_allowed(cfg.base_url):
        raise StudentDataEgressRefused(
            f"The model at {cfg.base_url} runs off this machine; student data will "
            "not be sent unless LLM_ALLOW_REMOTE_STUDENT_DATA=true. Use a local "
            "model or a paid key."
        )

    payload: dict = {"model": cfg.model, "messages": messages, "temperature": temperature}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens

    headers = {"content-type": "application/json"}
    if cfg.api_key:
        headers["authorization"] = f"Bearer {cfg.api_key}"

    resp = httpx.post(
        f"{cfg.base_url}/chat/completions",
        json=payload,
        headers=headers,
        timeout=cfg.timeout_s,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]
