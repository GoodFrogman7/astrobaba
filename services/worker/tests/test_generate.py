import datetime as dt
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.models import AuditLog, HoroscopeEntry
from astro_worker.horoscopes import review_approve

pytestmark = pytest.mark.integration
DAY = dt.date(2026, 10, 22)


def test_generate_stores_pending_entries(
    generate_run: Any, db_query: Any, facts: dict[str, Any]
) -> None:
    report = generate_run()
    assert sorted(report.stored) == [
        "daily/aries/2026-10-22/en",
        "daily/aries/2026-10-22/hi",
        "daily/leo/2026-10-22/en",
        "daily/leo/2026-10-22/hi",
    ]
    assert report.failed == {} and report.skipped == []

    async def check(s: AsyncSession, _: Any) -> None:
        rows = list((await s.execute(select(HoroscopeEntry))).scalars())
        assert {r.status for r in rows} == {"pending_review"}
        assert {r.model for r in rows} == {"fake"}
        assert all(r.prompt_version == "horoscope-v1" for r in rows)
        r = rows[0]
        assert r.ist_date == r.ist_date_end == DAY and r.lucky == facts["lucky"]
        for area, v in facts["areas"].items():
            assert r.scores[area] == {"score": v["score"], "label": v["label"]}
        assert r.facts["sign"] == r.sign
        audits = (await s.execute(select(func.count()).select_from(AuditLog))).scalar_one()
        assert audits == 4

    db_query(check)


def test_idempotent_and_force_never_overwrites_published(generate_run: Any, db_query: Any) -> None:
    generate_run(signs=("aries",))
    again = generate_run(signs=("aries",))
    assert again.stored == [] and len(again.skipped) == 2

    async def publish_en(s: AsyncSession, maker: Any) -> None:
        e = (
            await s.execute(select(HoroscopeEntry).where(HoroscopeEntry.locale == "en"))
        ).scalar_one()
        assert await review_approve(maker, e.id, "Asha", None) == []

    db_query(publish_en)
    forced = generate_run(force=True, signs=("aries",))
    assert forced.stored == ["daily/aries/2026-10-22/hi"]
    assert forced.skipped == ["daily/aries/2026-10-22/en"]


def test_facts_unavailable_is_reported(generate_run: Any) -> None:
    report = generate_run(status=500, signs=("aries",))
    assert report.stored == [] and list(report.failed) == ["daily/aries"]
