import json
import uuid
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.models import HoroscopeEntry
from astro_worker.__main__ import main

pytestmark = pytest.mark.integration


def test_review_cli_list_show_approve_reject(
    generate_run: Any, db_query: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    generate_run(signs=("aries",))
    assert main(["horoscopes", "review", "list"]) == 0
    rows = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert len(rows) == 2 and {r["status"] for r in rows} == {"pending_review"}

    en = next(r for r in rows if r["locale"] == "en")
    hi = next(r for r in rows if r["locale"] == "hi")
    assert main(["horoscopes", "review", "show", en["id"]]) == 0
    assert "sections" in json.loads(capsys.readouterr().out)

    assert main(["horoscopes", "review", "approve", en["id"], "--reviewer", "Asha"]) == 0
    assert (
        main(["horoscopes", "review", "reject", hi["id"], "--reviewer", "Asha", "--reason", "tone"])
        == 0
    )
    assert (
        main(["horoscopes", "review", "reject", en["id"], "--reviewer", "Asha", "--reason", "late"])
        == 1
    )
    assert main(["horoscopes", "review", "show", str(uuid.uuid4())]) == 1

    async def statuses(s: AsyncSession, _: Any) -> dict[str, str]:
        return {e.locale: e.status for e in (await s.execute(select(HoroscopeEntry))).scalars()}

    assert db_query(statuses) == {"en": "published", "hi": "rejected"}


def test_generate_cli_without_llm_key_fails_cleanly(
    db_url: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from astro_worker import config

    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    config.get_worker_settings.cache_clear()
    try:
        assert main(["horoscopes", "generate", "--period", "daily", "--date", "2026-10-22"]) == 2
        assert "GEMINI_API_KEY" in capsys.readouterr().err
    finally:
        config.get_worker_settings.cache_clear()
