"""Demo marketplace data for development and tests. NEVER production (PLAN.md §5 Phase 3).

`python -m astro_api.seed demo-astrologers [--count 30]`

Every seeded row is labelled: astrologers have `is_seed = true`, names "Demo Astrologer NN",
bios starting "[Demo profile]", reviews starting "[Demo review]". Seed accounts use phone
numbers that are not valid Indian mobiles (+9100000…), so nobody can sign in as them. Re-running
replaces the previous seed. Deterministic: the same count gives the same data.
"""

import argparse
import asyncio
import datetime as dt
import random
import uuid
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from astro_api.config import Settings, get_settings
from astro_api.db import make_engine, make_sessionmaker
from astro_api.marketplace import busy_until_key, presence_key
from astro_api.models import (
    DEFAULT_FLAGS,
    VERIFICATION_STEPS,
    Astrologer,
    AstrologerVerification,
    ConsultSession,
    Review,
    User,
)
from astro_api.taxonomy import taxonomy

SEED_PHONE_PREFIX = "+9100000"  # +91 then a leading 0: never a real Indian mobile number
CLIENT_PHONE = SEED_PHONE_PREFIX + "00000"
PRESENCE_TTL_S = 6 * 3600  # long so a dev directory shows presence; real heartbeats use 120 s
GENDER_CYCLE = ("female", "male", "female", "male", "other")
NON_PUBLIC = ("applied", "kyc_submitted", "interview", "suspended", "rejected")
REVIEW_LINES = (
    "Clear explanation of my chart and patient with questions.",
    "Helpful session; the dasha timeline made sense afterwards.",
    "Good listener, practical suggestions, no pressure to buy anything.",
    "Explained the matching report koota by koota.",
    "Calm and respectful. Would consult again.",
    "Answers were general; I expected more detail.",
    "Took time to understand my question before answering.",
)


class SeedRefused(RuntimeError):
    pass


def _phone(n: int) -> str:
    return f"{SEED_PHONE_PREFIX}{n:05d}"


def _bios(name: str, skills: list[str]) -> tuple[str, str]:
    names = {s["id"]: s for s in taxonomy()["skills"]}
    en = ", ".join(names[s]["en"] for s in skills)
    hi = ", ".join(names[s]["hi"] for s in skills)
    return (
        f"[Demo profile] {name} is sample data for development, not a real astrologer. "
        f"Listed skills: {en}.",
        f"[डेमो प्रोफ़ाइल] {name} विकास के लिए नमूना डेटा है, कोई वास्तविक ज्योतिषी नहीं। कौशल: {hi}।",
    )


async def _clear(db: AsyncSession, redis: Redis) -> None:
    old = list((await db.execute(select(Astrologer.id).where(Astrologer.is_seed))).scalars())
    if old:
        await redis.delete(*[presence_key(a) for a in old], *[busy_until_key(a) for a in old])
    await db.execute(delete(Astrologer).where(Astrologer.is_seed))
    await db.execute(delete(User).where(User.phone.like(f"{SEED_PHONE_PREFIX}%")))


def _astrologer(rng: random.Random, i: int, name: str, status: str, now: dt.datetime) -> Astrologer:
    tax = taxonomy()
    all_skills = [s["id"] for s in tax["skills"]]
    all_langs = [lang["id"] for lang in tax["languages"]]
    tiers = tax["tiers"]
    skills = sorted({all_skills[i % len(all_skills)], *rng.sample(all_skills, rng.randint(0, 2))})
    langs = {all_langs[i % len(all_langs)]}
    if rng.random() < 0.7:
        langs.add(rng.choice(("hi", "en")))
    tier = tiers[i % len(tiers)]
    low, high = tier["min_price_per_min_paise"], tier["max_price_per_min_paise"]
    price = rng.randrange(low, high + 1, 100)
    bio, bio_hi = _bios(name, skills)
    live = status in ("probation", "approved", "suspended")
    approved_at = now - dt.timedelta(days=rng.randint(10, 700)) if live else None
    return Astrologer(
        display_name=name,
        bio=bio,
        bio_hi=bio_hi,
        skills=skills,
        languages=sorted(langs),
        gender=GENDER_CYCLE[i % len(GENDER_CYCLE)],
        tier=tier["id"] if live else None,
        price_per_min_paise=price if live else None,
        requested_price_per_min_paise=price,
        experience_years=rng.randint(1, 35),
        status=status,
        status_before_suspension="approved" if status == "suspended" else None,
        probation_until=now + dt.timedelta(days=20) if status == "probation" else None,
        flags=dict(DEFAULT_FLAGS),
        is_seed=True,
        accepts_terms_at=now,
        approved_at=approved_at,
        suspended_reason="[Demo] suspended for testing" if status == "suspended" else None,
        rejected_reason="[Demo] rejected for testing" if status == "rejected" else None,
    )


