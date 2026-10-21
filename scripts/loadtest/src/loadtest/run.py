"""`run`: N concurrent chat sessions through the public API and the chat WebSocket.

Per pair: the astrologer goes online, the client requests a chat, the astrologer finds it in
the incoming list and accepts, both open the socket (REST ticket, then `?ticket=`), and once the
session is active each side sends one message every `interval` seconds. Round trip = from the
sender's `send` to the other side receiving the `message` event (same process clock). The client
ends the session at the planned time; both sides must then receive `ended`.

Nothing here logs or stores message text. Errors are counted by type only.
"""

import asyncio
import collections
import contextlib
import datetime as dt
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed
from websockets.typing import Origin

from loadtest.stats import percentiles

MESSAGE_TEXT = "Load test message, please ignore."
PING_EVERY_S = 20.0
ACTIVE_TIMEOUT_S = 60.0
ENDED_TIMEOUT_S = 20.0
DRAIN_TIMEOUT_S = 5.0


@dataclass
class Metrics:
    connect_ms: list[float] = field(default_factory=list)
    accept_to_active_ms: list[float] = field(default_factory=list)
    rtt_ms: list[float] = field(default_factory=list)
    http_ms: dict[str, list[float]] = field(default_factory=lambda: collections.defaultdict(list))
    errors: collections.Counter[str] = field(default_factory=collections.Counter)
    events: collections.Counter[str] = field(default_factory=collections.Counter)
    sent: int = 0
    received: int = 0
    session_ids: list[str] = field(default_factory=list)
    completed: int = 0
    billed_minutes: int = 0
    active_seconds: float = 0.0
    end_reasons: collections.Counter[str] = field(default_factory=collections.Counter)


class StepFailed(Exception):
    pass


@dataclass(frozen=True)
class Options:
    api: str
    origin: str
    minutes: float
    interval_s: float
    ramp_s: float
    end_margin_s: float
    http_timeout_s: float


def _ms(start: float) -> float:
    return (time.monotonic() - start) * 1000


class Api:
    def __init__(self, client: httpx.AsyncClient, metrics: Metrics) -> None:
        self.client = client
        self.m = metrics

    async def call(
        self,
        name: str,
        method: str,
        path: str,
        token: str,
        body: dict[str, Any] | None = None,
        *,
        expect: int = 200,
        idempotent: bool = False,
    ) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {token}"}
        if idempotent:
            headers["Idempotency-Key"] = f"lt-{uuid.uuid4().hex}"
        start = time.monotonic()
        try:
            r = await self.client.request(method, path, json=body, headers=headers)
        except httpx.HTTPError as exc:
            self.m.errors[f"http:{name}:{type(exc).__name__}"] += 1
            raise StepFailed(name) from None
        self.m.http_ms[name].append(_ms(start))
        if r.status_code != expect:
            code = ""
            with contextlib.suppress(ValueError, AttributeError, TypeError):
                code = str(r.json()["detail"]["code"])
            self.m.errors[f"http:{name}:{r.status_code}:{code}"] += 1
            raise StepFailed(name)
        data: dict[str, Any] = r.json()
        return data


