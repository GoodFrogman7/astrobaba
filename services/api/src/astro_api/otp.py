"""Phone OTP challenges in Redis.

A challenge stores HMAC-SHA256(SECRET_KEY, challenge_id + code), never the code. Responses are
identical whether or not an account exists for the phone (no account enumeration).
"""

import hashlib
import hmac
import secrets
from dataclasses import dataclass

from redis.asyncio import Redis

from astro_api.config import Settings
from astro_api.errors import ApiError
from astro_api.ratelimit import bucket_key, hit
from astro_api.sms import SmsSender

PHONE_LIMIT = (3, 15 * 60)  # 3 requests per 15 minutes per phone
DEVICE_LIMIT = (5, 60 * 60)  # 5 per hour per device
IP_LIMIT = (10, 60 * 60)  # 10 per hour per client IP


@dataclass(frozen=True)
class Challenge:
    challenge_id: str
    expires_in: int
    resend_after: int


def _s(value: bytes | str) -> str:
    return value.decode() if isinstance(value, bytes) else value


class OtpService:
    def __init__(self, redis: Redis, settings: Settings, sms: SmsSender) -> None:
        self.redis = redis
        self.settings = settings
        self.sms = sms
        self._secret = settings.secret_key.get_secret_value()

    def _mac(self, challenge_id: str, code: str) -> str:
        return hmac.new(
            self._secret.encode(), f"{challenge_id}:{code}".encode(), hashlib.sha256
        ).hexdigest()

    async def request(self, phone: str, device_id: str, client_ip: str) -> Challenge:
        s = self.settings
        cooldown = bucket_key(self._secret, "otp-cooldown", phone)
        if not await self.redis.set(cooldown, "1", nx=True, ex=s.otp_resend_after_s):
            retry_after = max(int(await self.redis.ttl(cooldown)), 1)
            raise ApiError(
                429,
                "rate_limited",
                "Please wait before requesting another code.",
                headers={"Retry-After": str(retry_after)},
                retry_after=retry_after,
            )
        await hit(self.redis, bucket_key(self._secret, "otp-phone", phone), *PHONE_LIMIT)
        await hit(self.redis, bucket_key(self._secret, "otp-device", device_id), *DEVICE_LIMIT)
        await hit(self.redis, bucket_key(self._secret, "otp-ip", client_ip), *IP_LIMIT)

        challenge_id = secrets.token_urlsafe(18)
        code = f"{secrets.randbelow(1_000_000):06d}"
        key = f"otp:{challenge_id}"
        await self.redis.hset(
            key,
            mapping={
                "phone": phone,
                "mac": self._mac(challenge_id, code),
                "attempts": s.otp_max_attempts,
                "device_id": device_id,
            },
        )
        await self.redis.expire(key, s.otp_ttl_s)
        await self.sms.send_otp(phone, code)
        return Challenge(challenge_id, s.otp_ttl_s, s.otp_resend_after_s)

    async def verify(self, challenge_id: str, code: str) -> str:
        """Return the verified phone number, consuming the challenge."""
        key = f"otp:{challenge_id}"
        raw: dict[bytes | str, bytes | str] = await self.redis.hgetall(key)
        data = {_s(k): _s(v) for k, v in raw.items()}
        if not data:
            raise ApiError(410, "challenge_expired", "This code has expired. Request a new one.")
        # Spend an attempt atomically BEFORE comparing, so a burst of parallel guesses cannot
        # check more codes than the attempt limit allows.
        left = int(await self.redis.hincrby(key, "attempts", -1))
        if left < 0:
            await self.redis.delete(key)
            raise ApiError(410, "challenge_expired", "Too many attempts. Request a new code.")
        if hmac.compare_digest(data["mac"], self._mac(challenge_id, code.strip())):
            # DEL returns 1 for exactly one caller, so a code can be used once.
            if await self.redis.delete(key) == 1:
                return data["phone"]
            raise ApiError(410, "challenge_expired", "This code has expired. Request a new one.")
        if left == 0:
            await self.redis.delete(key)
        raise ApiError(401, "invalid_code", "That code is not correct.", attempts_left=left)
