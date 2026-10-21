"""Operator commands. `python -m astro_api.cli grant-role <phone> admin` / `revoke-role`."""

import argparse
import asyncio
import sys

from sqlalchemy import select

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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m astro_api.cli")
    sub = ap.add_subparsers(dest="command", required=True)
    for name in ("grant-role", "revoke-role"):
        p = sub.add_parser(name)
        p.add_argument("phone")
        p.add_argument("role", choices=ROLES)
    args = ap.parse_args(argv)
    try:
        phone = normalize_phone(args.phone)
    except ApiError as exc:
        print(exc.message, file=sys.stderr)
        return 2
    print(asyncio.run(set_role(phone, args.role, args.command == "grant-role")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
