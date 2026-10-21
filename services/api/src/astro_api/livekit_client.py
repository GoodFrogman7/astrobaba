"""LiveKit for in-app voice calls (docs/api/portal.md §1, ADR-0008).

`CallBackend` is everything the API needs from LiveKit: mint a join token, verify a webhook,
make sure a room exists, list who is in it (the meter checks this before charging a call
minute) and delete it. `LiveKitCalls` talks to a real server (self-hosted or
LiveKit Cloud) through `livekit-api`; `FakeCalls` signs and verifies with the same real code
but keeps rooms in memory, for tests and for development without a LiveKit server.

Privacy: a participant identity is only the role (`user` / `astrologer`), the room name is
`session-{id}`, and nothing about a person is put in a token, a room or a log line.

The app gets its backend from `app.state.calls`, created on first use from the settings
(`backend_from_settings`); tests set `app.state.calls` themselves.
"""

import datetime as dt
import re
import uuid
from dataclasses import dataclass
from typing import Protocol

import aiohttp
from livekit import api

from astro_api.config import Settings

ROOM_PREFIX = "session-"
TOKEN_TTL_S = 600  # only needed to join; a rejoin asks for a new token
LIVEKIT_TIMEOUT_S = 5.0
# The meter's presence check before charging a call minute: short, so a slow LiveKit cannot
# hold up the tick (checks for different calls run concurrently).
VERIFY_TIMEOUT_S = 2.0
# Room settings carried in the token and used when we create the room: two people, and LiveKit
# closes it soon after both have gone (we delete it ourselves on every end anyway).
MAX_PARTICIPANTS = 2
EMPTY_TIMEOUT_S = 60
DEPARTURE_TIMEOUT_S = 120

# Dev-only signing pair for FakeCalls when no LiveKit keys are configured (never production).
DEV_API_KEY = "devkey"
DEV_API_SECRET = "dev-only-livekit-secret-change-me-0000"  # noqa: S105 - refused in production

PARTICIPANT_EVENTS = ("participant_joined", "participant_left", "participant_connection_aborted")

_ROOM = re.compile(rf"^{ROOM_PREFIX}([0-9a-fA-F-]{{36}})$")


def room_name(session_id: uuid.UUID) -> str:
    return f"{ROOM_PREFIX}{session_id}"


def session_of_room(name: str) -> uuid.UUID | None:
    """The session id of one of our rooms, or None for any other name."""
    m = _ROOM.match(name or "")
    if m is None:
        return None
    try:
        return uuid.UUID(m.group(1))
    except ValueError:
        return None


class InvalidWebhook(Exception):
    """Missing or bad signature, or a body that does not match it."""


@dataclass(frozen=True)
class CallEvent:
    """The parts of a LiveKit webhook the API acts on (no names, no metadata)."""

    id: str
    event: str
    room: str
    identity: str
    participant_sid: str
    created_at: dt.datetime | None


class CallBackend(Protocol):
    public_url: str

    def mint_token(self, *, room: str, identity: str, ttl_s: int = TOKEN_TTL_S) -> str: ...

    def verify_webhook(self, body: bytes, authorization: str | None) -> CallEvent: ...

    async def ensure_room(self, room: str) -> None: ...

    async def list_participants(self, room: str) -> set[str]:
        """Identities in the room now; a missing room is empty. Raises when LiveKit cannot
        answer."""
        ...

    async def delete_room(self, room: str) -> None:
        """Delete the room and disconnect everyone in it; a missing room is not an error."""
        ...


def call_grants(room: str) -> api.VideoGrants:
    """Join one room; publish the microphone only; subscribe; no data, no admin, no metadata."""
    return api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_publish_sources=["microphone"],
        can_subscribe=True,
        can_publish_data=False,
        can_update_own_metadata=False,
    )


def room_config(room: str) -> api.RoomConfiguration:
    return api.RoomConfiguration(
        name=room,
        max_participants=MAX_PARTICIPANTS,
        empty_timeout=EMPTY_TIMEOUT_S,
        departure_timeout=DEPARTURE_TIMEOUT_S,
    )


