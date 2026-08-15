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

import json
from collections.abc import Iterator
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
    provider: str = "custom"


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    default_model: str
    key_attr: str


# Auto-select order — paste any one provider key and it just works. Each speaks
# the OpenAI-compatible /chat/completions protocol.
_PROVIDERS = [
    # Sakana Fugu is itself a multi-model router; first, so a SAKANA_API_KEY (when
    # present) takes precedence. Falls through to the others when it is unset.
    Provider("sakana", "https://api.sakana.ai/v1", "fugu-ultra", "sakana_api_key"),
    Provider("groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "groq_api_key"),
    Provider("mistral", "https://api.mistral.ai/v1", "mistral-small-latest", "mistral_api_key"),
    Provider("openrouter", "https://openrouter.ai/api/v1", "meta-llama/llama-3.3-70b-instruct:free", "openrouter_api_key"),
    Provider("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", "gemini_api_key"),
    Provider("cohere", "https://api.cohere.ai/compatibility/v1", "command-r", "cohere_api_key"),
]


def _timeout_s() -> float:
    return max(1.0, settings.llm_timeout_ms / 1000)


def llm_config() -> LLMConfig | None:
    """Resolve the active LLM.

    1. Explicit override — LLM_BASE_URL + LLM_MODEL set (key optional for a local
       model). Wins when present.
    2. Auto-select — the first provider in _PROVIDERS whose key is set, so pasting
       any GROQ_API_KEY / MISTRAL_API_KEY / … is enough, no code change.
    """
    base = settings.llm_base_url.strip().rstrip("/")
    model = settings.llm_model.strip()
    key = settings.llm_api_key.strip()
    if base and model and (key or is_loopback(base)):
        return LLMConfig(base, model, key, _timeout_s(), provider="custom")

    for p in _PROVIDERS:
        pkey = getattr(settings, p.key_attr, "").strip()
        if pkey:
            # Auto mode uses the provider's own default model. A stray LLM_MODEL
            # meant for another provider must not leak in (it would 404). Pin a
            # specific model via the explicit LLM_BASE_URL+LLM_MODEL+LLM_API_KEY trio.
            return LLMConfig(p.base_url, p.default_model, pkey, _timeout_s(), provider=p.name)
    return None


def is_loopback(base_url: str) -> bool:
    return (urlparse(base_url).hostname or "").lower() in _LOOPBACK_HOSTS


def student_data_egress_allowed(base_url: str) -> bool:
    """Loopback is always fine; any off-machine model needs the explicit flag —
    identical policy to studentDataEgressAllowed() in the Next.js app."""
    if is_loopback(base_url):
        return True
    return settings.allow_remote_student_data


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


def stream_chat(
    messages: list[dict],
    *,
    carries_student_data: bool = False,
    temperature: float = 0.2,
    max_tokens: int | None = None,
) -> Iterator[str]:
    """Stream a chat completion token-by-token over the OpenAI-compatible SSE
    protocol (`stream: true`), yielding each content delta as it arrives.

    Same egress gate as complete_chat: refused before the request leaves the
    process when it carries student PII to an off-machine model.
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

    payload: dict = {
        "model": cfg.model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens

    headers = {"content-type": "application/json"}
    if cfg.api_key:
        headers["authorization"] = f"Bearer {cfg.api_key}"

    with httpx.stream(
        "POST",
        f"{cfg.base_url}/chat/completions",
        json=payload,
        headers=headers,
        timeout=cfg.timeout_s,
    ) as resp:
        if resp.status_code >= 400:
            resp.read()  # a stream body must be consumed before .text is available
            raise httpx.HTTPStatusError(
                f"{resp.status_code}: {resp.text}", request=resp.request, response=resp
            )
        for line in resp.iter_lines():
            if not line or not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if data == "[DONE]":
                break
            try:
                delta = json.loads(data)["choices"][0]["delta"].get("content")
            except (json.JSONDecodeError, KeyError, IndexError):
                continue
            if delta:
                yield delta
