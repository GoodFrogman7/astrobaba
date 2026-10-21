"""`python -m loadtest seed|run|clean` (docs/api/growth.md §6, scripts/loadtest/README.md)."""

import argparse
import asyncio
import datetime as dt
import json
import logging
import resource
import sys
from typing import Any

from astro_api.config import get_settings
from astro_api.db import make_engine, make_sessionmaker
from loadtest import seed as seeding
from loadtest.common import Refused, ensure_run_allowed, read_state, state_dir, write_private_json
from loadtest.run import Options, run, summary
from loadtest.verify import verify


def _raise_fd_limit() -> None:
    """Each session holds two sockets plus HTTP connections: use the hard limit."""
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft < hard:
        resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    settings = get_settings()
    ensure_run_allowed(settings.app_env)
    state = read_state()
    pairs = state["pairs"]
    if len(pairs) < args.sessions:
        raise Refused(f"the seed has {len(pairs)} pairs; seed --sessions {args.sessions} first")
    opts = Options(
        api=args.api.rstrip("/"),
        origin=args.origin,
        minutes=args.minutes,
        interval_s=args.interval,
        ramp_s=args.ramp if args.ramp is not None else min(60.0, args.sessions / 10),
        end_margin_s=args.end_margin,
        http_timeout_s=args.timeout,
    )
    _raise_fd_limit()
    metrics, wall = await run(pairs[: args.sessions], opts)
    report = summary(metrics, wall, args.sessions, opts)
    engine = make_engine(settings.database_url.get_secret_value())
    try:
        report["invariants"] = await verify(
            make_sessionmaker(engine), metrics.session_ids, settings.billing_minute_seconds
        )
    finally:
        await engine.dispose()
    report["pass"] = bool(
        report["errors_total"] == 0
        and report["invariants"]["ok"]
        and (report["round_trip_ms"]["p95"] or 0) < args.p95_target_ms
        and report["completed"] == args.sessions
    )
    stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    path = state_dir() / f"report-{stamp}-{args.sessions}.json"
    write_private_json(path, report)
    report["report_file"] = str(path)
    return report


def _print_report(r: dict[str, Any]) -> None:
    def p(d: dict[str, Any]) -> str:
        return f"p50 {d['p50']}  p95 {d['p95']}  p99 {d['p99']}  max {d['max']}  (n={d['n']})"

    inv = r["invariants"]
    lines = [
        f"sessions {r['sessions']}  completed {r['completed']}  wall {r['wall_seconds']} s",
        f"errors {r['errors_total']}  {r['errors'] or ''}",
        f"connect ms        {p(r['connect_ms'])}",
        f"accept->active ms {p(r['accept_to_active_ms'])}",
        f"round trip ms     {p(r['round_trip_ms'])}",
        f"messages sent {r['messages']['sent']} received {r['messages']['received']}",
        f"billed minutes {r['billed_minutes']}  billed seconds {inv['billed_seconds']:.0f}  "
        f"active seconds {r['active_seconds']}",
        f"invariants {'OK' if inv['ok'] else 'FAILED'}: "
        f"{inv['ledger_transactions_checked']} ledger transactions, "
        f"{inv['unbalanced_transactions']} unbalanced; {inv['sessions_checked']} sessions; "
        f"problems {inv['problems'] or 'none'}; timing {inv['billing_vs_active_time']}",
        f"end reasons {r['end_reasons']}",
        f"PASS {r['pass']}   report {r['report_file']}",
    ]
    print("\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m loadtest")
    sub = ap.add_subparsers(dest="command", required=True)
    s = sub.add_parser("seed", help="create N synthetic clients and astrologers (dev/test only)")
    s.add_argument("--sessions", type=int, required=True)
    s.add_argument("--credit-minutes", type=int, default=60, help="wallet credit per client")
    r = sub.add_parser("run", help="drive N concurrent chat sessions through the public API")
    r.add_argument("--sessions", type=int, required=True)
    r.add_argument("--minutes", type=float, required=True)
    r.add_argument("--api", default="http://localhost:8000")
    r.add_argument("--origin", default="http://localhost:3000", help="one of CORS_ORIGINS")
    r.add_argument("--interval", type=float, default=5.0, help="seconds between messages/side")
    r.add_argument("--ramp", type=float, default=None, help="seconds to spread session starts")
    r.add_argument("--end-margin", type=float, default=10.0, help="end this early (s)")
    r.add_argument("--timeout", type=float, default=30.0, help="HTTP and socket-open timeout")
    r.add_argument("--p95-target-ms", type=float, default=500.0)
    sub.add_parser("clean", help="remove what the seed created (what may be removed)")
    args = ap.parse_args(argv)
    # Our own logs only; never message text (we never hold any beyond the constant).
    logging.basicConfig(level=logging.WARNING)
    try:
        if args.command == "seed":
            print(json.dumps(asyncio.run(seeding.run_seed(args.sessions, args.credit_minutes))))
        elif args.command == "clean":
            print(json.dumps(asyncio.run(seeding.run_clean()), indent=2))
        else:
            report = asyncio.run(_run(args))
            _print_report(report)
            return 0 if report["pass"] else 1
    except Refused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
