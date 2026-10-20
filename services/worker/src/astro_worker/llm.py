"""LLM providers for horoscope prose. Providers only turn computed facts into wording; every
output is validated (astro_api.horoscope_rules) and then queued for human review.

Use paid, no-training API tiers only (PLAN.md §6). Keys are SecretStr and never logged.
"""

import json
from dataclasses import dataclass
from typing import Any, Protocol

import anthropic
import httpx
from pydantic import SecretStr

from astro_api.horoscope_rules import AREAS
from astro_api.shared_files import data_dir
from astro_worker.config import WorkerSettings

SECTIONS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {a: {"type": "string"} for a in AREAS},
    "required": list(AREAS),
    "additionalProperties": False,
}


class ProviderError(RuntimeError):
    pass


def _present(key: SecretStr | None) -> bool:
    """An empty value (e.g. `GEMINI_API_KEY=` in .env) counts as unset."""
    return key is not None and bool(key.get_secret_value().strip())


@dataclass(frozen=True)
class LlmRequest:
    system: str
    user: str
    facts: dict[str, Any]
    locale: str


@dataclass(frozen=True)
class LlmResult:
    text: str  # JSON object with the five sections
    model: str


class LlmProvider(Protocol):
    name: str

    async def generate(self, req: LlmRequest) -> LlmResult: ...


class AnthropicProvider:
    """Claude via the official SDK, with JSON structured output and server-side refusal fallback."""

    name = "anthropic"

    def __init__(
        self, settings: WorkerSettings, client: anthropic.AsyncAnthropic | None = None
    ) -> None:
        if client is None:
            key = settings.anthropic_api_key
            if key is None or not _present(key):
                raise ProviderError("ANTHROPIC_API_KEY is not set")
            client = anthropic.AsyncAnthropic(
                api_key=key.get_secret_value(),
                timeout=settings.llm_timeout_s,
                max_retries=0,  # the pipeline's single validation retry is the only retry
            )
        self.client = client
        self.model = settings.anthropic_model
        self.effort = settings.anthropic_effort

    async def generate(self, req: LlmRequest) -> LlmResult:
        try:
            response = await self.client.beta.messages.create(
                model=self.model,
                max_tokens=16000,
                system=req.system,
                messages=[{"role": "user", "content": req.user}],
                output_config={
                    "effort": self.effort,
                    "format": {"type": "json_schema", "schema": SECTIONS_SCHEMA},
                },
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except anthropic.APIConnectionError as exc:
            raise ProviderError(f"Anthropic API unreachable: {type(exc).__name__}") from exc
        except anthropic.APIStatusError as exc:
            raise ProviderError(f"Anthropic API error {exc.status_code}") from exc
        if response.stop_reason == "refusal":
            raise ProviderError("model declined the request (refusal)")
        if response.stop_reason == "max_tokens":
            raise ProviderError("response hit max_tokens")
        text = next((b.text for b in response.content if b.type == "text"), None)
        if text is None:
            raise ProviderError("no text block in the response")
        return LlmResult(text=text, model=response.model)


class GeminiProvider:
    """Gemini generateContent over REST with a JSON response schema. The key goes in a header,
    never in the URL, so it cannot end up in access logs."""

    name = "gemini"
    BASE = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self, settings: WorkerSettings, http: httpx.AsyncClient | None = None) -> None:
        key = settings.gemini_api_key
        if key is None or not _present(key):
            raise ProviderError("GEMINI_API_KEY is not set")
        self.key = key
        self.model = settings.gemini_model
        self.http = http or httpx.AsyncClient(timeout=settings.llm_timeout_s)

    async def generate(self, req: LlmRequest) -> LlmResult:
        body = {
            "systemInstruction": {"parts": [{"text": req.system}]},
            "contents": [{"role": "user", "parts": [{"text": req.user}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "OBJECT",
                    "properties": {a: {"type": "STRING"} for a in AREAS},
                    "required": list(AREAS),
                },
            },
        }
        try:
            r = await self.http.post(
                f"{self.BASE}/{self.model}:generateContent",
                json=body,
                headers={"x-goog-api-key": self.key.get_secret_value()},
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"Gemini API unreachable: {type(exc).__name__}") from exc
        if r.status_code != 200:
            raise ProviderError(f"Gemini API error {r.status_code}")
        data = r.json()
        try:
            candidate = data["candidates"][0]
            text = "".join(p.get("text", "") for p in candidate["content"]["parts"])
        except (KeyError, IndexError, TypeError) as exc:
            reason = (data.get("promptFeedback") or {}).get("blockReason", "no candidates")
            raise ProviderError(f"Gemini returned no text ({reason})") from exc
        return LlmResult(text=text, model=data.get("modelVersion", self.model))


class FakeProvider:
    """Deterministic, valid text built from the facts. Development and tests only."""

    name = "fake"

    def __init__(self, settings: WorkerSettings) -> None:
        if settings.is_production:
            raise ProviderError("the fake LLM provider is not allowed in staging/production")
        tables = data_dir()
        self.grahas = {
            g["id"]: g for g in json.loads((tables / "grahas.json").read_text())["grahas"]
        }
        self.signs = {s["id"]: s for s in json.loads((tables / "signs.json").read_text())["signs"]}

    def _line(self, facts: dict[str, Any], area: str, locale: str) -> str:
        transits = {t["graha"]: t for t in facts["transits"]}
        reasons = facts["areas"][area]["reasons"] or [{"graha": next(iter(transits))}]
        t = transits[reasons[0]["graha"]]
        graha, sign, house = self.grahas[t["graha"]], self.signs[t["sign"]], t["house_from_sign"]
        if locale == "hi":
            return (
                f"{graha['hi']} {sign['hi']} में है और आपकी राशि से {house} वें स्थान पर है। "
                "आज अपनी गति से चलें, ध्यान से सुनें और योजनाओं में थोड़ी लचक रखें। जो बात आपके "
                "लिए सबसे ज़रूरी है, उसे पहले पूरा करें और छोटे क़दमों से आगे बढ़ें। शांत मन से "
                "लिए गए फ़ैसले दिन को आसान बनाते हैं। अपने लिए थोड़ा आराम का समय रखें और उन "
                "लोगों के साथ समय बिताएँ जिनसे आपको सुकून मिलता है।"
            )
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(house if house < 20 else house % 10, "th")
        return (
            f"With {graha['en']} in {sign['en']}, in your {house}{suffix} house, this part of life "
            "asks for patience. Take the day one step at a time, listen closely, and keep plans "
            "flexible while you sort out what matters most to you. A calm pace suits you, and "
            "small, steady choices add up over the coming hours. Leave room for rest and for "
            "people who make you feel at ease."
        )

    async def generate(self, req: LlmRequest) -> LlmResult:
        sections = {a: self._line(req.facts, a, req.locale) for a in AREAS}
        return LlmResult(text=json.dumps(sections, ensure_ascii=False), model="fake")


def make_provider(settings: WorkerSettings) -> LlmProvider:
    if settings.llm_provider == "anthropic":
        return AnthropicProvider(settings)
    if settings.llm_provider == "gemini":
        return GeminiProvider(settings)
    return FakeProvider(settings)
