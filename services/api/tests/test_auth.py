import pytest
from fastapi.testclient import TestClient

from astro_api.config import Settings
from astro_api.sms import ConsoleSms

pytestmark = pytest.mark.integration
DEVICE = "device-abc-123"
PHONE = "9876543210"


def request_code(
    client: TestClient, phone: str = PHONE, device: str = DEVICE, ip: str | None = None
) -> str:
    r = client.post("/v1/auth/otp/request", json={"phone": phone, "device_id": device})
    assert r.status_code == 202, r.text
    body = r.json()
    assert set(body) == {"challenge_id", "expires_in", "resend_after"}
    return str(body["challenge_id"])


def last_code() -> str:
    return ConsoleSms.outbox[-1][1]


def sign_in(client: TestClient, phone: str = PHONE) -> str:
    cid = request_code(client, phone)
    r = client.post(
        "/v1/auth/otp/verify", json={"challenge_id": cid, "code": last_code(), "device_id": DEVICE}
    )
    assert r.status_code == 200, r.text
    return str(r.json()["token"])


def test_happy_path_creates_user_and_session(client: TestClient) -> None:
    cid = request_code(client, "+91 98765 43210")
    phone, code = ConsoleSms.outbox[-1]
    assert phone == "+919876543210" and len(code) == 6 and code.isdigit()
    r = client.post(
        "/v1/auth/otp/verify", json={"challenge_id": cid, "code": code, "device_id": DEVICE}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["is_new"] is True
    me = client.get("/v1/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json()["phone"] == "+91•••••43210"


def test_second_sign_in_is_not_new(client: TestClient) -> None:
    import redis

    sign_in(client)
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    redis.Redis.from_url(
        settings.redis_url.get_secret_value()
    ).flushdb()  # skip the resend cooldown
    cid = request_code(client)
    r = client.post(
        "/v1/auth/otp/verify", json={"challenge_id": cid, "code": last_code(), "device_id": DEVICE}
    )
    assert r.json()["user"]["is_new"] is False


def test_code_works_once(client: TestClient) -> None:
    cid = request_code(client)
    code = last_code()
    ok = client.post(
        "/v1/auth/otp/verify", json={"challenge_id": cid, "code": code, "device_id": DEVICE}
    )
    assert ok.status_code == 200
    again = client.post(
        "/v1/auth/otp/verify", json={"challenge_id": cid, "code": code, "device_id": DEVICE}
    )
    assert again.status_code == 410
    assert again.json()["detail"]["code"] == "challenge_expired"


def test_wrong_code_and_attempt_exhaustion(client: TestClient) -> None:
    cid = request_code(client)
    good = last_code()
    wrong = "000000" if good != "000000" else "111111"
    for left in (4, 3, 2, 1):
        r = client.post(
            "/v1/auth/otp/verify", json={"challenge_id": cid, "code": wrong, "device_id": DEVICE}
        )
        assert r.status_code == 401
        assert r.json()["detail"] == {
            "code": "invalid_code",
            "message": "That code is not correct.",
            "attempts_left": left,
        }
    r = client.post(
        "/v1/auth/otp/verify", json={"challenge_id": cid, "code": wrong, "device_id": DEVICE}
    )
    assert r.status_code == 401 and r.json()["detail"]["attempts_left"] == 0
    # Exhausted: even the right code no longer works.
    r = client.post(
        "/v1/auth/otp/verify", json={"challenge_id": cid, "code": good, "device_id": DEVICE}
    )
    assert r.status_code == 410


def test_expired_challenge(client: TestClient) -> None:
    import redis

    cid = request_code(client)
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    redis.Redis.from_url(settings.redis_url.get_secret_value()).delete(f"otp:{cid}")
    r = client.post(
        "/v1/auth/otp/verify", json={"challenge_id": cid, "code": last_code(), "device_id": DEVICE}
    )
    assert r.status_code == 410


def test_resend_cooldown_and_phone_rate_limit(client: TestClient) -> None:
    import redis

    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    r = redis.Redis.from_url(settings.redis_url.get_secret_value())
    request_code(client)
    too_soon = client.post("/v1/auth/otp/request", json={"phone": PHONE, "device_id": DEVICE})
    assert too_soon.status_code == 429
    assert too_soon.json()["detail"]["code"] == "rate_limited"
    assert int(too_soon.headers["retry-after"]) > 0
    # Skip the cooldown each time; the per-phone limit (3 / 15 min) still applies.
    for _ in range(2):
        for key in r.scan_iter("rl:otp-cooldown:*"):
            r.delete(key)
        request_code(client, device=f"device-{_}-xyz")
    for key in r.scan_iter("rl:otp-cooldown:*"):
        r.delete(key)
    fourth = client.post(
        "/v1/auth/otp/request", json={"phone": PHONE, "device_id": "device-other-1"}
    )
    assert fourth.status_code == 429
    assert fourth.json()["detail"]["retry_after"] > 0


def test_ip_rate_limit(client: TestClient) -> None:
    for i in range(10):
        request_code(client, phone=f"98765432{i:02d}", device=f"device-ip-{i}")
    r = client.post(
        "/v1/auth/otp/request", json={"phone": "9123456789", "device_id": "device-ip-x"}
    )
    assert r.status_code == 429


def test_no_account_enumeration(client: TestClient) -> None:
    sign_in(client, phone="9876500001")
    existing = client.post(
        "/v1/auth/otp/request", json={"phone": "9876500001", "device_id": "device-enum-1"}
    )
    fresh = client.post(
        "/v1/auth/otp/request", json={"phone": "9876500002", "device_id": "device-enum-2"}
    )
    # The existing number is in its resend cooldown here, so compare a fresh request for each.
    import redis

    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    redis.Redis.from_url(settings.redis_url.get_secret_value()).flushdb()
    existing = client.post(
        "/v1/auth/otp/request", json={"phone": "9876500001", "device_id": "device-enum-1"}
    )
    assert existing.status_code == fresh.status_code == 202
    assert set(existing.json()) == set(fresh.json())
    assert existing.json()["expires_in"] == fresh.json()["expires_in"]


def test_unsupported_phone(client: TestClient) -> None:
    r = client.post("/v1/auth/otp/request", json={"phone": "+14155550100", "device_id": DEVICE})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unsupported_phone"


def test_logout_revokes_token(client: TestClient) -> None:
    token = sign_in(client)
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/v1/me", headers=h).status_code == 200
    assert client.post("/v1/auth/logout", headers=h).status_code == 204
    assert client.get("/v1/me", headers=h).status_code == 401


def test_bad_tokens_rejected(client: TestClient) -> None:
    assert client.get("/v1/me").status_code == 401
    assert client.get("/v1/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/v1/me", headers={"Authorization": "Basic abc"}).status_code == 401


def test_token_stored_only_as_hash(client: TestClient) -> None:
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    token = sign_in(client)
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]

    async def stored() -> list[bytes]:
        engine = create_async_engine(settings.database_url.get_secret_value())
        async with engine.connect() as conn:
            rows = (
                (await conn.execute(text("SELECT token_hash FROM auth_sessions"))).scalars().all()
            )
        await engine.dispose()
        return list(rows)

    hashes = asyncio.run(stored())
    assert len(hashes) == 1 and token.encode() not in hashes[0] and len(hashes[0]) == 32


def test_parallel_guesses_cannot_exceed_the_attempt_limit(clean: Settings) -> None:
    """A burst of concurrent wrong guesses must not get more checks than the limit allows."""
    import asyncio

    from redis.asyncio import Redis

    from astro_api.errors import ApiError
    from astro_api.otp import OtpService

    async def run() -> tuple[int, int, int]:
        redis = Redis.from_url(clean.redis_url.get_secret_value())
        service = OtpService(redis, clean, ConsoleSms(clean))
        challenge = await service.request("+919876543210", DEVICE, "203.0.113.7")
        good = last_code()
        wrong = "000000" if good != "000000" else "111111"
        results = await asyncio.gather(
            *(service.verify(challenge.challenge_id, wrong) for _ in range(50)),
            return_exceptions=True,
        )
        statuses = [r.status for r in results if isinstance(r, ApiError)]
        try:
            await service.verify(challenge.challenge_id, good)
            final = 200
        except ApiError as exc:
            final = exc.status
        await redis.aclose()
        return statuses.count(401), statuses.count(410), final

    invalid, expired, final = asyncio.run(run())
    assert invalid == clean.otp_max_attempts  # exactly the allowed number of codes was checked
    assert expired == 50 - clean.otp_max_attempts
    assert final == 410  # the right code no longer works after the burst
