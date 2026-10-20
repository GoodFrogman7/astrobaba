"""Worker CLI.

python -m astro_worker horoscopes generate --period daily --date 2026-10-22 [--signs aries,leo]
                                           [--locales en,hi] [--force]
python -m astro_worker horoscopes review list [--status pending_review]
python -m astro_worker horoscopes review show ID
python -m astro_worker horoscopes review approve ID --reviewer NAME [--edit-file sections.json]
python -m astro_worker horoscopes review reject ID --reviewer NAME --reason TEXT
"""

import argparse
import asyncio
import datetime as dt
import json
import sys
import uuid
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from astro_api.config import get_settings
from astro_api.db import make_engine, make_sessionmaker
from astro_worker import horoscopes
from astro_worker.config import get_worker_settings
from astro_worker.llm import ProviderError, make_provider


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m astro_worker")
    sub = p.add_subparsers(dest="group", required=True)
    h = sub.add_parser("horoscopes").add_subparsers(dest="command", required=True)

    g = h.add_parser("generate", help="generate pending horoscopes for review")
    g.add_argument("--period", choices=["daily", "weekly", "monthly"], required=True)
    g.add_argument("--date", type=dt.date.fromisoformat, help="IST date (default: today in IST)")
    g.add_argument("--signs", default=",".join(horoscopes.SIGNS))
    g.add_argument("--locales", default="en,hi")
    g.add_argument(
        "--force", action="store_true", help="regenerate pending/rejected (never published)"
    )

    r = h.add_parser("review").add_subparsers(dest="action", required=True)
    lst = r.add_parser("list")
    lst.add_argument(
        "--status", default="pending_review", choices=["pending_review", "published", "rejected"]
    )
    show = r.add_parser("show")
    show.add_argument("id", type=uuid.UUID)
    ap = r.add_parser("approve")
    ap.add_argument("id", type=uuid.UUID)
    ap.add_argument("--reviewer", required=True)
    ap.add_argument("--edit-file", type=Path, help="JSON with edited sections")
    rj = r.add_parser("reject")
    rj.add_argument("id", type=uuid.UUID)
    rj.add_argument("--reviewer", required=True)
    rj.add_argument("--reason", required=True)
    return p


def _split(value: str, allowed: tuple[str, ...]) -> list[str]:
    items = [v.strip() for v in value.split(",") if v.strip()]
    bad = [v for v in items if v not in allowed]
    if bad:
        raise SystemExit(f"unknown value(s): {', '.join(bad)}")
    return items


async def _run(args: argparse.Namespace) -> int:
    engine = make_engine(get_settings().database_url.get_secret_value())
    maker = make_sessionmaker(engine)
    try:
        if args.command == "generate":
            ws = get_worker_settings()
            try:
                provider = make_provider(ws)
            except ProviderError as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 2
            day = args.date or dt.datetime.now(ZoneInfo("Asia/Kolkata")).date()
            async with httpx.AsyncClient(timeout=30) as http:
                report = await horoscopes.generate(
                    period=args.period,
                    day=day,
                    signs=_split(args.signs, horoscopes.SIGNS),
                    locales=_split(args.locales, ("en", "hi")),
                    force=args.force,
                    provider=provider,
                    http=http,
                    astro_url=ws.astro_url,
                    sessionmaker=maker,
                )
            print(
                json.dumps(
                    {"stored": report.stored, "skipped": report.skipped, "failed": report.failed},
                    ensure_ascii=False,
                    indent=1,
                )
            )
            return 1 if report.failed else 0

        if args.action == "list":
            for row in await horoscopes.review_list(maker, args.status):
                print(json.dumps(row, ensure_ascii=False))
            return 0
        if args.action == "show":
            entry = await horoscopes.review_show(maker, args.id)
            if entry is None:
                print("error: not found", file=sys.stderr)
                return 1
            print(json.dumps(entry, ensure_ascii=False, indent=1))
            return 0
        if args.action == "approve":
            sections = (
                json.loads(args.edit_file.read_text(encoding="utf-8")) if args.edit_file else None
            )
            errors = await horoscopes.review_approve(maker, args.id, args.reviewer, sections)
        else:
            errors = await horoscopes.review_reject(maker, args.id, args.reviewer, args.reason)
        for e in errors:
            print(f"error: {e}", file=sys.stderr)
        return 1 if errors else 0
    finally:
        await engine.dispose()


def main(argv: list[str]) -> int:
    return asyncio.run(_run(_parser().parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