class Side:
    """One participant's socket. Matches the other side's messages against `pending`."""

    def __init__(
        self,
        role: str,
        metrics: Metrics,
        pending: dict[tuple[str, str], float],
        drained: asyncio.Event,
    ) -> None:
        self.role = role
        self.other = "astrologer" if role == "user" else "user"
        self.m = metrics
        self.pending = pending
        self.drained = drained  # set when the last pending message arrives
        self.ws: ClientConnection | None = None
        self.active = asyncio.Event()
        self.ended = asyncio.Event()
        self.status = ""
        self.final: dict[str, Any] | None = None
        self.closing = False
        self.reader: asyncio.Task[None] | None = None

    async def open(self, api: Api, opts: Options, session_id: str, token: str) -> None:
        start = time.monotonic()
        t = await api.call("ws_ticket", "POST", f"/v1/sessions/{session_id}/ws-ticket", token)
        base = opts.api.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
        try:
            self.ws = await connect(
                f"{base}{t['path']}?ticket={t['ticket']}",
                origin=Origin(opts.origin),
                open_timeout=opts.http_timeout_s,
                ping_interval=None,  # the app-level ping below is what the API expects
                close_timeout=5,
            )
            first = json.loads(await asyncio.wait_for(self.ws.recv(), opts.http_timeout_s))
        except (OSError, TimeoutError, ConnectionClosed) as exc:
            code = getattr(getattr(exc, "rcvd", None), "code", None)
            self.m.errors[f"ws_connect:{code or type(exc).__name__}"] += 1
            raise StepFailed("ws_connect") from None
        if first.get("type") != "hello":
            self.m.errors[f"ws_connect:first_frame_{first.get('type')}"] += 1
            raise StepFailed("ws_connect")
        self.m.connect_ms.append(_ms(start))
        self._on_session(first["session"])
        self.reader = asyncio.create_task(self._read())

    def _on_session(self, session: dict[str, Any]) -> None:
        self.status = str(session.get("status"))
        if self.status == "active":
            self.active.set()

    async def _read(self) -> None:
        assert self.ws is not None
        try:
            async for raw in self.ws:
                frame = json.loads(raw)
                kind = frame.get("type")
                if kind in ("state", "hello"):
                    self._on_session(frame["session"])
                elif kind == "ended":
                    self.final = frame["session"]
                    self.status = str(frame["session"].get("status"))
                    self.ended.set()
                elif kind == "message":
                    msg = frame["message"]
                    if msg.get("sender") != self.other:
                        continue  # own echo or a system code
                    sent_at = self.pending.pop((self.other, str(msg.get("client_id"))), None)
                    if sent_at is not None:
                        self.m.rtt_ms.append(_ms(sent_at))
                        self.m.received += 1
                        if not self.pending:
                            self.drained.set()
                elif kind == "error":
                    self.m.errors[f"ws_error:{frame.get('code')}"] += 1
                elif kind == "low_balance":
                    self.m.events["low_balance"] += 1
        except ConnectionClosed:
            pass
        except Exception as exc:
            self.m.errors[f"ws_reader:{type(exc).__name__}"] += 1
        # 4000 = the session is over (after `ended`); anything else unasked-for is an error.
        if not self.closing and self.ws.close_code not in (1000, 4000):
            self.m.errors[f"ws_closed:{self.ws.close_code}"] += 1

    async def chat(self, opts: Options, until: float, offset_s: float) -> None:
        """Send one message every interval (first after `offset_s`) and a ping every 20 s."""
        assert self.ws is not None
        n = 0
        next_send = time.monotonic() + offset_s
        next_ping = time.monotonic() + PING_EVERY_S
        while True:
            now = time.monotonic()
            wake = min(next_send, next_ping)
            if wake >= until:
                return
            await asyncio.sleep(max(0.0, wake - now))
            if self.ended.is_set():
                return
            try:
                if time.monotonic() >= next_ping:
                    await self.ws.send(json.dumps({"type": "ping"}))
                    next_ping += PING_EVERY_S
                if time.monotonic() >= next_send:
                    n += 1
                    client_id = f"{self.role[0]}{n}"
                    self.pending[(self.role, client_id)] = time.monotonic()
                    frame = {"type": "message", "client_id": client_id, "text": MESSAGE_TEXT}
                    await self.ws.send(json.dumps(frame))
                    self.m.sent += 1
                    next_send += opts.interval_s
            except ConnectionClosed:
                self.m.errors["ws_send:closed"] += 1
                return

    async def close(self) -> None:
        self.closing = True
        if self.ws is not None:
            with contextlib.suppress(Exception):
                await self.ws.close()
        if self.reader is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self.reader, 5)