def _verifications(a: Astrologer, now: dt.datetime) -> list[AstrologerVerification]:
    passed = {
        "applied": 0,
        "kyc_submitted": 0,
        "interview": 2,
        "probation": 3,
        "approved": 4,
        "suspended": 4,
        "rejected": 1,
    }[a.status]
    return [
        AstrologerVerification(
            astrologer_id=a.id,
            step=step,
            status="passed" if n < passed else "pending",
            note="[Demo]" if n < passed else None,
            at=now if n < passed else None,
        )
        for n, step in enumerate(VERIFICATION_STEPS)
    ]


async def seed_demo_astrologers(
    sessionmaker: async_sessionmaker[AsyncSession],
    redis: Redis,
    settings: Settings,
    count: int = 30,
    rng_seed: int = 7,
) -> dict[str, Any]:
    if settings.app_env not in ("development", "test"):
        raise SeedRefused("demo data is only for development and test (APP_ENV)")
    rng = random.Random(rng_seed)  # noqa: S311 - deterministic demo data, not security
    now = dt.datetime.now(dt.UTC)
    public_ids: list[uuid.UUID] = []
    reviews = 0
    async with sessionmaker() as db:
        await _clear(db, redis)
        client = User(phone=CLIENT_PHONE, device_ids=[], roles=[])
        db.add(client)
        await db.flush()

        plan = [
            (f"Demo Astrologer {i + 1:02d}", "probation" if i % 5 == 4 else "approved")
            for i in range(count)
        ]
        plan += [(f"Demo Applicant {n + 1:02d}", s) for n, s in enumerate(NON_PUBLIC)]
        for i, (name, status) in enumerate(plan):
            user = User(phone=_phone(i + 1), device_ids=[], roles=[])
            db.add(user)
            await db.flush()
            a = _astrologer(rng, i, name, status, now)
            a.user_id = user.id
            a.slug = name.lower().replace(" ", "-")
            db.add(a)
            await db.flush()
            db.add_all(_verifications(a, now))
            if status not in ("probation", "approved"):
                continue
            public_ids.append(a.id)
            for n in range(rng.randint(0, 40)):
                ended = now - dt.timedelta(days=rng.randint(1, 300), minutes=rng.randint(0, 600))
                session = ConsultSession(
                    user_id=client.id,
                    astrologer_id=a.id,
                    kind="chat",
                    status="completed",
                    started_at=ended - dt.timedelta(minutes=rng.randint(5, 40)),
                    ended_at=ended,
                )
                db.add(session)
                await db.flush()
                held = i == 0 and n == 0
                reported = i == 0 and n == 1
                db.add(
                    Review(
                        session_id=session.id,
                        astrologer_id=a.id,
                        user_id=client.id,
                        rating=rng.choices((1, 2, 3, 4, 5), weights=(1, 2, 5, 12, 14))[0],
                        text=f"[Demo review] {rng.choice(REVIEW_LINES)}",
                        status="flagged" if (held or reported) else "published",
                        auto_flag_reason="[Demo] held for moderation" if held else None,
                        report_count=1 if reported else 0,
                        created_at=ended,
                    )
                )
                reviews += 1
        # A session awaiting a review, so the review flow can be tried in development.
        if public_ids:
            db.add(
                ConsultSession(
                    user_id=client.id,
                    astrologer_id=public_ids[0],
                    kind="chat",
                    status="completed",
                    started_at=now - dt.timedelta(minutes=30),
                    ended_at=now - dt.timedelta(minutes=10),
                )
            )
        await db.commit()

    pipe = redis.pipeline()
    online = busy = 0
    for i, aid in enumerate(public_ids):
        if i % 3 == 0:
            pipe.set(presence_key(aid), "online", ex=PRESENCE_TTL_S)
            online += 1
        elif i % 5 == 1:
            until = now + dt.timedelta(minutes=rng.randint(5, 40))
            pipe.set(presence_key(aid), "busy", ex=PRESENCE_TTL_S)
            pipe.set(busy_until_key(aid), str(until.timestamp()), ex=PRESENCE_TTL_S)
            busy += 1
    await pipe.execute()
    return {
        "public": len(public_ids),
        "non_public": len(NON_PUBLIC),
        "reviews": reviews,
        "online": online,
        "busy": busy,
    }


async def _run(count: int) -> dict[str, Any]:
    settings = get_settings()
    engine = make_engine(settings.database_url.get_secret_value())
    redis = Redis.from_url(settings.redis_url.get_secret_value())
    try:
        return await seed_demo_astrologers(make_sessionmaker(engine), redis, settings, count)
    finally:
        await redis.aclose()
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m astro_api.seed")
    sub = ap.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo-astrologers", help="replace the demo marketplace data")
    demo.add_argument("--count", type=int, default=30)
    args = ap.parse_args(argv)
    try:
        print(asyncio.run(_run(args.count)))
    except SeedRefused as exc:
        print(f"refused: {exc}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