class _Signer:
    """Token minting and webhook verification with the real livekit-api code."""

    def __init__(self, api_key: str, api_secret: str, public_url: str) -> None:
        if not api_key or not api_secret:
            raise ValueError("LiveKit api key and secret are required")
        self._key = api_key
        self._secret = api_secret
        self.public_url = public_url

    def mint_token(self, *, room: str, identity: str, ttl_s: int = TOKEN_TTL_S) -> str:
        return (
            api.AccessToken(self._key, self._secret)
            .with_identity(identity)
            .with_kind("standard")
            .with_grants(call_grants(room))
            .with_room_config(room_config(room))
            .with_ttl(dt.timedelta(seconds=ttl_s))
            .to_jwt()
        )

    def verify_webhook(self, body: bytes, authorization: str | None) -> CallEvent:
        """LiveKit signs a webhook with a JWT (issuer = API key, HS256 with the secret) whose
        `sha256` claim is the base64 SHA-256 of the raw body."""
        if not authorization:
            raise InvalidWebhook("missing Authorization")
        token = authorization.removeprefix("Bearer ").strip()
        try:
            text = body.decode("utf-8")
            receiver = api.WebhookReceiver(api.TokenVerifier(self._key, self._secret))
            event = receiver.receive(text, token)
        except Exception as exc:  # jwt errors, hash mismatch, bad JSON: all the same to us
            raise InvalidWebhook(type(exc).__name__) from None
        created = (
            dt.datetime.fromtimestamp(event.created_at, dt.UTC) if event.created_at > 0 else None
        )
        return CallEvent(
            id=event.id,
            event=event.event,
            room=event.room.name,
            identity=event.participant.identity,
            participant_sid=event.participant.sid,
            created_at=created,
        )


class LiveKitCalls(_Signer):
    """A real LiveKit server (LIVEKIT_URL for the server API, LIVEKIT_PUBLIC_URL for browsers)."""

    def __init__(self, settings: Settings) -> None:
        super().__init__(
            settings.livekit_api_key,
            settings.livekit_api_secret.get_secret_value(),
            settings.livekit_public_url,
        )
        self._url = settings.livekit_url

    def _client(self, timeout_s: float = LIVEKIT_TIMEOUT_S) -> api.LiveKitAPI:
        return api.LiveKitAPI(
            self._url,
            self._key,
            self._secret,
            timeout=aiohttp.ClientTimeout(total=timeout_s),
            failover=False,
        )

    async def ensure_room(self, room: str) -> None:
        cfg = room_config(room)
        lk = self._client()
        try:
            # Returns the existing room when it is already there.
            await lk.room.create_room(
                api.CreateRoomRequest(
                    name=room,
                    max_participants=cfg.max_participants,
                    empty_timeout=cfg.empty_timeout,
                    departure_timeout=cfg.departure_timeout,
                )
            )
        finally:
            await lk.aclose()

    async def list_participants(self, room: str) -> set[str]:
        lk = self._client(VERIFY_TIMEOUT_S)
        try:
            found = await lk.room.list_participants(api.ListParticipantsRequest(room=room))
        except api.ServerError as exc:
            if exc.code == api.ServerErrorCode.NOT_FOUND:
                return set()
            raise
        finally:
            await lk.aclose()
        return {p.identity for p in found.participants}

    async def delete_room(self, room: str) -> None:
        lk = self._client()
        try:
            await lk.room.delete_room(api.DeleteRoomRequest(room=room))
        except api.ServerError as exc:
            if exc.code != api.ServerErrorCode.NOT_FOUND:
                raise
        finally:
            await lk.aclose()


class FakeCalls(_Signer):
    """Real tokens and webhook verification, rooms in memory. Tests can make deletes fail, take
    LiveKit "down" for presence checks, or set who a room listing shows (`present[room]`; by
    default both roles, so development without LiveKit can still bill a call)."""

    def __init__(
        self,
        api_key: str = DEV_API_KEY,
        api_secret: str = DEV_API_SECRET,
        public_url: str = "ws://localhost:7880",
    ) -> None:
        super().__init__(api_key, api_secret, public_url)
        self.rooms: set[str] = set()
        self.created: list[str] = []
        self.deleted: list[str] = []
        self.fail_deletes = 0  # the next N deletes raise, like an unreachable server
        self.present: dict[str, set[str]] = {}
        self.down = False  # list_participants raises, like an unreachable server
        self.listed: list[str] = []  # rooms whose participants were listed, in order

    async def ensure_room(self, room: str) -> None:
        self.created.append(room)
        self.rooms.add(room)

    async def list_participants(self, room: str) -> set[str]:
        self.listed.append(room)
        if self.down:
            raise ConnectionError("LiveKit unreachable (fake)")
        return set(self.present.get(room, {"user", "astrologer"}))

    async def delete_room(self, room: str) -> None:
        if self.fail_deletes > 0:
            self.fail_deletes -= 1
            raise ConnectionError("LiveKit unreachable (fake)")
        self.deleted.append(room)
        self.rooms.discard(room)


def backend_from_settings(settings: Settings) -> CallBackend:
    """LiveKit when keys are configured; otherwise the in-memory fake (development and test
    only; production refuses voice_calls without keys, see config.check_production_settings)."""
    if settings.livekit_api_key and settings.livekit_api_secret.get_secret_value():
        return LiveKitCalls(settings)
    if settings.is_production:
        raise RuntimeError("LIVEKIT_API_KEY/LIVEKIT_API_SECRET are not set")
    return FakeCalls(public_url=settings.livekit_public_url)