async def _pair(api: Api, opts: Options, pair: dict[str, str], index: int, total: int) -> None:
    m = api.m
    await asyncio.sleep(opts.ramp_s * index / max(1, total))
    client, astro = pair["client_token"], pair["astrologer_token"]
    pending: dict[tuple[str, str], float] = {}
    drained = asyncio.Event()
    user = Side("user", m, pending, drained)
    astrologer = Side("astrologer", m, pending, drained)
    session_id: str | None = None
    try:
        await api.call(
            "presence", "POST", "/v1/astrologer/me/presence", astro, {"status": "online"}
        )
        created = await api.call(
            "create_session",
            "POST",
            "/v1/sessions",
            client,
            {"astrologer_id": pair["astrologer_id"], "kind": "chat", "free": False},
            expect=201,
            idempotent=True,
        )
        session_id = str(created["id"])
        m.session_ids.append(session_id)
        if created["status"] != "requested":
            m.errors[f"flow:created_{created['status']}"] += 1
            raise StepFailed("create")
        incoming = await api.call("incoming", "GET", "/v1/astrologer/me/sessions/incoming", astro)
        if session_id not in {str(s["id"]) for s in incoming["items"]}:
            m.errors["flow:not_in_incoming"] += 1
            raise StepFailed("incoming")
        accepted_at = time.monotonic()
        await api.call("accept", "POST", f"/v1/sessions/{session_id}/accept", astro)
        await asyncio.gather(
            user.open(api, opts, session_id, client),
            astrologer.open(api, opts, session_id, astro),
        )
        try:
            await asyncio.wait_for(
                asyncio.gather(user.active.wait(), astrologer.active.wait()), ACTIVE_TIMEOUT_S
            )
        except TimeoutError:
            m.errors["timeout:active"] += 1
            raise StepFailed("active") from None
        m.accept_to_active_ms.append(_ms(accepted_at))
        until = time.monotonic() + max(1.0, opts.minutes * 60 - opts.end_margin_s)
        await asyncio.gather(
            user.chat(opts, until, offset_s=opts.interval_s / 4),
            astrologer.chat(opts, until, offset_s=opts.interval_s * 3 / 4),
        )
        drained.clear()
        if pending:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(drained.wait(), DRAIN_TIMEOUT_S)
        if pending:
            m.errors["message:not_delivered"] += len(pending)
            pending.clear()
        if not user.ended.is_set():
            await api.call("end", "POST", f"/v1/sessions/{session_id}/end", client)
        try:
            await asyncio.wait_for(
                asyncio.gather(user.ended.wait(), astrologer.ended.wait()), ENDED_TIMEOUT_S
            )
        except TimeoutError:
            m.errors["timeout:ended_event"] += 1
    except StepFailed:
        pass
    except Exception as exc:
        m.errors[f"exception:{type(exc).__name__}"] += 1
    finally:
        await asyncio.gather(user.close(), astrologer.close())
        if session_id is not None:
            await _finish(api, session_id, client)
        with contextlib.suppress(StepFailed):
            await api.call(
                "presence", "POST", "/v1/astrologer/me/presence", astro, {"status": "offline"}
            )


async def _finish(api: Api, session_id: str, client: str) -> None:
    """Make sure the session is over (cancel or end if a step failed) and record its result."""
    m = api.m
    with contextlib.suppress(StepFailed):
        view = await api.call("get_session", "GET", f"/v1/sessions/{session_id}", client)
        if view["status"] in ("queued", "requested", "accepted"):
            m.errors["cleanup:cancelled"] += 1
            view = await api.call("cancel", "POST", f"/v1/sessions/{session_id}/cancel", client)
        elif view["status"] == "active":
            m.errors["cleanup:ended"] += 1
            view = await api.call("end", "POST", f"/v1/sessions/{session_id}/end", client)
        m.end_reasons[str(view.get("end_reason"))] += 1
        if view["status"] == "completed":
            m.completed += 1
        m.billed_minutes += int(view.get("billed_minutes") or 0)
        if view.get("started_at") and view.get("ended_at"):
            started = dt.datetime.fromisoformat(view["started_at"])
            ended = dt.datetime.fromisoformat(view["ended_at"])
            m.active_seconds += (ended - started).total_seconds()


async def run(pairs: list[dict[str, str]], opts: Options) -> tuple[Metrics, float]:
    metrics = Metrics()
    limits = httpx.Limits(max_connections=max(20, len(pairs)), max_keepalive_connections=100)
    async with httpx.AsyncClient(
        base_url=opts.api, timeout=opts.http_timeout_s, limits=limits
    ) as client:
        api = Api(client, metrics)
        r = await client.get("/healthz")
        r.raise_for_status()
        start = time.monotonic()
        await asyncio.gather(*(_pair(api, opts, p, i, len(pairs)) for i, p in enumerate(pairs)))
    return metrics, time.monotonic() - start


def summary(metrics: Metrics, wall_s: float, sessions: int, opts: Options) -> dict[str, Any]:
    return {
        "sessions": sessions,
        "minutes": opts.minutes,
        "message_interval_s": opts.interval_s,
        "wall_seconds": round(wall_s, 1),
        "completed": metrics.completed,
        "end_reasons": dict(metrics.end_reasons),
        "errors_total": sum(metrics.errors.values()),
        "errors": dict(sorted(metrics.errors.items())),
        "events": dict(metrics.events),
        "connect_ms": percentiles(metrics.connect_ms),
        "accept_to_active_ms": percentiles(metrics.accept_to_active_ms),
        "round_trip_ms": percentiles(metrics.rtt_ms),
        "messages": {"sent": metrics.sent, "received": metrics.received},
        "http_ms": {k: percentiles(v) for k, v in sorted(metrics.http_ms.items())},
        "billed_minutes": metrics.billed_minutes,
        "active_seconds": round(metrics.active_seconds, 1),
    }
