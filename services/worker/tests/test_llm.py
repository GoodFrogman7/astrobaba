import json
from pathlib import Path
from typing import Any

import anthropic
import httpx
import httpx2
import pytest
from pydantic import SecretStr

from astro_api.horoscope_rules import text_errors
from astro_worker.config import WorkerSettings
from astro_worker.llm import (
    SECTIONS_SCHEMA,
    AnthropicProvider,
    FakeProvider,
    GeminiProvider,
    LlmRequest,
    ProviderError,
    make_provider,
)

FACTS: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "api/tests/fixtures/facts_aries_daily.json").read_text()
)
VALID = json.dumps({a: "word " * 70 for a in ("overall", "love", "career", "money", "health")})


@pytest.mark.parametrize("locale", ["en", "hi"])
async def test_fake_provider_output_passes_the_validator(locale: str) -> None:
    result = await FakeProvider(WorkerSettings(app_env="test")).generate(
        LlmRequest("s", "u", FACTS, locale)
    )
    sections = json.loads(result.text)
    assert text_errors(sections, FACTS) == []
    if locale == "hi":
        assert all(any("ऀ" <= c <= "ॿ" for c in v) for v in sections.values())


def test_fake_provider_refused_in_production() -> None:
    with pytest.raises(ProviderError):
        FakeProvider(WorkerSettings(app_env="production"))


def test_real_providers_need_keys() -> None:
    with pytest.raises(ProviderError, match="GEMINI_API_KEY"):
        make_provider(WorkerSettings(llm_provider="gemini"))
    with pytest.raises(ProviderError, match="ANTHROPIC_API_KEY"):
        make_provider(WorkerSettings(llm_provider="anthropic"))


async def test_gemini_request_shape_and_parsing() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-goog-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "candidates": [{"content": {"parts": [{"text": VALID}]}}],
                "modelVersion": "gemini-x",
            },
        )

    settings = WorkerSettings(gemini_api_key=SecretStr("g-secret"), gemini_model="gemini-test")
    provider = GeminiProvider(
        settings, http=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    result = await provider.generate(LlmRequest("system rules", "facts", FACTS, "en"))
    assert seen["url"].endswith("/v1beta/models/gemini-test:generateContent")
    assert "g-secret" not in seen["url"] and seen["key"] == "g-secret"
    assert seen["body"]["systemInstruction"]["parts"][0]["text"] == "system rules"
    assert seen["body"]["generationConfig"]["responseMimeType"] == "application/json"
    assert result.text == VALID and result.model == "gemini-x"


async def test_gemini_errors() -> None:
    settings = WorkerSettings(gemini_api_key=SecretStr("k"))
    blocked = GeminiProvider(
        settings,
        http=httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}})
            )
        ),
    )
    with pytest.raises(ProviderError, match="SAFETY"):
        await blocked.generate(LlmRequest("s", "u", FACTS, "en"))
    down = GeminiProvider(
        settings,
        http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503))),
    )
    with pytest.raises(ProviderError, match="503"):
        await down.generate(LlmRequest("s", "u", FACTS, "en"))


def _anthropic(handler: Any) -> AnthropicProvider:
    client = anthropic.AsyncAnthropic(
        api_key="a-secret",
        max_retries=0,
        http_client=anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(handler)),
    )
    return AnthropicProvider(WorkerSettings(), client=client)


def _message(stop_reason: str, text: str = VALID) -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5-5",
        "content": [{"type": "text", "text": text}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 10},
    }


async def test_anthropic_request_shape_and_parsing() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = json.loads(request.content)
        return httpx2.Response(200, json=_message("end_turn"))

    result = await _anthropic(handler).generate(LlmRequest("system rules", "facts", FACTS, "en"))
    body = seen["body"]
    assert seen["url"].endswith("/v1/messages?beta=true") or seen["url"].endswith("/v1/messages")
    assert body["model"] == "claude-opus-5-5"
    assert body["system"] == "system rules"
    assert body["output_config"] == {
        "effort": "medium",
        "format": {"type": "json_schema", "schema": SECTIONS_SCHEMA},
    }
    assert body["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in seen["headers"]["anthropic-beta"]
    assert seen["headers"]["x-api-key"] == "a-secret" and "anthropic-version" in seen["headers"]
    assert result.text == VALID and result.model == "claude-opus-5-5"


async def test_anthropic_refusal_and_errors() -> None:
    with pytest.raises(ProviderError, match="refusal"):
        await _anthropic(lambda r: httpx2.Response(200, json=_message("refusal"))).generate(
            LlmRequest("s", "u", FACTS, "en")
        )
    with pytest.raises(ProviderError, match="429"):
        await _anthropic(
            lambda r: httpx2.Response(
                429,
                json={"type": "error", "error": {"type": "rate_limit_error", "message": "slow"}},
            )
        ).generate(LlmRequest("s", "u", FACTS, "en"))
