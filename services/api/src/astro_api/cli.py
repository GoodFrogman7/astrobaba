"""Operator commands. `python -m astro_api.cli grant-role <phone> admin` / `revoke-role`;
`reconcile [--date YYYY-MM-DD]` (default: yesterday IST; exit 1 on drift or error);
`expire-promo` (expire promo lots past their expiry); `payouts generate [--period YYYY-MM]`
(default: the previous IST month; run from cron on the 1st)."""

import argparse
import asyncio
import datetime as dt
import sys

from redis.asyncio import Redis
from sqlalchemy import select

from astro_api import earnings, payments, payouts, reconciliation, wallet
from astro_api.config import get_settings
from astro_api.db import make_engine, make_sessionmaker
from astro_api.errors import ApiError
from astro_api.models import User
from astro_api.phone import mask_phone, normalize_phone
from astro_api.roles import ROLES


async def set_role(phone: str, role: str, grant: bool) -> str:
    engine = make_engine(get_settings().database_url.get_secret_value())
    try:
        async with make_sessionmaker(engine)() as db:
            user = (await db.execute(select(User).where(User.phone == phone))).scalar_one_or_none()
            if user is None:
                if not grant:
                    return f"no user {mask_phone(phone)}; nothing to revoke"
                user = User(phone=phone, device_ids=[], roles=[])
                db.add(user)
            roles = set(user.roles or [])
            roles = roles | {role} if grant else roles - {role}
            user.roles = sorted(roles)
            await db.commit()
            return f"{mask_phone(phone)}: roles = {user.roles}"
    finally:
        await engine.dispose()


async def reconcile(day: dt.date) -> tuple[str, int]:
    settings = get_settings()
    engine = make_engine(settings.database_url.get_secret_value())
    redis = Redis.from_url(settings.redis_url.get_secret_value())
    try:
        async with make_sessionmaker(engine)() as db:
            gateway = payments.make_gateway(settings, redis)
            run = await reconciliation.run(db, gateway, day, trigger="cli")
            await db.commit()
            return run.status, run.drift_paise
    finally:
        await redis.aclose()
        await engine.dispose()


async def expire_promo() -> int:
    engine = make_engine(get_settings().database_url.get_secret_value())
    total = 0
    try:
        async with make_sessionmaker(engine)() as db:
            while True:
                expired = await wallet.expire_due_lots(db, now=dt.datetime.now(dt.UTC), limit=200)
                await db.commit()
                if expired == 0:
                    return total
                total += expired
    finally:
        await engine.dispose()


async def generate_payouts(period: str) -> payouts.GenerateResult:
    engine = make_engine(get_settings().database_url.get_secret_value())
    try:
        async with make_sessionmaker(engine)() as db:
            result = await payouts.generate(db, period, actor=payouts.SYSTEM_ACTOR)
            await db.commit()
            return result
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m astro_api.cli")
    sub = ap.add_subparsers(dest="command", required=True)
    for name in ("grant-role", "revoke-role"):
        p = sub.add_parser(name)
        p.add_argument("phone")
        p.add_argument("role", choices=ROLES)
    rec = sub.add_parser("reconcile", help="ledger vs gateway for one IST day")
    rec.add_argument("--date", type=dt.date.fromisoformat, default=None)
    sub.add_parser("expire-promo", help="expire promo lots past their expiry")
    pay = sub.add_parser("payouts", help="monthly astrologer payouts")
    pay_sub = pay.add_subparsers(dest="payouts_command", required=True)
    gen = pay_sub.add_parser("generate", help="generate payouts for an ended IST month")
    gen.add_argument("--period", default=None, help="YYYY-MM (default: previous IST month)")
    args = ap.parse_args(argv)
    if args.command == "payouts":
        period = args.period or earnings.previous_period()
        try:
            result = asyncio.run(generate_payouts(period))
        except payouts.PayoutError as exc:
            print(f"{exc.code}: {exc.message}", file=sys.stderr)
            return 2
        print(
            f"payouts period={result.period} generated={result.generated}"
            f" updated={result.updated} skipped={result.skipped}"
            f" carried_forward={result.carried_forward}"
        )
        return 0
    if args.command == "reconcile":
        day = args.date or reconciliation.default_day()
        status, drift = asyncio.run(reconcile(day))
        print(f"reconciliation {day.isoformat()} status={status} drift_paise={drift}")
        return 0 if status == "ok" else 1
    if args.command == "expire-promo":
        print(f"expired_paise={asyncio.run(expire_promo())}")
        return 0
    try:
        phone = normalize_phone(args.phone)
    except ApiError as exc:
        print(exc.message, file=sys.stderr)
        return 2
    print(asyncio.run(set_role(phone, args.role, args.command == "grant-role")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
