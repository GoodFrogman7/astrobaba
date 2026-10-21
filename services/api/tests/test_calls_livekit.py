"""Against a real LiveKit server (the dev compose service `livekit`); skipped when it is not
reachable, e.g. in CI. Checks that our backend's room calls and tokens work with the server
we deploy: create the room, see it listed, list its (no) participants, delete it (twice: a
missing room is not an error)."""

import asyncio
import os
import urllib.request
import uuid

import aiohttp
import pytest
from livekit import api
from pydantic import SecretStr

from astro_api.config import Settings
from astro_api.livekit_client import LiveKitCalls, room_name

URL = os.environ.get("LIVEKIT_TEST_URL", "http://localhost:7880")
KEY = os.environ.get("LIVEKIT_TEST_KEY", "devkey")
SECRET = os.environ.get("LIVEKIT_TEST_SECRET", "dev-only-livekit-secret-change-me-0000")


def reachable() -> bool:
    try:
        with urllib.request.urlopen(URL, timeout=1) as r:  # noqa: S310 - fixed local URL
            return bool(r.status == 200)
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not reachable(), reason=f"no LiveKit server at {URL}")


def test_room_lifecycle_and_token_on_a_real_server() -> None:
    settings = Settings(
        app_env="test",
        livekit_url=URL,
        livekit_api_key=KEY,
        livekit_api_secret=SecretStr(SECRET),
    )
    backend = LiveKitCalls(settings)
    room = room_name(uuid.uuid4())

    async def run() -> None:
        lk = api.LiveKitAPI(
            URL, KEY, SECRET, timeout=aiohttp.ClientTimeout(total=5), failover=False
        )
        try:
            await backend.ensure_room(room)
            await backend.ensure_room(room)  # idempotent
            listed = await lk.room.list_rooms(api.ListRoomsRequest(names=[room]))
            assert [r.name for r in listed.rooms] == [room]
            assert listed.rooms[0].max_participants == 2
            assert await backend.list_participants(room) == set()  # nobody has joined
            await backend.delete_room(room)
            listed = await lk.room.list_rooms(api.ListRoomsRequest(names=[room]))
            assert list(listed.rooms) == []
            await backend.delete_room(room)  # already gone: not an error
            assert await backend.list_participants(room) == set()  # a missing room is empty
        finally:
            await lk.aclose()

    asyncio.run(run())
    # The server accepts our signing: the token verifies with the server's key pair.
    claims = api.TokenVerifier(KEY, SECRET).verify(backend.mint_token(room=room, identity="user"))
    assert claims.identity == "user" and claims.video is not None and claims.video.room == room
